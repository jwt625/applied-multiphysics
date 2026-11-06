// SPDX-License-Identifier: GPL-3.0-or-later
// Operation log (C7, DevLog-001 A4, DevLog-003 s.1.4). Every edit, from the UI or an agent, is an operation:
// RFC 6902 patch + guarded inverse, actor, reason, validation result, invalidated artifacts, spec hashes before and
// after, the exact text delta of the YAML splice, and a sha-256 hash chain. The log is append-only:
//   undo   = append the inverse of the newest undoable op, restoring the text byte for byte (inverse text delta);
//   redo   = append the undone op again (its forward text delta);
//   revert = append the inverse of any earlier op, applied by splice; its `test` guards fail on conflicting edits.
// Serialization: JSONL, a genesis line (initial text and hashes) then one canonical-JSON op per line.

import { parseStrict, setIn, insertIn, deleteIn } from './yaml-edit.mjs';
import { applyPatch, invertPatch, type JsonPatchOp, type PatchStep } from './patch.ts';
import { canonicalJson, sha256Hex, specHash, jsonEqual } from './canonical.ts';
import { invalidationsFor, type Artifact } from './invalidation.ts';
import { validateSpec } from './validate.ts';
import { isValidActor, isAgentActor, type Actor } from './ids.ts';
import { isoNow } from './run-record.ts';
import type { Registry } from './registry.ts';

export const OPLOG_SCHEMA = 'amp-oplog/0';

export interface TextDelta { at: number; del: string; ins: string }

export type OpKind = 'edit' | 'undo' | 'redo' | 'revert';

export interface Operation {
  seq: number;
  ts: string;
  actor: Actor;
  reason?: string;
  kind: OpKind;
  /** undo/redo/revert: seq of the op acted on. */
  target?: number;
  patch: JsonPatchOp[];
  inverse: JsonPatchOp[];
  before: string;
  after: string;
  validation: { ok: boolean; errors: string[] };
  invalidates: Artifact[];
  text: TextDelta;
  /** sha-256 of the YAML text after the op. */
  textHash: string;
  prev: string;
  hash: string;
}

export interface Genesis {
  schema: typeof OPLOG_SCHEMA;
  kind: 'genesis';
  ts: string;
  specHash: string;
  textHash: string;
  text?: string;
  hash: string;
}

export interface OpMeta { actor: Actor; reason?: string; ts?: string }

export interface OpLogOptions {
  /** Validation after every op (C7 `validation`); without it ops record {ok: true, errors: []} and `validated: false`. */
  registry?: Registry;
  validate?: (data: unknown) => { ok: boolean; errors: string[] };
  /** Refuse (throw, append nothing) when the result does not validate. Default false: edits are ungated (D3). */
  requireValid?: boolean;
  clock?: () => string;
  /** Store the initial text in the genesis line (default true) so a JSONL log replays on its own. */
  embedText?: boolean;
}

export interface OpLog {
  readonly text: string;
  readonly data: unknown;
  readonly ops: readonly Operation[];
  readonly genesis: Genesis;
  readonly head: string;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  /** Seq of the op the next undo reverses / the next redo re-applies. */
  readonly undoTarget: number | null;
  readonly redoTarget: number | null;
  apply(patch: JsonPatchOp[], meta: OpMeta): Promise<Operation>;
  undo(meta: OpMeta): Promise<Operation | null>;
  redo(meta: OpMeta): Promise<Operation | null>;
  revert(seq: number, meta: OpMeta): Promise<Operation>;
  toJSONL(): string;
}

export class OpLogError extends Error {}

const withoutHash = <T extends { hash: string }>(o: T): Omit<T, 'hash'> => { const { hash: _h, ...rest } = o; return rest; };
export const hashRecord = (o: { hash: string }): Promise<string> => sha256Hex(canonicalJson(withoutHash(o)));

