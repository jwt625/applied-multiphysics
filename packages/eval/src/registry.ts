// SPDX-License-Identifier: GPL-3.0-or-later
// Physics registry hook and the engine source. A case runs on the engine when its spec is available and a
// `@amp/physics` module (C4) is registered for its physics entry; otherwise it is `pending` with the reason. A
// present but broken `@amp/physics` / `@amp/post` is an `error` (audit B2). Every engine case runs in its own
// worker_threads Worker (engine-worker.ts) with a wall-clock timeout and a heap cap (audit B1). Context building is
// L4's `prepareRun` (one object argument, or `(spec, caseCtx)` when it declares two parameters); sampling is
// `@amp/post` `sample(solution, field, points, {mesh, component})` with the level's mesh kept next to its Solution
// (audit B5). Targets are looked up by `metric_id` only (audit B3).

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PhysicsModule, RunContext, Solution } from './contract-shim.ts';
import type { Spec } from './contract-shim.ts';
import type { EvalCase, LoadedCase, Reference } from './loader.ts';
import { targetId } from './loader.ts';
import type { LevelObservation, TargetObservation } from './evaluate.ts';
import { REPO_ROOT } from './node-io.ts';
import { dimOf, type CaseObservation, type ObserveOptions, type Source, type SpeedRecord } from './source.ts';
import { Worker } from 'node:worker_threads';
import { importWorkspace } from './workspace.ts';

export interface PrepareArgs { case: EvalCase; spec: Spec; physicsId: string; level: number; hFactor: number; signal: AbortSignal }
export type PrepareFn = ((args: PrepareArgs) => Promise<RunContext>) | ((spec: Spec, caseCtx: Omit<PrepareArgs, 'spec'>) => Promise<RunContext>);

/** Call prepareRun in either form: `(args)` (one object) or `(spec, caseCtx)` (two parameters, contract changelog 16:0x). */
export function callPrepare(prep: PrepareFn, a: PrepareArgs): Promise<RunContext> {
  if (prep.length >= 2) { const { spec, ...rest } = a; return (prep as (s: Spec, c: Omit<PrepareArgs, 'spec'>) => Promise<RunContext>)(spec, rest); }
  return (prep as (x: PrepareArgs) => Promise<RunContext>)(a);
}

export interface Registry {
  modules: Map<string, PhysicsModule>;
  prepare: PrepareFn | null;
  specRegistry?: unknown;   // @amp/spec Registry exported by @amp/physics (specRegistry), else the provisional wave-1 one
  origin: string;          // where the modules came from
  version: string;
  loadError?: string;      // present but broken @amp/physics or @amp/post (audit B2)
  sample?: SampleFn;       // @amp/post sample
  resultNames?: Record<string, { fields: string[]; scalars: string[] }>;
}
export type SampleFn = (sol: Solution, field: string, points: number[][], o?: { mesh?: unknown; component?: number }) => ArrayLike<number>;

export function emptyRegistry(origin = 'none'): Registry {
  return { modules: new Map(), prepare: null, origin, version: '0.0.0' };
}

export function registerModule(reg: Registry, m: PhysicsModule): void {
  reg.modules.set(m.type, m);
}

function isModule(x: unknown): x is PhysicsModule {
  return !!x && typeof x === 'object' && typeof (x as PhysicsModule).type === 'string' && typeof (x as PhysicsModule).run === 'function';
}

