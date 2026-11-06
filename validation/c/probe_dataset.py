# SPDX-License-Identifier: GPL-3.0-or-later
"""Probe a remote HDF5 dataset file with HTTP range reads (lane L7c, DevLog-008).

Reads the HDF5 structure (groups, datasets, shapes, dtypes, chunking, small attributes) and
frame 0 of sample 0 for every large dataset, without downloading the file. Writes into
cache/eval-c/<name>/ (gitignored):
  structure.json   HDF5 tree with shapes/dtypes/attrs
  frame0.npz       first frame of the first sample of each large dataset
  sidecar.json     url, ISO date, bytes transferred, request count, sha256 of the two outputs,
                   upstream size and checksum as reported by the hosting API

Byte budget: aborts above --max-mb (default 50) transferred bytes. Range requests are spaced
by --gap-s seconds (default 0.5) plus jitter.

Run (uv only, no project):
  uv run --no-project --with h5py --with numpy --with requests python -I validation/c/probe_dataset.py \
      --name gray_scott --url <resolve url> --upstream-size N --upstream-checksum sha256:...
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import io
import json
import random
import sys
import time
from pathlib import Path

import h5py
import numpy as np
import requests

UA = "amp-eval-lane-L7c/0 (metadata probe; rate-limited range reads)"


class RangeFile(io.RawIOBase):
    """Read-only, seekable file over HTTP range requests with a block cache."""

    def __init__(self, url: str, size: int, block: int, max_bytes: int, gap_s: float) -> None:
        self.url, self.size, self.block = url, size, block
        self.max_bytes, self.gap_s = max_bytes, gap_s
        self.pos = 0
        self.cache: dict[int, bytes] = {}
        self.bytes_transferred = 0
        self.n_requests = 0
        self.s = requests.Session()
        self.s.headers["User-Agent"] = UA

    def readable(self) -> bool:
        return True

    def seekable(self) -> bool:
        return True

    def tell(self) -> int:
        return self.pos

    def seek(self, off: int, whence: int = 0) -> int:
        self.pos = off if whence == 0 else (self.pos + off if whence == 1 else self.size + off)
        return self.pos

    def _block(self, i: int) -> bytes:
        if i not in self.cache:
            lo = i * self.block
            hi = min(self.size, lo + self.block) - 1
            if self.bytes_transferred + (hi - lo + 1) > self.max_bytes:
                raise RuntimeError(f"byte budget exceeded ({self.bytes_transferred} B so far)")
            time.sleep(self.gap_s + random.uniform(0, self.gap_s))
            r = self.s.get(self.url, headers={"Range": f"bytes={lo}-{hi}"}, timeout=120)
            if r.status_code != 206:
                raise RuntimeError(f"range request failed: HTTP {r.status_code}")
            self.cache[i] = r.content
            self.bytes_transferred += len(r.content)
            self.n_requests += 1
        return self.cache[i]

    def readinto(self, b) -> int:  # type: ignore[override]
        n = min(len(b), self.size - self.pos)
        if n <= 0:
            return 0
        out = bytearray()
        p = self.pos
        while len(out) < n:
            i = p // self.block
            blk = self._block(i)
            off = p - i * self.block
            take = blk[off : off + (n - len(out))]
            out += take
            p += len(take)
        b[:n] = out
        self.pos += n
        return n


def small_attr(v):
    a = np.asarray(v)
    if a.size > 64:
        return {"shape": list(a.shape), "dtype": str(a.dtype), "note": "large attribute, not stored"}
    if a.dtype.kind in "SO":
        return [x.decode() if isinstance(x, bytes) else str(x) for x in a.ravel().tolist()]
    return a.tolist()


def walk(f: h5py.File, frame_elems: int, max_frames: int = 6, max_groups: int = 3):
    """Structure + frame 0. Files with many top-level sample groups (PDEBench 2D diff-react,
    NS_incom: one group per sample) are summarised: only the first max_groups groups are walked."""
    tree: dict = {}
    frames: dict[str, np.ndarray] = {}
    top = list(f.keys())
    if len(top) > 20 and isinstance(f[top[0]], h5py.Group):
        groups = top  # one group per sample; do not open every object header
    else:
        groups = [k for k in top if isinstance(f[k], h5py.Group)]
    skip = set(groups[max_groups:]) if len(groups) > 20 else set()
    if skip:
        tree["_summary"] = {
            "n_top_level_groups": len(groups),
            "walked": groups[:max_groups],
            "first_group": groups[0],
            "last_group": groups[-1],
        }

    def visit(name, obj):
        if name.split("/")[0] in skip:
            return
        entry = {"attrs": {k: small_attr(v) for k, v in obj.attrs.items()}}
        if isinstance(obj, h5py.Dataset):
            entry.update(shape=list(obj.shape), dtype=str(obj.dtype), chunks=obj.chunks, compression=obj.compression)
            if obj.size <= 4096:
                v = np.asarray(obj[()])
                entry["values"] = small_attr(v)
                if v.size > 64 and v.dtype.kind in "fiu":
                    flat = v.ravel()
                    entry["summary"] = {
                        "n": int(flat.size),
                        "first": flat[:3].tolist(),
                        "last": flat[-1].item(),
                        "min": flat.min().item(),
                        "max": flat.max().item(),
                    }
            elif obj.ndim >= 1 and len(frames) < max_frames:
                idx: list = []
                rem = obj.size
                for d in obj.shape:
                    if rem <= frame_elems:
                        break
                    idx.append(0)
                    rem //= d
                frames[name] = np.asarray(obj[tuple(idx)])
                entry["frame0_index"] = idx
        tree[name] = entry

    tree["/"] = {"attrs": {k: small_attr(v) for k, v in f.attrs.items()}}
    for k in top:
        if k in skip:
            continue
        visit(k, f[k])
        if isinstance(f[k], h5py.Group):
            f[k].visititems(lambda n, o, k=k: visit(f"{k}/{n}", o))
    return tree, frames


def sha256(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", required=True)
    ap.add_argument("--url", required=True)
    ap.add_argument("--upstream-size", type=int, default=None)
    ap.add_argument("--upstream-checksum", default=None)
    ap.add_argument("--out-root", default="cache/eval-c")
    ap.add_argument("--max-mb", type=float, default=50.0)
    ap.add_argument("--block-kb", type=int, default=1024)
    ap.add_argument("--gap-s", type=float, default=0.5)
    ap.add_argument("--frame-elems", type=int, default=300_000)
    a = ap.parse_args()

    s = requests.Session()
    s.headers["User-Agent"] = UA
    h = s.head(a.url, allow_redirects=True, timeout=60)
    final = h.url
    size = int(h.headers.get("content-length", a.upstream_size or 0))
    if a.upstream_size and size != a.upstream_size:
        print(f"warning: content-length {size} != upstream size {a.upstream_size}", file=sys.stderr)
    rf = RangeFile(final, size, a.block_kb * 1024, int(a.max_mb * 1e6), a.gap_s)
    t0 = time.time()
    out = Path(a.out_root) / a.name
    out.mkdir(parents=True, exist_ok=True)
    try:
        with h5py.File(io.BufferedReader(rf, buffer_size=a.block_kb * 1024), "r") as f:
            tree, frames = walk(f, a.frame_elems)
    except RuntimeError as e:  # budget exceeded: keep a record of what was spent
        (out / "failed.json").write_text(
            json.dumps(
                {
                    "url": a.url,
                    "error": str(e),
                    "bytes_transferred": rf.bytes_transferred,
                    "n_range_requests": rf.n_requests,
                    "date": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
                },
                indent=1,
            )
        )
        raise
    (out / "structure.json").write_text(json.dumps(tree, indent=1, default=str))
    np.savez_compressed(out / "frame0.npz", **{k.replace("/", "__"): v for k, v in frames.items()})
    side = {
        "name": a.name,
        "url": a.url,
        "resolved_host": final.split("/")[2],
        "date": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
        "method": "HTTP range reads (HDF5 metadata + frame 0 of sample 0); whole file not downloaded",
        "file_size_bytes": size,
        "upstream_checksum": a.upstream_checksum,
        "bytes_transferred": rf.bytes_transferred,
        "n_range_requests": rf.n_requests,
        "wall_s": round(time.time() - t0, 1),
        "outputs": {p: sha256(out / p) for p in ("structure.json", "frame0.npz")},
        "versions": {"h5py": h5py.__version__, "numpy": np.__version__, "requests": requests.__version__},
    }
    (out / "sidecar.json").write_text(json.dumps(side, indent=1))
    print(
        json.dumps({k: side[k] for k in ("name", "file_size_bytes", "bytes_transferred", "n_range_requests", "wall_s")})
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