export function textDelta(a: string, b: string): TextDelta {
  const n = Math.min(a.length, b.length);
  let p = 0;
  while (p < n && a.charCodeAt(p) === b.charCodeAt(p)) p++;
  let s = 0;
  while (s < n - p && a.charCodeAt(a.length - 1 - s) === b.charCodeAt(b.length - 1 - s)) s++;
  return { at: p, del: a.slice(p, a.length - s), ins: b.slice(p, b.length - s) };
}

export function applyDelta(text: string, d: TextDelta, dir: 'forward' | 'inverse'): string {
  const [out, inn] = dir === 'forward' ? [d.del, d.ins] : [d.ins, d.del];
  if (text.slice(d.at, d.at + out.length) !== out) throw new OpLogError(`text delta does not match at offset ${d.at}`);
  return text.slice(0, d.at) + inn + text.slice(d.at + out.length);
}

/** Replay primitive patch steps on the YAML text by comment-preserving splices (C7: never a whole-file rewrite). */
export function spliceSteps(text: string, steps: readonly PatchStep[]): string {
  let t = text;
  for (const s of steps) {
    if (s.kind === 'set') t = setIn(t, s.keys, s.value);
    else if (s.kind === 'insert') t = insertIn(t, s.keys, s.index, s.value);
    else t = deleteIn(t, s.keys, { prune: false });
  }
  return t;
}

const parseData = (text: string): unknown => parseStrict(text).toJS();

function checkMeta(meta: OpMeta): void {
  if (!isValidActor(meta.actor)) throw new OpLogError(`invalid actor ${JSON.stringify(meta.actor)} ('user' or 'agent:<session>')`);
  if (isAgentActor(meta.actor) && !(typeof meta.reason === 'string' && meta.reason.trim())) throw new OpLogError('agent operations require a reason');
  if (meta.reason !== undefined && (typeof meta.reason !== 'string' || meta.reason.length > 2000)) throw new OpLogError('reason: string of at most 2000 characters');
}

function makeValidator(opts: OpLogOptions): (data: unknown) => { ok: boolean; errors: string[] } {
  if (opts.validate) return opts.validate;
  if (opts.registry) {
    const reg = opts.registry;
    return (data) => {
      const v = validateSpec(data, reg);
      return { ok: v.ok, errors: v.issues.map((i) => `${i.dotted || '(root)'}: ${i.message}`) };
    };
  }
  return () => ({ ok: true, errors: [] });
}

interface Internal {
  text: string; data: unknown; specHash: string; head: string;
  ops: Operation[]; undo: number[]; redo: number[];
}

/** Track undo/redo stacks the same way during live use and replay. */
function stackEffect(st: Internal, op: Operation): void {
  if (op.kind === 'edit' || op.kind === 'revert') { st.undo.push(op.seq); st.redo.length = 0; }
  else if (op.kind === 'undo') { st.undo.pop(); st.redo.push(op.target as number); }
  else { st.redo.pop(); st.undo.push(op.target as number); }
}

async function makeGenesis(text: string, data: unknown, ts: string, embed: boolean): Promise<Genesis> {
  const g: Genesis = { schema: OPLOG_SCHEMA, kind: 'genesis', ts, specHash: await specHash(data), textHash: await sha256Hex(text), ...(embed ? { text } : {}), hash: '' };
  g.hash = await hashRecord(g);
  return g;
}

/** New operation log over a YAML spec text. */
export async function createOpLog(text: string, opts: OpLogOptions = {}): Promise<OpLog> {
  const data = parseData(text);
  const clock = opts.clock ?? (() => isoNow());
  const genesis = await makeGenesis(text, data, clock(), opts.embedText ?? true);
  const st: Internal = { text, data, specHash: genesis.specHash, head: genesis.hash, ops: [], undo: [], redo: [] };
  return wrap(st, genesis, opts);
}

