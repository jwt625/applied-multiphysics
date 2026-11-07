// SPDX-License-Identifier: GPL-3.0-or-later
// RFC 6902 JSON Patch on plain spec data (C7), with RFC 6901 pointers, inverse generation and the primitive steps
// (set / insert / delete with concrete keys) that the YAML splice layer replays on the text. Patches are atomic:
// the input is never mutated and a failing op leaves nothing applied.
//
// amp extensions (operation log v1, audit S1):
//   - Array tokens `@<id>` address the element whose `id` is <id> (unique in that array). As the last token of `add`,
//     `@<id>` inserts before that element and `@<id>+` after it. Keys starting with `@` never occur in amp-spec/0.
//   - `{op: 'absent', path}` succeeds only when path does not resolve (guard for re-adding removed members).
//   - `add` refuses an array element whose `id` already exists in that array.
// Inverses are written with id anchors where the element has a unique id, and every inverse starts with a guard on
// the state the op left (`test` the written value, or `absent` for a removed member), so a stale revert fails loudly
// instead of clobbering or duplicating data.

import * as z from 'zod';
import { jsonEqual } from './canonical.ts';
import { FORBIDDEN_KEYS, findForbiddenKey } from './ids.ts';
import type { PathKey } from './registry.ts';

export type JsonPatchOp =
  | { op: 'add'; path: string; value: unknown }
  | { op: 'remove'; path: string }
  | { op: 'replace'; path: string; value: unknown }
  | { op: 'move'; from: string; path: string }
  | { op: 'copy'; from: string; path: string }
  | { op: 'test'; path: string; value: unknown }
  | { op: 'absent'; path: string };

export type PatchStep =
  | { kind: 'set'; keys: PathKey[]; value: unknown }
  | { kind: 'insert'; keys: PathKey[]; index: number; value: unknown }
  | { kind: 'delete'; keys: PathKey[] };

export class PatchError extends Error {
  index: number;
  constructor(message: string, index: number) { super(message); this.index = index; }
}

// ---- shape (audit M5) --------------------------------------------------------------------------------------------
const pointer = z.string().max(4096).refine((p) => p === '' || p.startsWith('/'), { message: "a JSON Pointer is '' or starts with '/'" });
const json = z.json();
/** zod schema of a patch (tool input for agents; also checked before every apply). */
export const JsonPatchSchema = z.array(z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('add'), path: pointer, value: json }),
  z.strictObject({ op: z.literal('remove'), path: pointer }),
  z.strictObject({ op: z.literal('replace'), path: pointer, value: json }),
  z.strictObject({ op: z.literal('move'), from: pointer, path: pointer }),
  z.strictObject({ op: z.literal('copy'), from: pointer, path: pointer }),
  z.strictObject({ op: z.literal('test'), path: pointer, value: json }),
  z.strictObject({ op: z.literal('absent'), path: pointer }),
], { error: (iss: { code?: string; note?: string }) => (iss.code === 'invalid_union' && iss.note === 'No matching discriminator' ? 'op must be add, remove, replace, move, copy, test or absent' : undefined) } as never)).max(10000);

/** Throws PatchError with a readable message when the patch is not a well-formed patch. */
export function checkPatchShape(patch: unknown): asserts patch is JsonPatchOp[] {
  if (!Array.isArray(patch)) throw new PatchError('malformed patch: a patch is an array of operations', -1);
  patch.forEach((o, i) => {
    if (o && typeof o === 'object' && ['add', 'replace', 'test'].includes((o as { op?: string }).op ?? '') && !('value' in o)) throw new PatchError(`malformed patch: op ${i}: missing required key 'value'`, i);
    if (o && typeof o === 'object' && ['move', 'copy'].includes((o as { op?: string }).op ?? '') && !('from' in o)) throw new PatchError(`malformed patch: op ${i}: missing required key 'from'`, i);
  });
  const r = JsonPatchSchema.safeParse(patch, {
    error: ((iss: { code?: string; input?: unknown; path?: PropertyKey[] }) => (iss.code === 'invalid_type' && iss.input === undefined ? `missing required key '${String(iss.path?.at(-1) ?? '')}'` : undefined)) as never,
  });
  if (r.success) return;
  const i = r.error.issues[0]!;
  const at = i.path.length ? `op ${String(i.path[0])}${i.path.length > 1 ? ` ${i.path.slice(1).join('.')}` : ''}: ` : '';
  throw new PatchError(`malformed patch: ${at}${i.message}`, typeof i.path[0] === 'number' ? i.path[0] : -1);
}