/** Accepts `modules: PhysicsModule[]`, `registry: Map | Record`, or named PhysicsModule exports. */
export function registryFromExports(ex: Record<string, unknown>, origin: string, version: string): Registry {
  const reg = emptyRegistry(origin);
  reg.version = version;
  const add = (x: unknown) => { if (isModule(x)) registerModule(reg, x); };
  if (Array.isArray(ex.modules)) ex.modules.forEach(add);
  const r = ex.registry;
  if (r instanceof Map) r.forEach(add);
  else if (r && typeof r === 'object' && typeof (r as { get?: unknown }).get !== 'function') Object.values(r).forEach(add);
  for (const v of Object.values(ex)) add(v);
  const prep = ex.prepareRun ?? ex.buildRunContext;
  if (typeof prep === 'function') reg.prepare = prep as PrepareFn;
  // @amp/spec Registry (register/get/list): `specRegistry`, or `registry` when it is a spec Registry rather than a module map
  const isSpecReg = (x: unknown) => !!x && typeof x === 'object' && typeof (x as { get?: unknown }).get === 'function' && typeof (x as { list?: unknown }).list === 'function' && typeof (x as { register?: unknown }).register === 'function';
  if (isSpecReg(ex.specRegistry)) reg.specRegistry = ex.specRegistry;
  else if (isSpecReg(r)) reg.specRegistry = r;
  else if (typeof ex.physicsRegistry === 'function') {
    // L4: physicsRegistry() builds the @amp/spec Registry with L4's registrations over the provisional wave-1 seed
    try { const pr = (ex.physicsRegistry as () => unknown)(); if (isSpecReg(pr)) reg.specRegistry = pr; } catch { /* left to the provisional registry */ }
  }
  // L4: RESULT_NAMES[type] = {fields, scalars}; '<x>' segments are wildcards (e.g. 'C_<i>_<j>')
  if (ex.RESULT_NAMES && typeof ex.RESULT_NAMES === 'object') reg.resultNames = ex.RESULT_NAMES as Record<string, { fields: string[]; scalars: string[] }>;
  return reg;
}

export async function loadDefaultRegistry(root = REPO_ROOT): Promise<{ registry: Registry; reason: string }> {
  const r = await importWorkspace('@amp/physics', root);
  let registry: Registry;
  if (!r.mod) {
    registry = emptyRegistry('@amp/physics unavailable');
    if (!r.absent) registry.loadError = r.reason;
  } else registry = registryFromExports(r.mod, `@amp/physics (${r.path})`, r.version ?? '0.0.0');
  const post = await importWorkspace<{ sample?: SampleFn }>('@amp/post', root);
  if (post.mod && typeof post.mod.sample === 'function') registry.sample = post.mod.sample;
  else if (!post.absent) registry.loadError = [registry.loadError, post.mod ? '@amp/post: no sample export' : post.reason].filter(Boolean).join('; ');
  return { registry, reason: registry.loadError ?? (r.mod ? 'ok' : r.reason) };
}

// ---- @amp/spec runtime (spec parsing / validation, affine-aware units), loaded lazily by file path ------------
interface SpecRuntime {
  parseSpecText(text: string, reg: unknown): { ok: boolean; spec: Spec | null; issues: Array<{ line?: number; col?: number; dotted: string; message: string }> };
  validateSpec(data: unknown, reg: unknown): { ok: boolean; spec: Spec | null; issues: Array<{ dotted: string; message: string }> };
  formatIssues(issues: unknown[]): string;
  units: { parseUnit(src: string): { dim: number[]; factor: number; offset: number }; dimEq(a: readonly number[], b: readonly number[]): boolean };
}
let specRt: { rt: SpecRuntime | null; reason: string; registry: unknown; root?: string } | null = null;
export async function specRuntime(root = REPO_ROOT, physicsRegistry?: unknown): Promise<{ rt: SpecRuntime | null; reason: string; registry: unknown }> {
  if (specRt && specRt.root === root) return specRt;
  unitsApi = null;
  const r = await importWorkspace<SpecRuntime>('@amp/spec', root);
  if (!r.mod) { specRt = { rt: null, reason: r.reason, registry: null, root }; return specRt; }
  let registry = physicsRegistry ?? null;
  if (!registry) {
    const pv = await importWorkspace<{ wave1Registry?: () => unknown }>('@amp/spec/provisional', root);
    registry = pv.mod?.wave1Registry?.() ?? null;
  }
  specRt = { rt: r.mod, reason: registry ? 'ok' : '@amp/spec registry unavailable', registry, root };
  return specRt;
}
/** for tests */
export function resetSpecRuntime(): void { specRt = null; }

const DIMLESS = new Set(['', '1', '-', 'dimensionless']);
let unitsApi: SpecRuntime['units'] | null = null;
export function setUnitsApi(u: SpecRuntime['units'] | null): void { unitsApi = u; }