function wrap(st: Internal, genesis: Genesis, opts: OpLogOptions): OpLog {
  const validate = makeValidator(opts);
  const clock = opts.clock ?? (() => isoNow());
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = queue.then(fn);
    queue = p.catch(() => undefined);
    return p;
  };

  async function commit(kind: OpKind, meta: OpMeta, patch: JsonPatchOp[], inverse: JsonPatchOp[], newText: string, newData: unknown, target?: number): Promise<Operation> {
    const validation = validate(newData);
    if (opts.requireValid && !validation.ok) throw new OpLogError(`edit refused: result does not validate:\n${validation.errors.join('\n')}`);
    const after = await specHash(newData);
    const op: Operation = {
      seq: st.ops.length + 1,
      ts: meta.ts ?? clock(),
      actor: meta.actor,
      ...(meta.reason !== undefined ? { reason: meta.reason } : {}),
      kind,
      ...(target !== undefined ? { target } : {}),
      patch, inverse,
      before: st.specHash, after,
      validation,
      invalidates: invalidationsFor(patch, st.data, newData),
      text: textDelta(st.text, newText),
      textHash: await sha256Hex(newText),
      prev: st.head,
      hash: '',
    };
    op.hash = await hashRecord(op);
    st.ops.push(op);
    st.text = newText; st.data = newData; st.specHash = after; st.head = op.hash;
    stackEffect(st, op);
    return op;
  }

  /** Patch applied by splicing the current text; returns the new text and data (verified equal to the patch result). */
  function spliced(patch: JsonPatchOp[]): { newText: string; newData: unknown; inverse: JsonPatchOp[] } {
    const { doc: next, steps } = applyPatch(st.data, patch);
    const inverse = invertPatch(st.data, patch);
    const newText = spliceSteps(st.text, steps);
    const newData = parseData(newText);
    if (!jsonEqual(newData, next)) throw new OpLogError('internal: spliced text does not reproduce the patch result');
    return { newText, newData, inverse };
  }

  const log: OpLog = {
    get text() { return st.text; },
    get data() { return structuredClone(st.data); },
    get ops() { return st.ops; },
    genesis,
    get head() { return st.head; },
    get canUndo() { return st.undo.length > 0; },
    get canRedo() { return st.redo.length > 0; },
    get undoTarget() { return st.undo.at(-1) ?? null; },
    get redoTarget() { return st.redo.at(-1) ?? null; },

    apply: (patch, meta) => serial(async () => {
      checkMeta(meta);
      if (!Array.isArray(patch) || !patch.length) throw new OpLogError('empty patch');
      const { newText, newData, inverse } = spliced(patch);
      return commit('edit', meta, structuredClone(patch), inverse, newText, newData);
    }),

    undo: (meta) => serial(async () => {
      checkMeta(meta);
      const t = st.undo.at(-1);
      if (t === undefined) return null;
      const target = st.ops[t - 1] as Operation;
      const { doc: next } = applyPatch(st.data, target.inverse);
      const newText = applyDelta(st.text, target.text, 'inverse');
      const newData = parseData(newText);
      if (!jsonEqual(newData, next)) throw new OpLogError(`undo of op ${t}: text and patch disagree`);
      return commit('undo', meta, structuredClone(target.inverse), invertPatch(st.data, target.inverse), newText, newData, t);
    }),

    redo: (meta) => serial(async () => {
      checkMeta(meta);
      const t = st.redo.at(-1);
      if (t === undefined) return null;
      const target = st.ops[t - 1] as Operation;
      const { doc: next } = applyPatch(st.data, target.patch);
      const newText = applyDelta(st.text, target.text, 'forward');
      const newData = parseData(newText);
      if (!jsonEqual(newData, next)) throw new OpLogError(`redo of op ${t}: text and patch disagree`);
      return commit('redo', meta, structuredClone(target.patch), invertPatch(st.data, target.patch), newText, newData, t);
    }),

    revert: (seq, meta) => serial(async () => {
      checkMeta(meta);
      const target = st.ops[seq - 1];
      if (!target) throw new OpLogError(`no op ${seq}`);
      let r;
      try { r = spliced(target.inverse); } catch (e) { throw new OpLogError(`revert of op ${seq} conflicts with later edits: ${(e as Error).message}`); }
      return commit('revert', meta, structuredClone(target.inverse), r.inverse, r.newText, r.newData, seq);
    }),

    toJSONL: () => [genesis, ...st.ops].map((o) => canonicalJson(o)).join('\n') + '\n',
  };
  return log;
}

