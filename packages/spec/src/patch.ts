// SPDX-License-Identifier: GPL-3.0-or-later
// RFC 6902 JSON Patch on plain spec data (C7), with RFC 6901 pointers, inverse generation and the primitive steps
// (set / insert / delete with concrete keys) that the YAML splice layer replays on the text. Patches are atomic:
// the input is never mutated and a failing op leaves nothing applied.

import { jsonEqual } from './canonical.ts';
import type { PathKey } from './registry.ts';

export type JsonPatchOp =
  | { op: 'add'; path: string; value: unknown }
  | { op: 'remove'; path: string }
  | { op: 'replace'; path: string; value: unknown }
  | { op: 'move'; from: string; path: string }
  | { op: 'copy'; from: string; path: string }
  | { op: 'test'; path: string; value: unknown };

export type PatchStep =
  | { kind: 'set'; keys: PathKey[]; value: unknown }
  | { kind: 'insert'; keys: PathKey[]; index: number; value: unknown }
  | { kind: 'delete'; keys: PathKey[] };

export class PatchError extends Error {
  index: number;
  constructor(message: string, index: number) { super(message); this.index = index; }
}

/** RFC 6901 pointer to reference tokens. */
export function parsePointer(p: string): string[] {
  if (p === '') return [];
  if (!p.startsWith('/')) throw new Error(`JSON Pointer must start with '/': ${JSON.stringify(p)}`);
  return p.slice(1).split('/').map((t) => {
    if (/~[^01]|~$/.test(t)) throw new Error(`invalid escape in JSON Pointer token ${JSON.stringify(t)}`);
    return t.replace(/~1/g, '/').replace(/~0/g, '~');
  });
}

export const formatPointer = (keys: readonly PathKey[]): string => (keys.length ? `/${keys.map((k) => String(k).replace(/~/g, '~0').replace(/\//g, '~1')).join('/')}` : '');

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const clone = <T>(x: T): T => (x === undefined ? x : structuredClone(x));
const ARRAY_INDEX = /^(0|[1-9]\d*)$/;

function containerAt(doc: unknown, tokens: string[], what: string): { keys: PathKey[]; node: unknown } {
  const keys: PathKey[] = [];
  let cur = doc;
  for (const t of tokens) {
    if (Array.isArray(cur)) {
      if (!ARRAY_INDEX.test(t) || Number(t) >= cur.length) throw new Error(`${what}: no element '${t}'`);
      keys.push(Number(t));
      cur = cur[Number(t)];
    } else if (isObj(cur) && Object.hasOwn(cur, t)) {
      keys.push(t);
      cur = cur[t];
    } else throw new Error(`${what}: no member '${t}'`);
  }
  return { keys, node: cur };
}

/** Concrete keys of an existing location. */
export function keysOf(doc: unknown, pointer: string): PathKey[] {
  return containerAt(doc, parsePointer(pointer), pointer).keys;
}

export function getAt(doc: unknown, keys: readonly PathKey[]): unknown {
  let cur = doc;
  for (const k of keys) cur = (cur as Record<string | number, unknown>)?.[k];
  return cur;
}

const forbidden = (t: string) => t === '__proto__';

interface State { root: unknown }

function opAdd(s: State, pointer: string, value: unknown, steps: PatchStep[]): PathKey[] {
  const tokens = parsePointer(pointer);
  if (!tokens.length) { s.root = clone(value); steps.push({ kind: 'set', keys: [], value: clone(value) }); return []; }
  const last = tokens.at(-1) as string;
  if (forbidden(last)) throw new Error(`key '${last}' is not allowed`);
  const { keys, node } = containerAt(s.root, tokens.slice(0, -1), pointer);
  if (Array.isArray(node)) {
    const idx = last === '-' ? node.length : ARRAY_INDEX.test(last) ? Number(last) : NaN;
    if (!(idx >= 0 && idx <= node.length)) throw new Error(`add ${pointer}: index '${last}' out of range 0..${node.length}`);
    node.splice(idx, 0, clone(value));
    steps.push({ kind: 'insert', keys, index: idx, value: clone(value) });
    return [...keys, idx];
  }
  if (!isObj(node)) throw new Error(`add ${pointer}: parent is not a container`);
  node[last] = clone(value);
  steps.push({ kind: 'set', keys: [...keys, last], value: clone(value) });
  return [...keys, last];
}

function opRemove(s: State, pointer: string, steps: PatchStep[]): unknown {
  const tokens = parsePointer(pointer);
  if (!tokens.length) throw new Error('remove of the document root is not allowed');
  const { keys } = containerAt(s.root, tokens, pointer);
  const parent = getAt(s.root, keys.slice(0, -1));
  const k = keys.at(-1) as PathKey;
  let old: unknown;
  if (Array.isArray(parent)) old = parent.splice(k as number, 1)[0];
  else { old = (parent as Record<string, unknown>)[k as string]; delete (parent as Record<string, unknown>)[k as string]; }
  steps.push({ kind: 'delete', keys });
  return old;
}

function opReplace(s: State, pointer: string, value: unknown, steps: PatchStep[]): void {
  const tokens = parsePointer(pointer);
  if (!tokens.length) { s.root = clone(value); steps.push({ kind: 'set', keys: [], value: clone(value) }); return; }
  const { keys } = containerAt(s.root, tokens, pointer);
  const parent = getAt(s.root, keys.slice(0, -1)) as Record<string | number, unknown>;
  parent[keys.at(-1) as PathKey] = clone(value);
  steps.push({ kind: 'set', keys, value: clone(value) });
}