/** Convert a value from unit `from` to unit `to`: equal strings, dimensionless aliases, or @amp/spec units (affine degC). */
export function convertUnit(value: number, from: string | undefined, to: string): { value: number } | { error: string } {
  const a = (from ?? '').trim(), b = to.trim();
  if (a === b || (DIMLESS.has(a) && DIMLESS.has(b))) return { value };
  if (!unitsApi) return { error: `unit mismatch: '${a}' vs '${b}' (no unit converter loaded)` };
  try {
    const ua = unitsApi.parseUnit(DIMLESS.has(a) ? '1' : a), ub = unitsApi.parseUnit(DIMLESS.has(b) ? '1' : b);
    if (!unitsApi.dimEq(ua.dim, ub.dim)) return { error: `unit mismatch: '${a}' and '${b}' have different dimensions` };
    return { value: (value * ua.factor + ua.offset - ub.offset) / ub.factor };
  } catch (e) { return { error: `unit conversion '${a}' -> '${b}': ${(e as Error).message}` }; }
}

/** Read one target value from a Solution (C5) by metric_id (audit B3); probe / field through @amp/post `sample`. */
export function extractFromSolution(
  sol: Solution, r: Reference, o: { mesh?: unknown; sample?: SampleFn; points?: number[][] } = {},
): { value: number | number[] | { values: number[] } } | { pending: string } | { error: string } {
  const ex = r.extract ?? { kind: 'scalar' as const };
  const conv = (v: number, from: string | undefined): number | { error: string } => { const c = convertUnit(v, from, r.unit); return 'error' in c ? c : c.value; };
  if (ex.kind === 'scalar') {
    const name = ex.name ?? r.metric_id;
    if (!name) return { pending: 'no metric_id: targets are looked up by metric_id only' };
    const s = sol.scalars?.[name];
    if (!s) return { pending: `module produced no metric '${name}' (has: ${Object.keys(sol.scalars ?? {}).join(', ') || 'none'})` };
    const v = conv(s.value, s.unit);
    return typeof v === 'number' ? { value: v } : v;
  }
  if (ex.kind === 'eigen' || ex.kind === 'steps') {
    if (!sol.steps) return { error: 'Solution.steps absent' };
    if (ex.kind === 'eigen' && sol.steps.kind !== 'eigen') return { error: `Solution.steps.kind is '${sol.steps.kind}', not 'eigen'` };
    const out: number[] = [];
    for (const v of sol.steps.values) { const c = conv(v, sol.steps.unit); if (typeof c !== 'number') return c; out.push(c); }
    return { value: out };
  }
  // probe / field: values at points from @amp/post, with the level's mesh
  if (!o.sample) return { pending: `extract kind '${ex.kind}' needs @amp/post sample (not available)` };
  const field = ex.field ?? ex.name;
  if (!field) return { error: `extract kind '${ex.kind}' needs field` };
  const pts = ex.kind === 'probe' ? (ex.point ? [ex.point] : null) : (o.points ?? ex.points ?? null);
  if (!pts) return { error: `extract kind '${ex.kind}' has no sample points` };
  const fd = sol.fields?.find((f) => f.name === field);
  if (!fd) return { pending: `module produced no field '${field}' (has: ${(sol.fields ?? []).map((f) => f.name).join(', ') || 'none'})` };
  let vals: ArrayLike<number>;
  try { vals = o.sample(sol, field, pts, { ...(o.mesh !== undefined ? { mesh: o.mesh } : {}), ...(ex.component !== undefined ? { component: ex.component } : {}) }); }
  catch (e) { return { error: `sample(${field}): ${(e as Error).message}` }; }
  const out: number[] = [];
  for (const v of Array.from(vals)) { const c = Number.isFinite(v) ? conv(v, fd.unit) : v; if (typeof c !== 'number') return c; out.push(c); }
  return ex.kind === 'probe' ? { value: out[0]! } : { value: { values: out } };
}