/** Verify the hash chain of a genesis + ops sequence (hashes and links only, no text). */
export async function verifyChain(genesis: Genesis, ops: readonly Operation[]): Promise<{ ok: boolean; errors: string[] }> {
  const errors: string[] = [];
  if ((await hashRecord(genesis)) !== genesis.hash) errors.push('genesis: hash mismatch');
  let prev = genesis.hash;
  ops.forEach((op, i) => {
    if (op.seq !== i + 1) errors.push(`op ${i + 1}: seq ${op.seq}`);
    if (op.prev !== prev) errors.push(`op ${op.seq}: prev does not link to the previous hash`);
    prev = op.hash;
  });
  const hashes = await Promise.all(ops.map((op) => hashRecord(op)));
  hashes.forEach((h, i) => { if (h !== ops[i]!.hash) errors.push(`op ${ops[i]!.seq}: hash mismatch`); });
  return { ok: errors.length === 0, errors };
}

/**
 * Replay a JSONL log: verifies the chain, applies every text delta, checks text hashes, spec hashes and that each
 * patch reproduces its text change. Returns a live log positioned at the end (further edits continue the chain).
 */
export async function replayJSONL(jsonl: string, opts: OpLogOptions & { text?: string } = {}): Promise<{ ok: boolean; errors: string[]; log: OpLog | null }> {
  const lines = jsonl.split('\n').filter((l) => l.trim());
  const errors: string[] = [];
  let genesis: Genesis;
  let ops: Operation[];
  try {
    genesis = JSON.parse(lines[0] ?? 'null') as Genesis;
    ops = lines.slice(1).map((l) => JSON.parse(l) as Operation);
  } catch (e) { return { ok: false, errors: [`JSONL: ${(e as Error).message}`], log: null }; }
  if (!genesis || genesis.kind !== 'genesis' || genesis.schema !== OPLOG_SCHEMA) return { ok: false, errors: ['first line is not an amp-oplog/0 genesis record'], log: null };
  const chain = await verifyChain(genesis, ops);
  errors.push(...chain.errors);
  const text0 = genesis.text ?? opts.text;
  if (text0 === undefined) return { ok: false, errors: [...errors, 'genesis has no text and none was given'], log: null };
  if ((await sha256Hex(text0)) !== genesis.textHash) errors.push('genesis: text hash mismatch');
  let data: unknown;
  try { data = parseData(text0); } catch (e) { return { ok: false, errors: [...errors, (e as Error).message], log: null }; }
  if ((await specHash(data)) !== genesis.specHash) errors.push('genesis: spec hash mismatch');
  const st: Internal = { text: text0, data, specHash: genesis.specHash, head: genesis.hash, ops: [], undo: [], redo: [] };
  for (const op of ops) {
    try {
      if (op.before !== st.specHash) throw new Error('before hash does not match the replayed spec');
      const text = applyDelta(st.text, op.text, 'forward');
      if ((await sha256Hex(text)) !== op.textHash) throw new Error('text hash mismatch');
      const next = parseData(text);
      if (!jsonEqual(applyPatch(st.data, op.patch).doc, next)) throw new Error('patch does not reproduce the text change');
      const h = await specHash(next);
      if (h !== op.after) throw new Error('after hash mismatch');
      st.text = text; st.data = next; st.specHash = h; st.head = op.hash;
      st.ops.push(op);
      stackEffect(st, op);
    } catch (e) {
      errors.push(`op ${op.seq}: ${(e as Error).message}`);
      break;
    }
  }
  return { ok: errors.length === 0, errors, log: errors.length ? null : wrap(st, genesis, opts) };
}
