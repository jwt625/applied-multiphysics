// SPDX-License-Identifier: GPL-3.0-or-later
// Memory store (DevLog-001 A11 goal (b); R5 s.4.4). Plain markdown files on a backend, and a hash-chained log of
// memory operations so every memory write, by the agent or the user, is visible and revertible like a spec edit:
//   write / delete / import / external (file changed outside the app, found by refresh()) / revert / undo.
// Each op stores the file text before and after, so revert and undo are exact. Revert appends the inverse; it is
// refused when the file changed since (guard on the current text), like the spec op log's `test` guards.
// The log is persisted next to the files as memory-log.jsonl (one canonical-JSON op per line). If an existing log
// does not verify, it is left untouched and a new log file is started (reported in `problems`).

import { sha256Hex, canonicalJson, isValidActor, isAgentActor, isoNow } from '@amp/spec';
import { parseMemoryFile, formatMemoryFile, MEMORY_NAME, type MemoryEntry, type MemoryType } from './frontmatter.ts';
import { checkFileName, type MemoryBackend } from './backends.ts';

export const MEMORY_LOG_SCHEMA = 'amp-memlog/0';
export type MemoryOpKind = 'write' | 'delete' | 'import' | 'external' | 'revert' | 'undo';

export interface MemoryOp {
  schema: typeof MEMORY_LOG_SCHEMA;
  seq: number;
  ts: string;
  actor: string;
  reason?: string;
  kind: MemoryOpKind;
  target?: number;
  file: string;
  before: string | null;
  after: string | null;
  prev: string;
  hash: string;
}

export interface MemoryMeta { actor: string; reason?: string }
export class MemoryError extends Error {}

const GENESIS = '0'.repeat(64);
const LOG_FILE = 'memory-log.jsonl';
const hashOp = (op: MemoryOp): Promise<string> => { const { hash: _h, ...rest } = op; return sha256Hex(canonicalJson(rest)); };

function checkMeta(m: MemoryMeta): void {
  if (!isValidActor(m.actor)) throw new MemoryError(`invalid actor ${JSON.stringify(m.actor)}`);
  if (isAgentActor(m.actor) && !(typeof m.reason === 'string' && m.reason.trim())) throw new MemoryError('agent memory writes require a reason');
  if (m.reason !== undefined && m.reason.length > 2000) throw new MemoryError('reason: at most 2000 characters');
}

export interface MemoryStoreOptions {
  clock?: () => string;
  /** Strings that must never be written to memory (the API key; checked on every write). */
  forbidden?: () => readonly string[];
  /** Persist the op log to the backend (default true). */
  persistLog?: boolean;
}

/** Patterns of credentials that never belong in memory files. */
const SECRET_PATTERNS = [/sk-ant-[A-Za-z0-9_-]{8,}/];

export class MemoryStore {
  readonly ops: MemoryOp[] = [];
  readonly problems: string[] = [];
  private files = new Map<string, string>();
  private effect = new Map<number, 'applied' | 'reverted'>();
  private undoStack: number[] = [];
  private head = GENESIS;
  private logFile = LOG_FILE;
  private listeners = new Set<(op: MemoryOp) => void>();
  private queue: Promise<unknown> = Promise.resolve();

  readonly backend: MemoryBackend;
  private opts: MemoryStoreOptions;
  private constructor(backend: MemoryBackend, opts: MemoryStoreOptions) { this.backend = backend; this.opts = opts; }