const ISO_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?([+-]\d{2}:\d{2}|Z)$/;
/** C5 / A5 run-record check (audit S4): required keys and formats; returns the problems. */
export function checkRunRecord(run: unknown, meshHash?: string): string[] {
  const p: string[] = [];
  const r = (run ?? {}) as Record<string, unknown>;
  for (const k of ['engine', 'specHash', 'meshHash']) if (typeof r[k] !== 'string' || !(r[k] as string).length) p.push(`${k} missing`);
  if (typeof r.startedAt !== 'string' || !ISO_OFFSET.test(r.startedAt)) p.push('startedAt not ISO 8601 with offset');
  const pl = r.platform as { runtime?: unknown } | undefined;
  if (!pl || (pl.runtime !== 'node' && pl.runtime !== 'browser')) p.push('platform.runtime missing');
  if (r.fidelity !== 'rigorous' && r.fidelity !== 'realtime') p.push('fidelity not rigorous | realtime');
  if (meshHash !== undefined && typeof r.meshHash === 'string' && r.meshHash !== meshHash) p.push(`run.meshHash ${r.meshHash} != Solution.meshHash ${meshHash}`);
  return p;
}

export function hFactorsFor(c: EvalCase): number[] {
  const conv = c.convergence;
  if (conv?.h_factors?.length) return conv.h_factors;
  const n = Math.max(1, conv?.levels_min ?? 1);
  const ratio = Math.max(conv?.ratio_min ?? 2, 1.5);
  return Array.from({ length: n }, (_, i) => Math.pow(ratio, -i));
}

async function resolveSpec(c: EvalCase, root: string, physicsRegistry: unknown): Promise<{ spec: Spec } | { pending: string } | { error: string }> {
  const s = c.spec;
  if (s && typeof s === 'object' && 'status' in s && s.status === 'pending') return { pending: `spec pending: ${s.reason}` };
  const { rt, reason, registry } = await specRuntime(root, physicsRegistry);
  if (!rt || !registry) return { pending: `@amp/spec not loadable (${reason})` };
  unitsApi ??= rt.units;
  if (typeof s === 'string') {
    const p = join(root, s);
    if (!existsSync(p)) return { error: `spec file ${s} not found` };
    const r = rt.parseSpecText(readFileSync(p, 'utf8'), registry);
    if (!r.ok || !r.spec) return { error: `spec ${s}: ${rt.formatIssues(r.issues).split('\n').slice(0, 5).join(' | ')}` };
    return { spec: r.spec };
  }
  if (s && typeof s === 'object') {
    const r = rt.validateSpec(s, registry);
    if (!r.ok || !r.spec) return { error: `embedded spec: ${rt.formatIssues(r.issues).split('\n').slice(0, 5).join(' | ')}` };
    return { spec: r.spec };
  }
  return { error: 'spec missing' };
}

function physicsEntries(spec: Spec): Array<{ id: string; type: string }> {
  const ph = (spec as { physics?: unknown }).physics;
  if (!Array.isArray(ph)) return [];
  return ph.filter((p) => p && typeof p === 'object').map((p) => ({ id: String((p as { id?: unknown }).id ?? ''), type: String((p as { type?: unknown }).type ?? '') }));
}

export interface EngineOptions { timeoutS?: number; timeoutCapS?: number; maxOldMb?: number }

/** Wall-clock limit of a case (audit B1): 20 x budget_s (native, else browser) per level, at least 30 s per level,
 *  60 s per level without a budget; x 7 runs per level with --speed; capped (default 600 s); --timeout overrides. */
export function caseTimeoutMs(c: EvalCase, levels: number, speed: boolean, o: EngineOptions = {}): number {
  if (o.timeoutS !== undefined) return o.timeoutS * 1000;
  const b = c.speed?.budget_s?.native ?? c.speed?.budget_s?.browser ?? null;
  const per = b ? Math.max(30, 20 * b) : 60;
  return Math.min(per * levels * (speed ? 7 : 1), o.timeoutCapS ?? 600) * 1000;
}

export interface WorkerTarget { tid: string; ref: Reference; points?: number[][] }
export interface WorkerResult {
  ok: true;
  targets: Record<string, TargetObservation | { pending: string } | { error: string }>;
  levels: Array<{ level: number; hFactor: number; dof: number; meshHash: string; run: unknown; wall_ms: number; stages: Record<string, number>; iterations?: number }>;
  speed?: SpeedRecord;
}