// ---- pointers ----------------------------------------------------------------------------------------------------
/** RFC 6901 pointer to reference tokens. */
export function parsePointer(p: string): string[] {
  if (typeof p !== 'string') throw new Error('a JSON Pointer must be a string');
  if (p === '') return [];
  if (!p.startsWith('/')) throw new Error(`JSON Pointer must start with '/': ${JSON.stringify(p)}`);
  return p.slice(1).split('/').map((t) => {
    if (/~[^01]|~$/.test(t)) throw new Error(`invalid escape in JSON Pointer token ${JSON.stringify(t)}`);
    const k = t.replace(/~1/g, '/').replace(/~0/g, '~');
    if (FORBIDDEN_KEYS.has(k)) throw new Error(`key '${k}' is not allowed in a pointer`);
    return k;
  });
}

const escTok = (k: PathKey) => String(k).replace(/~/g, '~0').replace(/\//g, '~1');
export const formatPointer = (keys: readonly PathKey[]): string => (keys.length ? `/${keys.map(escTok).join('/')}` : '');

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const clone = <T>(x: T): T => (x === undefined ? x : structuredClone(x));
const ARRAY_INDEX = /^(0|[1-9]\d*)$/;
const idOf = (e: unknown): string | null => (isObj(e) && typeof e.id === 'string' ? e.id : null);

/** Index of the element with this id, or -1 (also -1 when the id is not unique). */
function indexById(arr: unknown[], id: string): number {
  let at = -1;
  for (let i = 0; i < arr.length; i++) if (idOf(arr[i]) === id) { if (at >= 0) return -1; at = i; }
  return at;
}

function arrayIndex(arr: unknown[], t: string, what: string): number {
  if (t.startsWith('@')) {
    const i = indexById(arr, t.slice(1));
    if (i < 0) throw new Error(`${what}: no element with id '${t.slice(1)}'`);
    return i;
  }
  if (!ARRAY_INDEX.test(t) || Number(t) >= arr.length) throw new Error(`${what}: no element '${t}'`);
  return Number(t);
}

function containerAt(doc: unknown, tokens: string[], what: string): { keys: PathKey[]; node: unknown } {
  const keys: PathKey[] = [];
  let cur = doc;
  for (const t of tokens) {
    if (Array.isArray(cur)) {
      const i = arrayIndex(cur, t, what);
      keys.push(i);
      cur = cur[i];
    } else if (isObj(cur) && Object.hasOwn(cur, t)) {
      keys.push(t);
      cur = cur[t];
    } else throw new Error(`${what}: no member '${t}'`);
  }
  return { keys, node: cur };
}

/** Concrete keys of an existing location (accepts `@id` tokens). */
export function keysOf(doc: unknown, ptr: string): PathKey[] {
  return containerAt(doc, parsePointer(ptr), ptr).keys;
}

export function getAt(doc: unknown, keys: readonly PathKey[]): unknown {
  let cur = doc;
  for (const k of keys) cur = (cur as Record<string | number, unknown>)?.[k];
  return cur;
}

/** Pointer for concrete keys with `@id` tokens wherever the array element has a unique id. */
export function anchoredPointer(root: unknown, keys: readonly PathKey[]): string {
  const toks: string[] = [];
  let cur = root;
  for (const k of keys) {
    if (Array.isArray(cur) && typeof k === 'number') {
      const id = idOf(cur[k]);
      toks.push(id !== null && indexById(cur, id) === k ? `@${id}` : String(k));
      cur = cur[k];
    } else {
      toks.push(String(k));
      cur = isObj(cur) ? cur[String(k)] : undefined;
    }
  }
  return toks.length ? `/${toks.map(escTok).join('/')}` : '';
}

/** Pointer for inserting at `index` of the array at parentKeys: `@<prev id>+` when the previous element has an id. */
export function anchoredInsert(root: unknown, parentKeys: readonly PathKey[], index: number): string {
  const parent = anchoredPointer(root, parentKeys);
  const arr = getAt(root, parentKeys) as unknown[];
  if (index > 0) {
    const id = idOf(arr[index - 1]);
    if (id !== null && indexById(arr, id) === index - 1) return `${parent}/${escTok(`@${id}+`)}`;
  }
  return `${parent}/${index}`;
}

// ---- application ------------------------------------------------------------------------------------------------
interface State { root: unknown }

function opAdd(s: State, ptr: string, value: unknown, steps: PatchStep[]): PathKey[] {
  const tokens = parsePointer(ptr);
  if (!tokens.length) { s.root = clone(value); steps.push({ kind: 'set', keys: [], value: clone(value) }); return []; }
  const last = tokens.at(-1) as string;
  const { keys, node } = containerAt(s.root, tokens.slice(0, -1), ptr);
  if (Array.isArray(node)) {
    let idx: number;
    if (last === '-') idx = node.length;
    else if (last.startsWith('@')) {
      const after = last.endsWith('+');
      const i = indexById(node, after ? last.slice(1, -1) : last.slice(1));
      if (i < 0) throw new Error(`add ${ptr}: no element with id '${after ? last.slice(1, -1) : last.slice(1)}'`);
      idx = after ? i + 1 : i;
    } else idx = ARRAY_INDEX.test(last) ? Number(last) : NaN;
    if (!(idx >= 0 && idx <= node.length)) throw new Error(`add ${ptr}: index '${last}' out of range 0..${node.length}`);
    const id = idOf(value);
    if (id !== null && node.some((e) => idOf(e) === id)) throw new Error(`add ${ptr}: the array already has an element with id '${id}'`);
    node.splice(idx, 0, clone(value));
    steps.push({ kind: 'insert', keys, index: idx, value: clone(value) });
    return [...keys, idx];
  }
  if (!isObj(node)) throw new Error(`add ${ptr}: parent is not a container`);
  node[last] = clone(value);
  steps.push({ kind: 'set', keys: [...keys, last], value: clone(value) });
  return [...keys, last];
}

function opRemove(s: State, ptr: string, steps: PatchStep[]): unknown {
  const tokens = parsePointer(ptr);
  if (!tokens.length) throw new Error('remove of the document root is not allowed');
  const { keys } = containerAt(s.root, tokens, ptr);
  const parent = getAt(s.root, keys.slice(0, -1));
  const k = keys.at(-1) as PathKey;
  let old: unknown;
  if (Array.isArray(parent)) old = parent.splice(k as number, 1)[0];
  else { old = (parent as Record<string, unknown>)[k as string]; delete (parent as Record<string, unknown>)[k as string]; }
  steps.push({ kind: 'delete', keys });
  return old;
}

function opReplace(s: State, ptr: string, value: unknown, steps: PatchStep[]): void {
  const tokens = parsePointer(ptr);
  if (!tokens.length) { s.root = clone(value); steps.push({ kind: 'set', keys: [], value: clone(value) }); return; }
  const { keys } = containerAt(s.root, tokens, ptr);
  const parent = getAt(s.root, keys.slice(0, -1)) as Record<string | number, unknown>;
  parent[keys.at(-1) as PathKey] = clone(value);
  steps.push({ kind: 'set', keys, value: clone(value) });
}

function resolves(root: unknown, ptr: string): boolean {
  try { containerAt(root, parsePointer(ptr), ptr); return true; } catch { return false; }
}

function applyOne(s: State, op: JsonPatchOp, steps: PatchStep[]): void {
  if ('value' in op) {
    const bad = findForbiddenKey(op.value);
    if (bad) throw new Error(`value contains the key '${bad.at(-1)}' at ${formatPointer(bad)}, which is not allowed`);
  }
  switch (op.op) {
    case 'add': opAdd(s, op.path, op.value, steps); return;
    case 'remove': opRemove(s, op.path, steps); return;
    case 'replace': opReplace(s, op.path, op.value, steps); return;
    case 'move': {
      const from = formatPointer(keysOf(s.root, op.from));
      if (op.path === op.from || op.path === from) return;
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
    case 'absent': {
      parsePointer(op.path);
      if (resolves(s.root, op.path)) throw new Error(`absent ${op.path} failed: it exists`);
      return;
    }
    default: throw new Error(`unknown op ${JSON.stringify((op as { op?: unknown }).op)}`);
  }
}

/** Apply a patch to a copy of doc. Returns the new document and the primitive steps. Throws PatchError. */
export function applyPatch(doc: unknown, patch: readonly JsonPatchOp[]): { doc: unknown; steps: PatchStep[] } {
  checkPatchShape(patch);
  const s: State = { root: clone(doc) };
  const steps: PatchStep[] = [];
  patch.forEach((op, i) => {
    try { applyOne(s, op, steps); } catch (e) { throw new PatchError(`op ${i} (${op.op} ${op.path}): ${(e as Error).message}`, i); }
  });
  return { doc: s.root, steps };
}

// ---- inverses ----------------------------------------------------------------------------------------------------
/**
 * Inverse of a patch relative to the document it applies to, with id anchors and guards (see header). Applying it to
 * the document the patch produced restores the original; applying it after conflicting edits fails.
 */
export function invertPatch(doc: unknown, patch: readonly JsonPatchOp[]): JsonPatchOp[] {
  checkPatchShape(patch);
  const s: State = { root: clone(doc) };
  const groups: JsonPatchOp[][] = [];
  patch.forEach((op, i) => {
    try { groups.push(invertOne(s, op)); } catch (e) { throw new PatchError(`op ${i} (${op.op} ${op.path}): ${(e as Error).message}`, i); }
  });
  return groups.reverse().flat();
}

function existing(root: unknown, ptr: string): { found: boolean; value?: unknown } {
  try { return { found: true, value: clone(containerAt(root, parsePointer(ptr), ptr).node) }; } catch { return { found: false }; }
}

function isArrayTarget(root: unknown, ptr: string): boolean {
  const t = parsePointer(ptr);
  if (!t.length) return false;
  try { return Array.isArray(containerAt(root, t.slice(0, -1), ptr).node); } catch { return false; }
}

const writtenKeys = (st: PatchStep): PathKey[] => (st.kind === 'insert' ? [...st.keys, st.index] : st.keys);

/** Pointer that re-inserts a value removed from `keys` (concrete in the pre-removal state), anchored in `root`. */
function reinsertPointer(root: unknown, keys: readonly PathKey[], parentIsArray: boolean): string {
  const parentKeys = keys.slice(0, -1);
  const last = keys.at(-1) as PathKey;
  if (parentIsArray) return anchoredInsert(root, parentKeys, last as number);
  const parent = anchoredPointer(root, parentKeys);
  return `${parent}/${escTok(last)}`;
}

function removalGuard(root: unknown, keys: readonly PathKey[], parentIsArray: boolean, value: unknown): JsonPatchOp[] {
  if (!parentIsArray) return [{ op: 'absent', path: reinsertPointer(root, keys, false) }];
  const id = idOf(value);
  return id !== null ? [{ op: 'absent', path: `${anchoredPointer(root, keys.slice(0, -1))}/${escTok(`@${id}`)}` }] : [];
}

function invertOne(s: State, op: JsonPatchOp): JsonPatchOp[] {
  const sink: PatchStep[] = [];
  switch (op.op) {
    case 'test':
    case 'absent': applyOne(s, op, sink); return [];
    case 'replace': {
      const old = existing(s.root, op.path);
      const st: PatchStep[] = [];
      applyOne(s, op, st);
      const at = anchoredPointer(s.root, writtenKeys(st[0] as PatchStep));
      return [{ op: 'test', path: at, value: clone(op.value) }, { op: 'replace', path: at, value: old.value }];
    }
    case 'remove': {
      const old = existing(s.root, op.path);
      const inArray = isArrayTarget(s.root, op.path);
      const st: PatchStep[] = [];
      applyOne(s, op, st);
      const keys = (st[0] as PatchStep).keys;
      return [...removalGuard(s.root, keys, inArray, old.value), { op: 'add', path: reinsertPointer(s.root, keys, inArray), value: old.value }];
    }
    case 'add':
    case 'copy': {
      const value = op.op === 'add' ? op.value : existing(s.root, op.from).value;
      const prior = isArrayTarget(s.root, op.path) ? { found: false } : existing(s.root, op.path);
      const st: PatchStep[] = [];
      applyOne(s, op, st);
      const at = anchoredPointer(s.root, writtenKeys(st.at(-1) as PatchStep));
      const guard: JsonPatchOp = { op: 'test', path: at, value: clone(value) };
      return prior.found ? [guard, { op: 'replace', path: at, value: prior.value }] : [guard, { op: 'remove', path: at }];
    }
    case 'move': {
      const fromKeys = keysOf(s.root, op.from);
      if (op.path === op.from || op.path === formatPointer(fromKeys)) { applyOne(s, op, sink); return []; }
      const value = existing(s.root, op.from).value;
      const fromInArray = isArrayTarget(s.root, op.from);
      // RFC 6902 4.4: move = remove(from) then add(path); S1 is the state between the two
      const s1: State = { root: clone(s.root) };
      opRemove(s1, op.from, []);
      const prior = isArrayTarget(s1.root, op.path) ? { found: false } : existing(s1.root, op.path);
      const st: PatchStep[] = [];
      applyOne(s, op, st);
      const at = anchoredPointer(s.root, writtenKeys(st.at(-1) as PatchStep));
      // inverse: remove the moved value (back to S1), restore an overwritten member, re-insert at the source
      const back: JsonPatchOp[] = [{ op: 'test', path: at, value: clone(value) }, { op: 'remove', path: at }];
      if (prior.found) {
        const toKeys = keysOf(s1.root, op.path);
        back.push({ op: 'add', path: anchoredPointer(s1.root, toKeys), value: prior.value });
      }
      back.push({ op: 'add', path: reinsertPointer(s1.root, fromKeys, fromInArray), value: clone(value) });
      return back;
    }
  }
}
