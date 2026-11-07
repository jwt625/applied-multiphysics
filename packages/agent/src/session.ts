// SPDX-License-Identifier: GPL-3.0-or-later
// Agent session: the tool API over the host's operation log (DevLog-001 A4, A11; R5 s.4.2). The UI and the agent are
// two clients of the same OpLog instance, so every agent edit is an ordinary operation (actor `agent:<session>`,
// reason required) in the same timeline, undoable and revertible by the user (D3: no approval gate).
// Navigation calls go to the NavigationHost and a visible trail; runs are recorded as side effects (not undoable).
// Every string derived from the spec, the logs, results or memory is returned inside an untrusted block (S5).

import {
  keysOf, getAt, schemaAt, specHash, isoNow, parseEntityId, REG_KINDS, ENTITY_LIST,
  type OpLog, type Registry, type BuiltGeometry, type JsonPatchOp, type PathKey,
} from '@amp/spec';
import { TOOL_INPUTS, NAV_TOOLS, type ToolName, type ToolInput } from './tools/schemas.ts';
import { toolText, structuredIssues, TrustBoundaryError } from './untrusted.ts';
import { NavTrail, type NavigationHost } from './nav.ts';
import { ResultsStore, type StudyRunner, type StudyOutcome } from './runner.ts';
import { MemoryStore } from './memory/store.ts';
import { containsSecret } from './secrets.ts';

const enc = new TextEncoder();
import type { ImageBlock, TextBlock } from './provider/types.ts';

export interface ToolOutput { content: Array<TextBlock | ImageBlock>; isError: boolean }

export interface SideEffect { seq: number; ts: string; actor: string; kind: 'run'; study: string; ok: boolean; specHash: string; turn?: number }

export interface TimelineRow {
  ts: string;
  source: 'spec' | 'memory' | 'nav' | 'run';
  seq: number;
  actor: string;
  kind: string;
  reason?: string;
  /** spec: invalidated artifacts; memory: file; nav: tool; run: study. */
  detail?: string;
}

export interface AgentSessionOptions {
  log: OpLog;
  registry: Registry;
  memory: MemoryStore;
  nav: NavigationHost;
  runner?: StudyRunner;
  /** Built geometry (entity table + the canonical @amp/geom resolver), for list_entities and selection checks. */
  geometry?: () => BuiltGeometry | null;
  sessionId?: string;
  clock?: () => string;
  /** Secrets that must never enter the spec, the logs, memory or the trail (KeyStore.forbidden). */
  forbidden?: () => readonly string[];
  /** Largest single read (default MAX_READ_BYTES); tests lower it to exercise paging. */
  maxReadBytes?: number;
}

/** Bounds on tool input before parsing (audit S5: a 2,000-deep value made zod throw RangeError). */
const MAX_INPUT_DEPTH = 64;
const MAX_INPUT_BYTES = 1_000_000;

function depthOf(x: unknown): number {
  let max = 0;
  const stack: Array<[unknown, number]> = [[x, 0]];
  while (stack.length) {
    const [v, d] = stack.pop()!;
    if (d > max) max = d;
    if (d > MAX_INPUT_DEPTH) return d;
    if (v && typeof v === 'object') for (const c of Object.values(v as Record<string, unknown>)) stack.push([c, d + 1]);
  }
  return max;
}

/** Largest read returned in one tool result (bytes); larger specs are paged, larger values refused with a hint. */
export const MAX_READ_BYTES = 60_000;
/** schema_at returns a compact summary for the root and for schemas above this size (audit S6). */
export const MAX_SCHEMA_BYTES = 8_000;