export class EngineSource implements Source {
  name = 'engine';
  reg: Registry;
  regReason: string;
  root: string;
  opts: EngineOptions;
  constructor(reg: Registry, regReason = 'ok', root = REPO_ROOT, opts: EngineOptions = {}) { this.reg = reg; this.regReason = regReason; this.root = root; this.opts = opts; }

  describe(): string {
    const types = [...this.reg.modules.keys()];
    return `engine: ${this.reg.origin}; modules: ${types.join(', ') || 'none'}${this.regReason !== 'ok' ? ` (${this.regReason})` : ''}; prepare: ${this.reg.prepare ? 'yes' : 'no'}; sample: ${this.reg.sample ? 'yes' : 'no'}; isolation: worker per case`;
  }

  private async select(lc: LoadedCase): Promise<{ module: PhysicsModule; spec: Spec; physicsId: string } | { pending: string } | { error: string }> {
    const c = lc.data!;
    if (this.reg.loadError) return { error: `engine load failed: ${this.reg.loadError}` };
    if (c.spec && typeof c.spec === 'object' && 'status' in c.spec && c.spec.status === 'pending') return { pending: `spec pending: ${c.spec.reason}` };
    if (!this.reg.modules.size) return { pending: `no physics modules registered (${this.regReason})` };
    const rs = await resolveSpec(c, this.root, this.reg.specRegistry);
    if (!('spec' in rs)) return rs;
    const entries = physicsEntries(rs.spec);
    if (!entries.length) return { error: 'spec has no physics entries' };
    if (entries.length > 1) return { pending: `spec has ${entries.length} physics entries; multiphysics orchestration is not wired in the harness` };
    const e = entries[0]!;
    const m = this.reg.modules.get(e.type);
    if (!m) return { pending: `no physics module registered for '${e.type}' (registered: ${[...this.reg.modules.keys()].join(', ')})` };
    const rd = m.readiness(rs.spec, e.id);
    if (!rd.ready) return { pending: `module '${e.type}' not ready: ${rd.reasons.join('; ')}` };
    if (!this.reg.prepare) return { pending: `module '${e.type}' registered but no prepareRun hook to build the RunContext (mesh)` };
    return { module: m, spec: rs.spec, physicsId: e.id };
  }

  async plan(lc: LoadedCase): Promise<{ runnable: boolean; reason: string; error?: boolean }> {
    const s = await this.select(lc);
    if ('module' in s) return { runnable: true, reason: `run '${s.module.type}' on ${hFactorsFor(lc.data!).length} level(s) in a worker` };
    return 'pending' in s ? { runnable: false, reason: s.pending } : { runnable: false, reason: s.error, error: true };
  }