  static async open(backend: MemoryBackend, opts: MemoryStoreOptions = {}): Promise<MemoryStore> {
    const s = new MemoryStore(backend, opts);
    for (const f of await backend.list()) if (f.endsWith('.md')) s.files.set(f, (await backend.read(f)) ?? '');
    const raw = await backend.read(LOG_FILE);
    if (raw) {
      try {
        const ops = raw.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as MemoryOp);
        let prev = GENESIS;
        for (const op of ops) {
          if (op.schema !== MEMORY_LOG_SCHEMA || op.prev !== prev || (await hashOp(op)) !== op.hash || op.seq !== s.ops.length + 1) throw new Error(`op ${op.seq} does not verify`);
          s.ops.push(op); s.track(op); prev = op.hash;
        }
        s.head = prev;
      } catch (e) {
        s.problems.push(`${LOG_FILE}: ${(e as Error).message}; left unchanged, new log started`);
        s.ops.length = 0; s.effect.clear(); s.undoStack.length = 0; s.head = GENESIS;
        s.logFile = `memory-log-${s.clock().replace(/[^0-9]/g, '').slice(0, 14)}.jsonl`;
      }
    }
    return s;
  }

  private clock(): string { return (this.opts.clock ?? (() => isoNow()))(); }
  private serial<T>(fn: () => Promise<T>): Promise<T> { const p = this.queue.then(fn); this.queue = p.catch(() => undefined); return p; }
  subscribe(fn: (op: MemoryOp) => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  /** An inverse op (revert/undo) in effect means its target is not, recursively (revert of a revert re-applies). */
  private setState(op: MemoryOp, state: 'applied' | 'reverted'): void {
    this.effect.set(op.seq, state);
    if ((op.kind === 'revert' || op.kind === 'undo') && op.target !== undefined) {
      this.setState(this.ops[op.target - 1] as MemoryOp, state === 'applied' ? 'reverted' : 'applied');
    }
  }

  private track(op: MemoryOp): void {
    this.setState(op, 'applied');
    if (op.kind !== 'undo') this.undoStack.push(op.seq);
  }

  /** Text of a memory file, or null. */
  text(file: string): string | null { return this.files.get(file) ?? null; }
  fileNames(): string[] { return [...this.files.keys()].sort(); }

  /** Parsed entries; unparseable files are listed in `invalid` (still visible to the user, never to recall). */
  entries(): { entries: Array<MemoryEntry & { file: string }>; invalid: Array<{ file: string; error: string }> } {
    const entries: Array<MemoryEntry & { file: string }> = [];
    const invalid: Array<{ file: string; error: string }> = [];
    for (const f of this.fileNames()) {
      try { entries.push({ ...parseMemoryFile(this.files.get(f) as string, f), file: f }); }
      catch (e) { invalid.push({ file: f, error: (e as Error).message }); }
    }
    return { entries, invalid };
  }

  /** Always-loaded index: one line per entry, capped like Claude Code's MEMORY.md (200 lines, 25 KB). */
  index(maxLines = 200, maxBytes = 25_000): string {
    const lines: string[] = [];
    let bytes = 0;
    for (const e of this.entries().entries) {
      const l = `- ${e.name} [${e.type}${e.appliesWhen.length ? `; ${e.appliesWhen.join(',')}` : ''}]: ${e.description}`;
      if (lines.length >= maxLines || bytes + l.length + 1 > maxBytes) { lines.push(`- ... ${this.entries().entries.length - lines.length} more`); break; }
      lines.push(l); bytes += l.length + 1;
    }
    return lines.join('\n');
  }

  effectOf(seq: number): 'applied' | 'reverted' | null { return this.effect.get(seq) ?? null; }

  private checkSecrets(text: string): void {
    for (const s of this.opts.forbidden?.() ?? []) if (s && text.includes(s)) throw new MemoryError('refused: the text contains a credential');
    for (const p of SECRET_PATTERNS) if (p.test(text)) throw new MemoryError('refused: the text contains something shaped like an API key');
  }

  private async commit(kind: MemoryOpKind, file: string, after: string | null, meta: MemoryMeta, target?: number): Promise<MemoryOp> {
    const before = this.files.get(file) ?? null;
    if (after !== null) this.checkSecrets(after);
    if (after !== null) await this.backend.write(file, after); else await this.backend.remove(file);
    if (after !== null) this.files.set(file, after); else this.files.delete(file);
    const op: MemoryOp = {
      schema: MEMORY_LOG_SCHEMA, seq: this.ops.length + 1, ts: this.clock(), actor: meta.actor,
      ...(meta.reason !== undefined ? { reason: meta.reason } : {}),
      kind, ...(target !== undefined ? { target } : {}), file, before, after, prev: this.head, hash: '',
    };
    op.hash = await hashOp(op);
    this.ops.push(op); this.head = op.hash; this.track(op);
    if (this.opts.persistLog ?? true) await this.backend.write(this.logFile, this.toJSONL());
    for (const l of this.listeners) l(op);
    return op;
  }

  /** Create or replace an entry from fields (agent tool memory_write, UI forms). */
  write(e: { name: string; description: string; type: MemoryType; appliesWhen?: string[]; body: string }, meta: MemoryMeta): Promise<MemoryOp> {
    return this.serial(async () => {
      checkMeta(meta);
      if (!MEMORY_NAME.test(e.name)) throw new MemoryError('name: lowercase letters, digits and -, at most 64');
      const entry: MemoryEntry = { name: e.name, description: e.description, type: e.type, appliesWhen: e.appliesWhen ?? [], updated: this.clock().slice(0, 10), body: e.body };
      const text = formatMemoryFile(entry);
      parseMemoryFile(text, `${e.name}.md`); // round-trip check
      if (this.files.get(`${e.name}.md`) === text) throw new MemoryError('no change');
      return this.commit('write', `${e.name}.md`, text, meta);
    });
  }

  /** Write raw markdown (the user's own editor). The file must parse. */
  writeText(file: string, text: string, meta: MemoryMeta, kind: 'write' | 'import' = 'write'): Promise<MemoryOp> {
    return this.serial(async () => {
      checkMeta(meta); checkFileName(file);
      if (!file.endsWith('.md')) throw new MemoryError('memory files end in .md');
      parseMemoryFile(text, file);
      if (this.files.get(file) === text) throw new MemoryError('no change');
      return this.commit(kind, file, text, meta);
    });
  }

  remove(name: string, meta: MemoryMeta): Promise<MemoryOp> {
    return this.serial(async () => {
      checkMeta(meta);
      const file = name.endsWith('.md') ? name : `${name}.md`;
      checkFileName(file);
      if (!this.files.has(file)) throw new MemoryError(`no memory file ${file}`);
      return this.commit('delete', file, null, meta);
    });
  }

  private why(seq: number): string | null {
    const t = this.ops[seq - 1];
    if (!t) return `no memory op ${seq}`;
    if (this.effect.get(seq) !== 'applied') return `memory op ${seq} is ${this.effect.get(seq)}; only ops in effect can be reverted`;
    if ((this.files.get(t.file) ?? null) !== t.after) return `memory file ${t.file} changed after op ${seq}; revert refused`;
    return null;
  }

  /** Append the inverse of op `seq` (exact text restore). */
  revert(seq: number, meta: MemoryMeta): Promise<MemoryOp> {
    return this.serial(async () => {
      checkMeta(meta);
      const w = this.why(seq);
      if (w) throw new MemoryError(w);
      const t = this.ops[seq - 1] as MemoryOp;
      return this.commit('revert', t.file, t.before, meta, seq);
    });
  }

  /** Undo the newest memory op still in effect. */
  undo(meta: MemoryMeta): Promise<MemoryOp | null> {
    return this.serial(async () => {
      checkMeta(meta);
      const seq = [...this.undoStack].reverse().find((s) => this.effect.get(s) === 'applied');
      if (seq === undefined) return null;
      const w = this.why(seq);
      if (w) throw new MemoryError(w);
      const t = this.ops[seq - 1] as MemoryOp;
      return this.commit('undo', t.file, t.before, meta, seq);
    });
  }

  /** Record edits made to the files outside the app (another editor, a synced folder) as user ops. */
  refresh(meta: MemoryMeta = { actor: 'user', reason: 'edited outside the app' }): Promise<MemoryOp[]> {
    return this.serial(async () => {
      const out: MemoryOp[] = [];
      const names = new Set([...(await this.backend.list()).filter((f) => f.endsWith('.md')), ...this.files.keys()]);
      for (const f of [...names].sort()) {
        const disk = await this.backend.read(f);
        if (disk === (this.files.get(f) ?? null)) continue;
        // the backend already holds the new state: record the op without writing it back
        const before = this.files.get(f) ?? null;
        if (disk !== null) this.files.set(f, disk); else this.files.delete(f);
        const op: MemoryOp = { schema: MEMORY_LOG_SCHEMA, seq: this.ops.length + 1, ts: this.clock(), actor: meta.actor, ...(meta.reason ? { reason: meta.reason } : {}), kind: 'external', file: f, before, after: disk, prev: this.head, hash: '' };
        op.hash = await hashOp(op);
        this.ops.push(op); this.head = op.hash; this.track(op); out.push(op);
        for (const l of this.listeners) l(op);
      }
      if (out.length && (this.opts.persistLog ?? true)) await this.backend.write(this.logFile, this.toJSONL());
      return out;
    });
  }

  toJSONL(): string { return this.ops.map((o) => canonicalJson(o)).join('\n') + (this.ops.length ? '\n' : ''); }

  /** Copy every memory file (and the log) to another backend, e.g. a folder the user picked. Overwrites nothing there unless `overwrite`. */
  async exportTo(target: MemoryBackend, opts: { overwrite?: boolean } = {}): Promise<{ written: string[]; skipped: string[] }> {
    const written: string[] = []; const skipped: string[] = [];
    const existing = new Set(await target.list());
    for (const [f, t] of [...this.files.entries(), [this.logFile, this.toJSONL()] as [string, string]]) {
      if (existing.has(f) && !opts.overwrite && (await target.read(f)) !== t) { skipped.push(f); continue; }
      await target.write(f, t); written.push(f);
    }
    return { written, skipped };
  }

  /** Import memory files from another backend as `import` ops (each revertible). Invalid files are reported, not imported. */
  async importFrom(source: MemoryBackend, meta: MemoryMeta = { actor: 'user', reason: 'import from folder' }): Promise<{ imported: string[]; unchanged: string[]; invalid: Array<{ file: string; error: string }> }> {
    const imported: string[] = []; const unchanged: string[] = []; const invalid: Array<{ file: string; error: string }> = [];
    for (const f of (await source.list()).filter((x) => x.endsWith('.md'))) {
      const t = (await source.read(f)) ?? '';
      try { parseMemoryFile(t, f); } catch (e) { invalid.push({ file: f, error: (e as Error).message }); continue; }
      if (this.files.get(f) === t) { unchanged.push(f); continue; }
      try { await this.writeText(f, t, meta, 'import'); imported.push(f); } catch (e) { invalid.push({ file: f, error: (e as Error).message }); }
    }
    return { imported, unchanged, invalid };
  }
}