function applyOne(s: State, op: JsonPatchOp, steps: PatchStep[]): void {
  switch (op.op) {
    case 'add': opAdd(s, op.path, op.value, steps); return;
    case 'remove': opRemove(s, op.path, steps); return;
    case 'replace': opReplace(s, op.path, op.value, steps); return;
    case 'move': {
      if (op.path === op.from) { containerAt(s.root, parsePointer(op.from), op.from); return; }
      if (op.path.startsWith(`${op.from}/`)) throw new Error(`move: ${op.path} is inside ${op.from}`);
      const v = opRemove(s, op.from, steps);
      opAdd(s, op.path, v, steps);
      return;
    }
    case 'copy': {
      const v = containerAt(s.root, parsePointer(op.from), op.from).node;
      opAdd(s, op.path, v, steps);
      return;
    }
    case 'test': {
      const v = containerAt(s.root, parsePointer(op.path), op.path).node;
      if (!jsonEqual(v, op.value)) throw new Error(`test ${op.path} failed`);
      return;
    }
    default: throw new Error(`unknown op ${JSON.stringify((op as { op?: unknown }).op)}`);
  }
}

/** Apply a patch to a copy of doc. Returns the new document and the primitive steps. Throws PatchError. */
export function applyPatch(doc: unknown, patch: readonly JsonPatchOp[]): { doc: unknown; steps: PatchStep[] } {
  const s: State = { root: clone(doc) };
  const steps: PatchStep[] = [];
  patch.forEach((op, i) => {
    try { applyOne(s, op, steps); } catch (e) { throw new PatchError(`op ${i} (${op.op} ${op.path}): ${(e as Error).message}`, i); }
  });
  return { doc: s.root, steps };
}

/**
 * Inverse of a patch relative to the document it applies to. Each op's inverse starts with a `test` guard on the
 * value the op wrote, so applying the inverse to a document that changed there since fails instead of clobbering.
 */
export function invertPatch(doc: unknown, patch: readonly JsonPatchOp[]): JsonPatchOp[] {
  const s: State = { root: clone(doc) };
  const groups: JsonPatchOp[][] = [];
  patch.forEach((op, i) => {
    try { groups.push(invertOne(s, op)); } catch (e) { throw new PatchError(`op ${i} (${op.op} ${op.path}): ${(e as Error).message}`, i); }
  });
  return groups.reverse().flat();
}

function existing(root: unknown, pointer: string): { found: boolean; value?: unknown } {
  try { return { found: true, value: clone(containerAt(root, parsePointer(pointer), pointer).node) }; } catch { return { found: false }; }
}

function invertOne(s: State, op: JsonPatchOp): JsonPatchOp[] {
  const sink: PatchStep[] = [];
  switch (op.op) {
    case 'test': applyOne(s, op, sink); return [];
    case 'replace': {
      const old = existing(s.root, op.path);
      applyOne(s, op, sink);
      return [{ op: 'test', path: op.path, value: clone(op.value) }, { op: 'replace', path: op.path, value: old.value }];
    }
    case 'remove': {
      const old = existing(s.root, op.path);
      applyOne(s, op, sink);
      return [{ op: 'add', path: op.path, value: old.value }];
    }
    case 'add':
    case 'copy': {
      const value = op.op === 'add' ? op.value : existing(s.root, op.from).value;
      const prior = isArrayTarget(s.root, op.path) ? { found: false } : existing(s.root, op.path);
      const s2: PatchStep[] = [];
      applyOne(s, op, s2);
      const at = concrete(s2.at(-1) as PatchStep);
      const guard: JsonPatchOp = { op: 'test', path: at, value: clone(value) };
      return prior.found ? [guard, { op: 'replace', path: at, value: prior.value }] : [guard, { op: 'remove', path: at }];
    }
    case 'move': {
      if (op.path === op.from) { applyOne(s, op, sink); return []; }
      const value = existing(s.root, op.from).value;
      const s2: PatchStep[] = [];
      // the destination is read after the source is removed (RFC 6902 4.4 = remove then add)
      const probe: State = { root: clone(s.root) };
      opRemove(probe, op.from, []);
      const prior = isArrayTarget(probe.root, op.path) ? { found: false } : existing(probe.root, op.path);
      applyOne(s, op, s2);
      const at = concrete(s2.at(-1) as PatchStep);
      // remove + add rather than move: after the forward op, op.from may lie under `at` as a string (an array element
      // shifted by the insertion), which RFC 6902 forbids for move although remove-then-add is well defined.
      const back: JsonPatchOp[] = [{ op: 'test', path: at, value: clone(value) }, { op: 'remove', path: at }, { op: 'add', path: op.from, value: clone(value) }];
      if (prior.found) back.push({ op: 'add', path: at, value: prior.value });
      return back;
    }
  }
}

function isArrayTarget(root: unknown, pointer: string): boolean {
  const t = parsePointer(pointer);
  if (!t.length) return false;
  try { return Array.isArray(containerAt(root, t.slice(0, -1), pointer).node); } catch { return false; }
}

const concrete = (st: PatchStep): string => formatPointer(st.kind === 'insert' ? [...st.keys, st.index] : st.keys);