  async observe(lc: LoadedCase, opts: ObserveOptions): Promise<CaseObservation> {
    const c = lc.data!;
    const s = await this.select(lc);
    if ('pending' in s) return { kind: 'pending', reason: s.pending };
    if ('error' in s) return { kind: 'error', reason: s.error };
    const factors = hFactorsFor(c);
    const targets: WorkerTarget[] = [];
    const pre: Record<string, { pending: string }> = {};
    const rn = this.reg.resultNames?.[s.module.type];
    const known = (names: string[], x: string) => names.some((n) => new RegExp(`^${n.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/<[^>]+>/g, '[^_]+')}$`).test(x));
    for (const r of c.references) {
      if (!r.metric_id && !r.extract?.name) { pre[targetId(r)] = { pending: 'no metric_id: targets are looked up by metric_id only' }; continue; }
      // B3: the metric must be one the module declares (RESULT_NAMES), else pending with the reason
      const kind = r.extract?.kind ?? 'scalar';
      if (rn && (kind === 'scalar' || kind === 'probe' || kind === 'field')) {
        const name = kind === 'scalar' ? (r.extract?.name ?? r.metric_id!) : (r.extract?.field ?? r.extract?.name ?? '');
        const list = kind === 'scalar' ? rn.scalars : rn.fields;
        if (!known(list, name)) { pre[targetId(r)] = { pending: `module '${s.module.type}' does not produce ${kind === 'scalar' ? 'scalar' : 'field'} '${name}' (declares: ${list.join(', ') || 'none'})` }; continue; }
      }
      const pts = r.extract?.kind === 'field' ? (r.extract.points ?? samplePoints(lc.expected, r.extract.samples_key)) : undefined;
      targets.push({ tid: targetId(r), ref: r, ...(pts ? { points: pts } : {}) });
    }
    const timeoutMs = caseTimeoutMs(c, factors.length, !!opts.speed, this.opts);
    opts.log?.(`${c.id}: worker, ${factors.length} level(s), timeout ${(timeoutMs / 1000).toFixed(0)} s, heap cap ${this.opts.maxOldMb ?? 1536} MB`);
    const res = await runWorker({ root: this.root, caseData: c, spec: s.spec, physicsId: s.physicsId, type: s.module.type, factors, speed: !!opts.speed, targets, timeoutMs }, timeoutMs, this.opts.maxOldMb ?? 1536);
    if (res.kind === 'timeout') { opts.log?.(`${c.id}: TIMEOUT after ${(timeoutMs / 1000).toFixed(1)} s, worker terminated`); return { kind: 'timeout', reason: `timeout after ${(timeoutMs / 1000).toFixed(1)} s (worker terminated)` }; }
    if (res.kind === 'error') { opts.log?.(`${c.id}: ${res.reason}`); return { kind: 'error', reason: res.reason }; }
    const w = res.result;
    // S4: run record of every level
    const rrProblems = w.levels.flatMap((l) => checkRunRecord(l.run, l.meshHash).map((p) => `level ${l.level + 1}: ${p}`));
    if (rrProblems.length) return { kind: 'error', reason: `run record invalid (A5/C5): ${rrProblems.slice(0, 4).join('; ')}` };
    const dim = dimOf(c.dimension);
    return {
      kind: 'observed', targets: { ...pre, ...w.targets }, run: w.levels[w.levels.length - 1]!.run as Record<string, unknown>,
      levelRuns: w.levels.map((l) => ({ level: l.level, dof: l.dof, meshHash: l.meshHash, wall_ms: l.wall_ms })),
      ...(dim !== undefined ? { dim } : {}), ...(w.speed ? { speed: w.speed } : {}),
    };
  }
}

function samplePoints(expected: unknown, key: string | undefined): number[][] | undefined {
  if (!key) return undefined;
  let cur: unknown = expected;
  for (const part of key.split('.')) cur = cur && typeof cur === 'object' ? (cur as Record<string, unknown>)[part] : undefined;
  const pts = (cur as { points?: unknown } | undefined)?.points;
  return Array.isArray(pts) ? (pts as number[][]) : undefined;
}

/** Run one case in a Worker. A hang, a busy loop or a never-settling promise ends as `timeout` or `error`. */
export function runWorker(data: Record<string, unknown>, timeoutMs: number, maxOldMb: number): Promise<{ kind: 'result'; result: WorkerResult } | { kind: 'timeout' } | { kind: 'error'; reason: string }> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: Parameters<typeof resolve>[0]) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
    const w = new Worker(new URL('./engine-worker.ts', import.meta.url), { workerData: data, resourceLimits: { maxOldGenerationSizeMb: maxOldMb } });
    const timer = setTimeout(() => { void w.terminate(); finish({ kind: 'timeout' }); }, timeoutMs);
    w.on('message', (m: WorkerResult | { ok: false; error: string }) => {
      finish(m.ok ? { kind: 'result', result: m } : { kind: 'error', reason: m.error });
      void w.terminate();
    });
    w.on('error', (e: Error & { code?: string }) => finish({ kind: 'error', reason: e.code === 'ERR_WORKER_OUT_OF_MEMORY' ? `out of memory (heap cap ${maxOldMb} MB)` : `worker error: ${e.message}` }));
    w.on('exit', (code) => finish({ kind: 'error', reason: `worker exited (code ${code}) without a result: a never-settling promise or an exit inside the module` }));
  });
}