/** One-level summary of a JSON Schema: property names with short types, required keys, union variants. */
export function summarizeSchema(s: unknown): unknown {
  const short = (v: unknown): string => {
    const o = (v ?? {}) as Record<string, unknown>;
    if (typeof o.$ref === 'string') return `ref ${o.$ref.replace('#/$defs/', '')}`;
    if (o.const !== undefined) return `const ${JSON.stringify(o.const)}`;
    if (Array.isArray(o.enum)) return `enum ${o.enum.length}`;
    const u = (o.oneOf ?? o.anyOf) as unknown[] | undefined;
    if (Array.isArray(u)) return `union of ${u.length}`;
    if (o.type === 'array') return `array of ${short(o.items)}`;
    return typeof o.type === 'string' ? o.type : 'any';
  };
  const o = (s ?? {}) as Record<string, unknown>;
  const u = (o.oneOf ?? o.anyOf) as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(u)) {
    return { union: u.map((v) => {
      const t = (v.properties as Record<string, Record<string, unknown>> | undefined)?.type;
      return t?.const !== undefined ? { type: t.const } : short(v);
    }) };
  }
  const props = o.properties as Record<string, unknown> | undefined;
  return {
    type: o.type ?? null,
    ...(props ? { properties: Object.fromEntries(Object.entries(props).map(([k, v]) => [k, short(v)])) } : {}),
    ...(Array.isArray(o.required) ? { required: o.required } : {}),
    ...(o.type === 'array' ? { items: short(o.items) } : {}),
    ...(o.additionalProperties && typeof o.additionalProperties === 'object' ? { values: short(o.additionalProperties) } : {}),
  };
}

const ok = (trusted: Record<string, unknown>, untrusted?: { data: unknown; source: string }): ToolOutput => ({ content: [{ type: 'text', text: toolText({ ok: true, ...trusted }, untrusted) }], isError: false });
const fail = (code: string, detail?: unknown, source = 'error'): ToolOutput => ({ content: [{ type: 'text', text: toolText({ ok: false, error: code }, detail === undefined ? undefined : { data: detail, source }) }], isError: true });

function newSessionId(): string {
  const b = new Uint8Array(6);
  globalThis.crypto.getRandomValues(b);
  return `s-${Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')}`;
}

export class AgentSession {
  readonly id: string;
  readonly actor: `agent:${string}`;
  readonly log: OpLog;
  readonly registry: Registry;
  readonly memory: MemoryStore;
  readonly nav: NavigationHost;
  readonly trail: NavTrail;
  readonly results = new ResultsStore();
  readonly sideEffects: SideEffect[] = [];
  /** Spec op seqs and memory op seqs made by this session, per agent turn. */
  readonly turnOps = new Map<number, { spec: number[]; memory: number[] }>();
  turn = 0;
  private runner: StudyRunner | undefined;
  private geometry: () => BuiltGeometry | null;
  private clock: () => string;
  private forbidden: () => readonly string[];
  private maxReadBytes: number;

  constructor(o: AgentSessionOptions) {
    this.id = o.sessionId ?? newSessionId();
    this.actor = `agent:${this.id}`;
    this.log = o.log; this.registry = o.registry; this.memory = o.memory; this.nav = o.nav;
    this.runner = o.runner;
    this.geometry = o.geometry ?? (() => null);
    this.clock = o.clock ?? (() => isoNow());
    this.forbidden = o.forbidden ?? (() => []);
    this.maxReadBytes = o.maxReadBytes ?? MAX_READ_BYTES;
    this.trail = new NavTrail(this.clock);
  }

  private mark(kind: 'spec' | 'memory', seq: number): void {
    const t = this.turnOps.get(this.turn) ?? { spec: [], memory: [] };
    t[kind].push(seq);
    this.turnOps.set(this.turn, t);
  }

  /** Physics types in the current spec (for memory recall). */
  physicsTypes(): string[] {
    const p = (this.log.data as { physics?: Array<{ type?: unknown }> }).physics ?? [];
    return [...new Set(p.map((x) => x.type).filter((t): t is string => typeof t === 'string'))];
  }

  /** One merged, time-ordered view of spec ops, memory ops, navigation and runs (for the L5 timeline). */
  timeline(): TimelineRow[] {
    const rows: TimelineRow[] = [
      ...this.log.ops.map((o): TimelineRow => ({ ts: o.ts, source: 'spec', seq: o.seq, actor: o.actor, kind: o.kind, ...(o.reason ? { reason: o.reason } : {}), detail: o.invalidates.join(',') })),
      ...this.memory.ops.map((o): TimelineRow => ({ ts: o.ts, source: 'memory', seq: o.seq, actor: o.actor, kind: o.kind, ...(o.reason ? { reason: o.reason } : {}), detail: o.file })),
      ...this.trail.entries.map((e): TimelineRow => ({ ts: e.ts, source: 'nav', seq: e.seq, actor: e.actor, kind: e.tool })),
      ...this.sideEffects.map((s): TimelineRow => ({ ts: s.ts, source: 'run', seq: s.seq, actor: s.actor, kind: s.ok ? 'run' : 'run-failed', detail: s.study })),
    ];
    return rows.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  }

