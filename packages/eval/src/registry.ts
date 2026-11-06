// SPDX-License-Identifier: GPL-3.0-or-later
// Physics registry hook and the engine source. A case runs on the engine when its spec is available and a
// `@amp/physics` module (C4) is registered for every physics entry; otherwise it is recorded as `pending` with the
// reason. Context building (geometry -> mesh -> RunContext) is delegated to a `prepare` hook supplied by
// `@amp/physics` (export `prepareRun`) or by the caller; the harness has no physics or meshing of its own.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PhysicsModule, RunContext, Solution } from './contract-shim.ts';
import type { Spec } from '../../spec/src/types/index.ts';
import type { EvalCase, LoadedCase, Reference } from './loader.ts';
import { targetId } from './loader.ts';
import type { LevelObservation, TargetObservation } from './evaluate.ts';
import { REPO_ROOT } from './node-io.ts';
import { dimOf, type CaseObservation, type ObserveOptions, type Source, type SpeedRecord } from './source.ts';
import { timeRuns } from './speed.ts';
import { importWorkspace } from './workspace.ts';

export interface PrepareArgs { case: EvalCase; spec: Spec; physicsId: string; level: number; hFactor: number; signal: AbortSignal }
export type PrepareFn = (args: PrepareArgs) => Promise<RunContext>;

export interface Registry {
  modules: Map<string, PhysicsModule>;
  prepare: PrepareFn | null;
  specRegistry?: unknown;   // @amp/spec Registry exported by @amp/physics (specRegistry), else the provisional wave-1 one
  origin: string;          // where the modules came from
  version: string;
}

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
  return reg;
}

