// SPDX-License-Identifier: GPL-3.0-or-later
// Seeded random RFC 6902 patches against a document (gate 3 of DevLog-003). Patches are valid for the current state
// (no PatchError), but the result need not validate: edits are ungated (D3), the log must still undo exactly.
import type { JsonPatchOp } from '../src/patch.ts';
import { formatPointer, applyPatch } from '../src/patch.ts';

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Key = string | number;
interface Loc { keys: Key[]; value: unknown }

const STRINGS = ['5 mm', 'a/10', 'N/A', 'dom:plate', 'x: y', 'has # hash', 'quote "q"', 'multi\nline', 'yes', 'null', '', ' lead', 'µΩ°', 'plain', '-dash', '{brace}', '[br]', '2 W/(m^2*K)'];

function walk(x: unknown, keys: Key[], out: Loc[]): void {
  out.push({ keys, value: x });
  if (Array.isArray(x)) x.forEach((e, i) => walk(e, [...keys, i], out));
  else if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) walk(v, [...keys, k], out);
}

export function randomValue(r: () => number, depth = 0): unknown {
  const u = r();
  if (u < 0.2) return Math.round((r() - 0.5) * 2000) / 10;
  if (u < 0.3) return Math.floor(r() * 100);
  if (u < 0.35) return r() < 0.5 ? 1.5e-9 : -4.1e7;
  if (u < 0.6) return STRINGS[Math.floor(r() * STRINGS.length)];
  if (u < 0.65) return r() < 0.5;
  if (u < 0.68) return null;
  if (depth > 1) return 'leaf';
  if (u < 0.84) { const o: Record<string, unknown> = {}; const n = Math.floor(r() * 3); for (let i = 0; i < n; i++) o[`k${Math.floor(r() * 50)}`] = randomValue(r, depth + 1); return o; }
  return Array.from({ length: Math.floor(r() * 3) }, () => randomValue(r, depth + 1));
}

const pick = <T>(r: () => number, xs: T[]): T => xs[Math.floor(r() * xs.length)] as T;

/** One random op valid for doc. */
export function randomOp(r: () => number, doc: unknown): JsonPatchOp {
  const locs: Loc[] = [];
  walk(doc, [], locs);
  const nonRoot = locs.filter((l) => l.keys.length > 0);
  const containers = locs.filter((l) => l.value !== null && typeof l.value === 'object');
  for (let attempt = 0; attempt < 20; attempt++) {
    const u = r();
    if (u < 0.35 && nonRoot.length) {
      const l = pick(r, nonRoot);
      return { op: 'replace', path: formatPointer(l.keys), value: randomValue(r) };
    }
    if (u < 0.6) {
      const c = pick(r, containers);
      if (Array.isArray(c.value)) {
        const i = Math.floor(r() * (c.value.length + 1));
        return { op: 'add', path: formatPointer([...c.keys]) + (r() < 0.2 ? '/-' : `/${i}`), value: randomValue(r) };
      }
      return { op: 'add', path: formatPointer([...c.keys, `n${Math.floor(r() * 1000)}`]), value: randomValue(r) };
    }
    if (u < 0.8 && nonRoot.length) {
      const l = pick(r, nonRoot);
      return { op: 'remove', path: formatPointer(l.keys) };
    }
    if (u < 0.9 && nonRoot.length) {
      const from = pick(r, nonRoot);
      const dests = containers.filter((c) => !(c.keys.length >= from.keys.length && from.keys.every((k, i) => c.keys[i] === k)));
      if (!dests.length) continue;
      const c = pick(r, dests);
      const to = Array.isArray(c.value) ? `${formatPointer(c.keys)}/${Math.floor(r() * c.value.length)}` : formatPointer([...c.keys, `m${Math.floor(r() * 1000)}`]);
      const op: JsonPatchOp = r() < 0.5 ? { op: 'move', from: formatPointer(from.keys), path: to } : { op: 'copy', from: formatPointer(from.keys), path: to };
      try { applyPatch(doc, [op]); return op; } catch { continue; }
    }
    if (nonRoot.length) {
      const l = pick(r, nonRoot);
      return { op: 'test', path: formatPointer(l.keys), value: l.value };
    }
  }
  return { op: 'add', path: '/zz_fallback', value: 1 };
}

/** A patch of 1..maxOps ops, each valid after the previous ones. */
export function randomPatch(r: () => number, doc: unknown, maxOps = 3): JsonPatchOp[] {
  const n = 1 + Math.floor(r() * maxOps);
  const out: JsonPatchOp[] = [];
  let cur = doc;
  for (let i = 0; i < n; i++) {
    const op = randomOp(r, cur);
    out.push(op);
    cur = applyPatch(cur, [op]).doc;
  }
  return out;
}