  /** Revert every spec and memory op of one agent turn, newest first (UI "revert turn"). Stops at the first conflict. */
  async revertTurn(turn: number, meta: { actor: 'user' | `agent:${string}`; reason?: string } = { actor: 'user', reason: `revert agent turn ${turn}` }): Promise<{ reverted: number; error?: string }> {
    const t = this.turnOps.get(turn);
    if (!t) return { reverted: 0 };
    let n = 0;
    try {
      // undo when the op is the top of the undo stack (restores the YAML text byte for byte, comments included);
      // revert otherwise (guarded inverse by splice; comments of removed blocks are not restored, DevLog-003 s.6)
      for (const seq of [...t.spec].reverse()) {
        if (this.log.effectOf(seq) !== 'applied') continue;
        if (this.log.undoTarget === seq) await this.log.undo(meta); else await this.log.revert(seq, meta);
        n++;
      }
      for (const seq of [...t.memory].reverse()) if (this.memory.effectOf(seq) === 'applied') { await this.memory.revert(seq, meta); n++; }
    } catch (e) { return { reverted: n, error: (e as Error).message }; }
    return { reverted: n };
  }

  /** True when a value carries the key or a credential-shaped token. */
  containsSecret(x: unknown): boolean { return containsSecret(x, this.forbidden()); }

  /** Memory files whose last view in the model context was cut (a rewrite needs a full memory_read first). */
  readonly partialMemory = new Set<string>();
  /** Set while only part of the spec YAML was read through get_spec pages (whole-spec replace refused). */
  private specPartial = false;