export async function loadDefaultRegistry(root = REPO_ROOT): Promise<{ registry: Registry; reason: string }> {
  const r = await importWorkspace('@amp/physics', root);
  if (!r.mod) return { registry: emptyRegistry('@amp/physics unavailable'), reason: r.reason };
  return { registry: registryFromExports(r.mod, `@amp/physics (${r.path})`, r.version ?? '0.0.0'), reason: 'ok' };
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

/** Read one target value from a Solution (C5). */
export function extractFromSolution(sol: Solution, r: Reference): { value: number | number[] } | { pending: string } | { error: string } {
  const ex = r.extract ?? { kind: 'scalar' as const };
  if (ex.kind === 'scalar') {
    const name = ex.name ?? r.quantity;
    const s = sol.scalars?.[name];
    if (!s) return { error: `Solution.scalars has no '${name}' (has: ${Object.keys(sol.scalars ?? {}).join(', ') || 'none'})` };
    const cv = convertUnit(s.value, s.unit, r.unit);
    return 'error' in cv ? cv : { value: cv.value };
  }
  if (ex.kind === 'eigen' || ex.kind === 'steps') {
    if (!sol.steps) return { error: 'Solution.steps absent' };
    if (ex.kind === 'eigen' && sol.steps.kind !== 'eigen') return { error: `Solution.steps.kind is '${sol.steps.kind}', not 'eigen'` };
    const out: number[] = [];
    for (const v of sol.steps.values) {
      const cv = convertUnit(v, sol.steps.unit, r.unit);
      if ('error' in cv) return cv;
      out.push(cv.value);
    }
    return { value: out };
  }
  return { pending: `extract kind '${ex.kind}' needs a probe / sampling hook (@amp/post), not wired yet` };
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

export class EngineSource implements Source {
  name = 'engine';
  reg: Registry;
  regReason: string;
  root: string;
  constructor(reg: Registry, regReason = 'ok', root = REPO_ROOT) { this.reg = reg; this.regReason = regReason; this.root = root; }

  describe(): string {
    const types = [...this.reg.modules.keys()];
    return `engine: ${this.reg.origin}; modules: ${types.join(', ') || 'none'}${this.regReason !== 'ok' ? ` (${this.regReason})` : ''}; prepare: ${this.reg.prepare ? 'yes' : 'no'}`;
  }

  private async select(lc: LoadedCase): Promise<{ module: PhysicsModule; spec: Spec; physicsId: string } | { pending: string } | { error: string }> {
    const c = lc.data!;
    if (c.spec && typeof c.spec === 'object' && 'status' in c.spec && c.spec.status === 'pending') return { pending: `spec pending: ${c.spec.reason}` };
    if (!this.reg.modules.size) return { pending: `no physics modules registered (${this.regReason})` };
    const rs = await resolveSpec(c, this.root, this.reg.specRegistry);
    if (!('spec' in rs)) return rs;
    const entries = physicsEntries(rs.spec);
    if (!entries.length) return { error: 'spec has no physics entries' };
    if (entries.length > 1) return { pending: `spec has ${entries.length} physics entries; multiphysics orchestration is not wired in the harness` };
    const e = entries[0]!;
    const m = this.reg.modules.get(e.type);
    if (!m) return { pending: `no physics module registered for '${e.type}' (${this.reg.modules.size ? `registered: ${[...this.reg.modules.keys()].join(', ')}` : this.regReason})` };
    const rd = m.readiness(rs.spec, e.id);
    if (!rd.ready) return { pending: `module '${e.type}' not ready: ${rd.reasons.join('; ')}` };
    if (!this.reg.prepare) return { pending: `module '${e.type}' registered but no prepareRun hook to build the RunContext (mesh)` };
    return { module: m, spec: rs.spec, physicsId: e.id };
  }

  async plan(lc: LoadedCase): Promise<{ runnable: boolean; reason: string }> {
    const s = await this.select(lc);
    if ('module' in s) return { runnable: true, reason: `run '${s.module.type}' on ${hFactorsFor(lc.data!).length} level(s)` };
    return { runnable: false, reason: 'pending' in s ? s.pending : `error: ${s.error}` };
  }

  async observe(lc: LoadedCase, opts: ObserveOptions): Promise<CaseObservation> {
    const c = lc.data!;
    const s = await this.select(lc);
    if ('pending' in s) return { kind: 'pending', reason: s.pending };
    if ('error' in s) return { kind: 'error', reason: s.error };
    const signal = opts.signal ?? new AbortController().signal;
    const factors = hFactorsFor(c);
    const sols: Array<{ sol: Solution; wall_ms: number }> = [];
    const runLevel = async (level: number): Promise<{ sol: Solution; wall_ms: number }> => {
      const t0 = performance.now();
      const ctx = await this.reg.prepare!({ case: c, spec: s.spec, physicsId: s.physicsId, level, hFactor: factors[level]!, signal });
      const sol = await s.module.run(ctx);
      return { sol, wall_ms: performance.now() - t0 };
    };
    try {
      for (let i = 0; i < factors.length; i++) {
        opts.log?.(`${c.id}: level ${i + 1}/${factors.length} (h factor ${factors[i]})`);
        sols.push(await runLevel(i));
      }
    } catch (e) {
      return { kind: 'error', reason: `run failed: ${(e as Error).message}` };
    }
    const targets: Record<string, TargetObservation | { pending: string } | { error: string }> = {};
    for (const r of c.references) {
      const levels: LevelObservation[] = [];
      let bad: { pending: string } | { error: string } | null = null;
      for (const { sol, wall_ms } of sols) {
        const ex = extractFromSolution(sol, r);
        if (!('value' in ex)) { bad = ex; break; }
        levels.push({ value: ex.value, dof: sol.stats.dof, wall_ms, stages: sol.timing, ...(sol.stats.iterations !== undefined ? { iterations: sol.stats.iterations } : {}) });
      }
      targets[targetId(r)] = bad ?? { levels };
    }
    let speed: SpeedRecord | undefined;
    if (opts.speed) {
      const last = factors.length - 1;
      const t = await timeRuns(async () => (await runLevel(last)).sol, { warmup: 1, repeats: 5 });
      const sol = t.last;
      speed = {
        level: last, dof: sol.stats.dof, warmup_ms: t.summary.warmup_ms, samples_ms: t.summary.samples_ms,
        median_ms: t.summary.median_ms, mad_ms: t.summary.mad_ms, stages_median_ms: t.summary.stages_median_ms,
        iterations: sol.stats.iterations ?? null,
        ...(c.speed?.budget_s?.native !== undefined ? { budget_s: c.speed.budget_s.native } : {}),
      };
    }
    const dim = dimOf(c.dimension);
    return { kind: 'observed', targets, run: sols[sols.length - 1]!.sol.run, ...(dim !== undefined ? { dim } : {}), ...(speed ? { speed } : {}) };
  }
}
