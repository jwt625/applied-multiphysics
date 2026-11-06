"""Rate-limited, cached fetch of open sources for class-b eval cases.

Usage:
    uv run --no-project python validation/b/fetch_cached.py <case_or_source_id> <url> [<filename>]

Writes cache/eval-b/<id>/<filename> and a sidecar <filename>.json with url, accessed (ISO date and time), sha256,
bytes, HTTP status and content type. Skips the download when the file already exists (resumable). Sleeps 3-6 s
(uniform jitter) before every network request. Stops (exit 3) on HTTP 403 / 429 / 503 or a page that looks like an
anti-bot challenge, so the caller does not retry.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import random
import sys
import subprocess
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CACHE = ROOT / "cache" / "eval-b"
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) applied-multiphysics-eval/0 (research; low rate)"
CHALLENGE_MARKERS = (b"cf-challenge", b"captcha", b"Just a moment...", b"Access Denied", b"are you a robot")


def fetch(source_id: str, url: str, filename: str | None = None) -> Path:
    name = filename or url.rstrip("/").split("/")[-1].split("?")[0] or "index.html"
    out_dir = CACHE / source_id
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / name
    side = out_dir / (name + ".json")
    if out.exists() and side.exists():
        print(f"skip (cached): {out.relative_to(ROOT)}")
        return out
    time.sleep(3.0 + random.uniform(0.0, 3.0))
    # curl (system TLS stack) rather than urllib: some university hosts fail the Python TLS handshake.
    tmp = out.with_suffix(out.suffix + ".part")
    cmd = ["curl", "-sS", "-L", "--max-time", "90", "-A", UA, "-o", str(tmp),
           "-w", "%{http_code}\t%{content_type}\t%{url_effective}", url]
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0:
        print(f"curl exit {res.returncode} for {url}: {res.stderr.strip()}")
        tmp.unlink(missing_ok=True)
        sys.exit(2)
    code_s, ctype, final_url = (res.stdout.split("\t") + ["", "", ""])[:3]
    status = int(code_s or 0)
    if status in (403, 429, 503):
        print(f"HTTP {status} for {url}; stopping (possible rate limit / anti-bot)")
        tmp.unlink(missing_ok=True)
        sys.exit(3)
    if status >= 400:
        print(f"HTTP {status} for {url}")
        tmp.unlink(missing_ok=True)
        sys.exit(2)
    data = tmp.read_bytes()
    tmp.unlink()
    head = data[:20000]
    if any(m.lower() in head.lower() for m in CHALLENGE_MARKERS) and not data.startswith(b"%PDF"):
        print(f"anti-bot marker in response for {url}; stopping")
        sys.exit(3)
    out.write_bytes(data)
    meta = {
        "url": url,
        "final_url": final_url,
        "accessed": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
        "sha256": hashlib.sha256(data).hexdigest(),
        "bytes": len(data),
        "http_status": status,
        "content_type": ctype,
    }
    side.write_text(json.dumps(meta, indent=2) + "\n")
    print(f"saved {out.relative_to(ROOT)} ({len(data)} B, {ctype})")
    return out


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)
    fetch(sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else None)