  /** Execute one tool call. Never throws: every failure, including an internal exception, is an error result. */
  async execute(name: string, input: unknown, signal?: AbortSignal): Promise<ToolOutput> {
    if (!Object.hasOwn(TOOL_INPUTS, name)) return fail('unknown_tool');
    const tn = name as ToolName;
    let navArgs: Record<string, unknown> | null = null;
    let navOk = false;
    try {
      // bounds first (cheap, iterative), then the secret scan, so a secret in any argument is never stored anywhere
      if (depthOf(input) > MAX_INPUT_DEPTH) return fail('input_too_deep');
      if (JSON.stringify(input ?? null).length > MAX_INPUT_BYTES) return fail('input_too_large');
      if (this.containsSecret(input)) return fail('refused_secret');
      const parsed = TOOL_INPUTS[tn].safeParse(input);
      if (!parsed.success) return fail('invalid_input', parsed.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message })), 'input-validation');
      if (NAV_TOOLS.has(tn)) navArgs = parsed.data as Record<string, unknown>;
      const out = await this.dispatch(tn, parsed.data as never, signal);
      navOk = !out.isError;
      return out;
    } catch (e) {
      if (e instanceof TrustBoundaryError) return fail('internal_trust_boundary');
      return fail('tool_failed', { message: e instanceof Error ? e.message : String(e) }, `${tn}-error`);
    } finally {
      // recorded even when the host threw (audit M3): the UI may have changed
      if (navArgs) this.trail.record({ actor: this.actor, tool: tn, args: navArgs, ok: navOk, turn: this.turn });
    }
  }

  private resolves(pointer: string): boolean {
    try { keysOf(this.log.data, pointer); return true; } catch { return false; }
  }

  private async dispatch<N extends ToolName>(name: N, a: ToolInput<N>, signal?: AbortSignal): Promise<ToolOutput> {
    const meta = (reason: string) => ({ actor: this.actor, reason });
    switch (name) {
      case 'apply_ops': {
        const x = a as ToolInput<'apply_ops'>;
        if (this.specPartial && x.ops.some((o) => o.path === '' || ('from' in o && o.from === ''))) return fail('read_full_spec_first');
        let op;
        try { op = await this.log.apply(x.ops as JsonPatchOp[], meta(x.reason)); }
        catch (e) { return fail('patch_failed', { message: (e as Error).message }, 'oplog-error'); }
        this.mark('spec', op.seq);
        const v = structuredIssues(this.log.data, this.registry);
        return ok({ seq: op.seq, valid: v.ok, issueCount: v.count, invalidates: op.invalidates }, v.count ? { data: { issues: v.issues }, source: 'validation' } : undefined);
      }
      case 'revert_op': {
        const x = a as ToolInput<'revert_op'>;
        try {
          if (x.log === 'memory') { const op = await this.memory.revert(x.seq, meta(x.reason)); this.mark('memory', op.seq); return ok({ log: 'memory', seq: op.seq, target: x.seq }); }
          const op = await this.log.revert(x.seq, meta(x.reason));
          this.mark('spec', op.seq);
          const v = structuredIssues(this.log.data, this.registry);
          return ok({ log: 'spec', seq: op.seq, target: x.seq, valid: v.ok, issueCount: v.count, invalidates: op.invalidates }, v.count ? { data: { issues: v.issues }, source: 'validation' } : undefined);
        } catch (e) { return fail('revert_failed', { message: (e as Error).message }, 'oplog-error'); }
      }
      case 'undo': {
        const x = a as ToolInput<'undo'>;
        try {
          if (x.log === 'memory') {
            const c = this.memory.undoCandidate();
            if (!c) return fail('nothing_to_undo');
            if (c.actor !== this.actor && !x.allow_other_actor) return fail('top_op_not_yours', { seq: c.seq, actor: c.actor, hint: 'use list_ops (log memory) and revert_op for your own op, or allow_other_actor when the user asked' }, 'memory-log');
            const op = await this.memory.undo(meta(x.reason));
            if (!op) return fail('nothing_to_undo');
            this.mark('memory', op.seq);
            return ok({ log: 'memory', seq: op.seq, target: op.target ?? null });
          }
          const top = this.log.undoTarget;
          if (top === null) return fail('nothing_to_undo');
          const topOp = this.log.ops[top - 1];
          if (topOp && topOp.actor !== this.actor && !x.allow_other_actor) return fail('top_op_not_yours', { seq: top, actor: topOp.actor, reason: topOp.reason ?? null, hint: 'use list_ops and revert_op for your own op, or allow_other_actor when the user asked to undo this' }, 'oplog');
          const op = await this.log.undo(meta(x.reason));
          if (!op) return fail('nothing_to_undo');
          this.mark('spec', op.seq);
          const target = this.log.ops[(op.target as number) - 1];
          return ok({ log: 'spec', seq: op.seq, target: op.target ?? null, targetBySelf: target?.actor === this.actor, invalidates: op.invalidates }, { data: { targetActor: target?.actor, targetReason: target?.reason ?? null }, source: 'oplog' });
        } catch (e) { return fail('undo_failed', { message: (e as Error).message }, 'oplog-error'); }
      }
      case 'redo': {
        const x = a as ToolInput<'redo'>;
        try {
          const op = await this.log.redo(meta(x.reason));
          if (!op) return fail('nothing_to_redo');
          this.mark('spec', op.seq);
          return ok({ seq: op.seq, target: op.target ?? null, invalidates: op.invalidates });
        } catch (e) { return fail('redo_failed', { message: (e as Error).message }, 'oplog-error'); }
      }
      case 'get_spec': {
        const x = a as ToolInput<'get_spec'>;
        if (x.pointer === undefined || x.pointer === '') {
          const text = this.log.text;
          const lines = text.split('\n');
          const bytes = enc.encode(text).length;
          if (bytes <= this.maxReadBytes && x.from_line === undefined && x.to_line === undefined) {
            this.specPartial = false;
            return ok({ format: 'yaml', complete: true, total_lines: lines.length, total_bytes: bytes }, { data: { yaml: text }, source: 'spec' });
          }
          // explicit pages of whole lines, never a silent cut (audit B2)
          const from = Math.max(1, x.from_line ?? 1);
          if (from > lines.length) return fail('line_out_of_range');
          let to = Math.min(lines.length, x.to_line ?? lines.length);
          let page = lines.slice(from - 1, to).join('\n');
          while (to > from && enc.encode(page).length > this.maxReadBytes) { to = from + Math.floor((to - from) / 2); page = lines.slice(from - 1, to).join('\n'); }
          const complete = from === 1 && to === lines.length;
          this.specPartial = !complete;
          return ok({ format: 'yaml', complete, from_line: from, to_line: to, total_lines: lines.length, total_bytes: bytes, next_from_line: to < lines.length ? to + 1 : null }, { data: { yaml: page }, source: 'spec' });
        }
        let keys: PathKey[];
        try { keys = keysOf(this.log.data, x.pointer); } catch (e) { return fail('pointer_not_found', { message: (e as Error).message }, 'pointer'); }
        const value = getAt(this.log.data, keys) ?? null;
        const vb = enc.encode(JSON.stringify(value)).length;
        if (vb > this.maxReadBytes) return fail('value_too_large', { total_bytes: vb, hint: 'read a deeper pointer, or get_spec with from_line/to_line' }, 'spec');
        return ok({ format: 'json', total_bytes: vb }, { data: { value }, source: 'spec' });
      }
      case 'schema_at': {
        const x = a as ToolInput<'schema_at'>;
        let data: unknown = this.log.data;
        let ptr = x.pointer;
        if (x.type !== undefined) {
          // place a stub element of the requested type so the registered union resolves
          const toks = ptr.split('/');
          const last = toks.pop();
          const parentPtr = toks.join('/');
          try {
            const pk = keysOf(data, parentPtr);
            const parent = getAt(data, pk);
            data = structuredClone(data);
            const p2 = getAt(data, pk);
            if (Array.isArray(parent) && Array.isArray(p2) && (last === '-' || last === undefined)) { p2.push({ type: x.type }); ptr = `${parentPtr}/${p2.length - 1}`; }
            else if (p2 && typeof p2 === 'object' && last !== undefined) {
              const k = keysOf(data, ptr);
              const node = getAt(data, k);
              if (node && typeof node === 'object') (node as Record<string, unknown>).type = x.type;
            }
          } catch (e) { return fail('pointer_not_found', { message: (e as Error).message }, 'pointer'); }
        }
        const r = schemaAt(this.registry, ptr, data);
        if (!r) return fail('no_schema');
        const bytes = enc.encode(JSON.stringify(r.json)).length;
        if (ptr === '' || bytes > MAX_SCHEMA_BYTES) {
          // compact summary instead of tens of kB (audit S6); a deeper pointer gives the full schema
          return ok({ summary: true, total_bytes: bytes, hint: 'narrow the pointer for the full schema' }, { data: { schema: summarizeSchema(r.json) }, source: 'schema' });
        }
        return ok({ summary: false, total_bytes: bytes }, { data: { schema: r.json }, source: 'schema' });
      }
      case 'list_entities': {
        const x = a as ToolInput<'list_entities'>;
        const kind = x.kind ?? 'all';
        const s = this.log.data as Record<string, unknown>;
        const arr = (k: string) => (Array.isArray(s[k]) ? (s[k] as Array<Record<string, unknown>>) : []);
        const out: Record<string, unknown> = {};
        const want = (k: string) => kind === 'all' || kind === k;
        if (want('params')) out.params = Object.keys((s.params as Record<string, unknown>) ?? {});
        if (want('features')) out.features = ((s.geometry as { features?: Array<Record<string, unknown>> } | undefined)?.features ?? []).map((f) => ({ id: f.id, type: f.type }));
        if (want('materials')) out.materials = arr('materials').map((m) => ({ id: m.id, ref: m.ref ?? null, select: m.select ?? [] }));
        if (want('physics')) out.physics = arr('physics').map((p) => ({ id: p.id, type: p.type, select: p.select ?? [], bcs: (Array.isArray(p.bcs) ? (p.bcs as Array<Record<string, unknown>>) : []).map((b) => ({ id: b.id, type: b.type, select: b.select ?? [] })) }));
        if (want('studies')) out.studies = arr('studies').map((t) => ({ id: t.id, type: t.type, physics: t.physics ?? [] }));
        if (want('results')) out.results = arr('results').map((r) => ({ id: r.id, type: r.type, data: r.data ?? null, expr: r.expr ?? null }));
        if (want('geometry')) {
          const t = this.geometry()?.table;
          out.geometry = t ? { domains: t.domains.map((e) => e.id), boundaries: t.boundaries.map((e) => e.id), edges: (t.edges ?? []).map((e) => e.id), points: (t.points ?? []).map((e) => e.id) } : 'unavailable: geometry not built yet';
        }
        if (want('types')) out.types = Object.fromEntries(REG_KINDS.map((k) => [k, this.registry.list(k).map((r) => ({ type: r.type, ...(r.for ? { for: r.for } : {}), ...(r.select ? { select: r.select } : {}), ...(r.description ? { description: r.description } : {}) }))]));
        return ok({ kind }, { data: out, source: 'spec' });
      }
      case 'list_ops': {
        const x = a as ToolInput<'list_ops'>;
        const n = x.limit ?? 10;
        if (x.log === 'memory') {
          const ops = this.memory.ops.slice(-n).reverse().map((o) => ({ seq: o.seq, ts: o.ts, actor: o.actor, kind: o.kind, target: o.target ?? null, reason: o.reason ?? null, effect: this.memory.effectOf(o.seq), file: o.file, bySelf: o.actor === this.actor }));
          return ok({ log: 'memory', total: this.memory.ops.length, shown: ops.length }, { data: { ops }, source: 'memory-log' });
        }
        const ops = this.log.ops.slice(-n).reverse().map((o) => ({ seq: o.seq, ts: o.ts, actor: o.actor, kind: o.kind, target: o.target ?? null, reason: o.reason ?? null, effect: this.log.effectOf(o.seq), paths: o.patch.filter((p) => p.op !== 'test' && p.op !== 'absent').map((p) => p.path), invalidates: o.invalidates, bySelf: o.actor === this.actor }));
        return ok({ log: 'spec', total: this.log.ops.length, shown: ops.length, canUndo: this.log.canUndo, canRedo: this.log.canRedo }, { data: { ops }, source: 'oplog' });
      }
      case 'get_run_record': {
        const x = a as ToolInput<'get_run_record'>;
        const r = this.results.get(x.study);
        if (!r) return fail('no_run');
        const stale = r.specHash !== (await specHash(this.log.data));
        if (!r.outcome.ok) return ok({ runOk: false, stale }, { data: { study: r.outcome.study, at: r.at, stage: r.outcome.stage, message: r.outcome.message }, source: 'run' });
        return ok({ runOk: true, stale }, { data: { study: r.outcome.study, at: r.at, run: r.outcome.solution.run }, source: 'run' });
      }
      case 'get_results_summary': {
        const x = a as ToolInput<'get_results_summary'>;
        const r = this.results.get(x.study);
        if (!r) return fail('no_run');
        return ok(await this.summaryTrusted(r.outcome, r.specHash), { data: this.summaryData(r.outcome), source: 'results' });
      }
      case 'run_study': {
        const x = a as ToolInput<'run_study'>;
        if (!this.runner) return fail('no_runner');
        const studies = ((this.log.data as { studies?: Array<{ id?: unknown }> }).studies ?? []).map((t) => t.id);
        if (!studies.includes(x.study)) return fail('unknown_study', { study: x.study, studies }, 'spec');
        const h = await specHash(this.log.data);
        const ctl = new AbortController();
        const onAbort = () => ctl.abort();
        signal?.addEventListener('abort', onAbort, { once: true });
        let outcome: StudyOutcome;
        try { outcome = await this.runner.run({ specText: this.log.text, studyId: x.study, signal: ctl.signal, oplogHead: this.log.head }); }
        catch (e) { outcome = { ok: false, study: x.study, stage: 'runner', message: (e as Error).message }; }
        finally { signal?.removeEventListener('abort', onAbort); }
        const at = this.clock();
        this.results.set(outcome, h, at);
        this.sideEffects.push({ seq: this.sideEffects.length + 1, ts: at, actor: this.actor, kind: 'run', study: x.study, ok: outcome.ok, specHash: h, turn: this.turn });
        return { ...ok(await this.summaryTrusted(outcome, h), { data: this.summaryData(outcome), source: 'results' }), isError: !outcome.ok };
      }
      case 'focus_node':
      case 'open_settings': {
        const x = a as ToolInput<'open_settings'>;
        if (!this.resolves(x.pointer)) return fail('pointer_not_found');
        const r = name === 'focus_node' ? await this.nav.focusNode(x.pointer) : await this.nav.openSettings(x.pointer, x.field);
        return r.ok ? ok({}) : fail('ui_refused', { message: r.message ?? '' }, 'ui');
      }
      case 'highlight_selection': {
        const x = a as ToolInput<'highlight_selection'>;
        const feats = new Set(((this.log.data as { geometry?: { features?: Array<{ id?: unknown }> } }).geometry?.features ?? []).map((f) => f.id));
        const unknownFeature = x.ids.filter((id) => !feats.has(parseEntityId(id)?.feature));
        const g = this.geometry();
        const unknown = g ? x.ids.filter((id) => { const p = parseEntityId(id); if (!p) return true; const r = g.resolve(g.table, ENTITY_LIST[p.kind], [id]); return r.unknown.length > 0 || r.indices.length === 0; }) : [];
        if (unknownFeature.length || unknown.length) return fail('unknown_entities', { ids: [...new Set([...unknownFeature, ...unknown])] }, 'selection');
        const r = await this.nav.highlightSelection(x.ids, x.color);
        return r.ok ? ok({ count: x.ids.length }) : fail('ui_refused', { message: r.message ?? '' }, 'ui');
      }
      case 'set_camera': {
        const x = a as ToolInput<'set_camera'>;
        const req = x.kind === 'fit' ? { kind: 'fit' as const }
          : x.kind === 'preset' ? (x.preset ? { kind: 'preset' as const, preset: x.preset } : null)
          : (x.target ? { kind: 'look_at' as const, target: x.target as [number, number, number], ...(x.distance !== undefined ? { distance: x.distance } : {}) } : null);
        if (!req) return fail('missing_camera_argument');
        const r = await this.nav.setCamera(req);
        return r.ok ? ok({}) : fail('ui_refused', { message: r.message ?? '' }, 'ui');
      }
      case 'set_view_mode': {
        const x = a as ToolInput<'set_view_mode'>;
        const r = await this.nav.setViewMode(x.mode);
        return r.ok ? ok({ mode: x.mode }) : fail('ui_refused', { message: r.message ?? '' }, 'ui');
      }
      case 'screenshot': {
        const x = a as ToolInput<'screenshot'>;
        const s = await this.nav.screenshot(x.view);
        if (!s) return fail('screenshot_unavailable');
        return { content: [{ type: 'text', text: toolText({ ok: true, width: s.width ?? null, height: s.height ?? null }) }, { type: 'image', mediaType: s.mediaType, base64: s.base64 }], isError: false };
      }
      case 'memory_read': {
        const x = a as ToolInput<'memory_read'>;
        const t = this.memory.text(`${x.name}.md`);
        if (t === null) return fail('no_memory_file');
        this.partialMemory.delete(`${x.name}.md`);
        return ok({}, { data: { file: `${x.name}.md`, text: t }, source: 'memory' });
      }
      case 'memory_write': {
        const x = a as ToolInput<'memory_write'>;
        if (this.partialMemory.has(`${x.name}.md`)) return fail('read_full_memory_first', { hint: 'memory_read this file before rewriting it; your context showed it cut' }, 'memory');
        try {
          const op = await this.memory.write({ name: x.name, type: x.type, description: x.description, appliesWhen: x.applies_when ?? [], body: x.body }, meta(x.reason));
          this.mark('memory', op.seq);
          return ok({ log: 'memory', seq: op.seq, created: op.before === null });
        } catch (e) { return fail('memory_write_failed', { message: (e as Error).message }, 'memory-error'); }
      }
      case 'memory_delete': {
        const x = a as ToolInput<'memory_delete'>;
        try { const op = await this.memory.remove(x.name, meta(x.reason)); this.mark('memory', op.seq); return ok({ log: 'memory', seq: op.seq }); }
        catch (e) { return fail('memory_delete_failed', { message: (e as Error).message }, 'memory-error'); }
      }
    }
    return fail('unknown_tool');
  }

  private async summaryTrusted(o: StudyOutcome, h: string): Promise<Record<string, unknown>> {
    const stale = h !== (await specHash(this.log.data));
    if (!o.ok) return { runOk: false, stale, ready: o.readiness?.ready ?? null };
    const g = o.gates ?? [];
    return {
      runOk: true, stale, ready: o.readiness?.ready ?? null,
      gatesPassed: g.filter((x) => x.pass === true).length,
      gatesFailed: g.filter((x) => x.pass === false).length,
      gatesPending: g.filter((x) => x.pass === 'pending' || x.pass === 'unavailable').length,
    };
  }

  private summaryData(o: StudyOutcome): unknown {
    if (!o.ok) return { study: o.study, stage: o.stage, message: o.message, readiness: o.readiness ?? null };
    return { study: o.study, scalars: o.solution.scalars, stats: o.solution.stats, timing_ms: o.solution.timing, readiness: o.readiness ?? null, gates: o.gates ?? [], steps: o.solution.steps ?? null };
  }
}
