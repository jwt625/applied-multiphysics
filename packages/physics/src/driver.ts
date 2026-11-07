// SPDX-License-Identifier: GPL-3.0-or-later
// Study driver (C11, DevLog-031): runs every physics of a study on the shared study mesh, in topological order of the
// spec couplings. Sequential couplings map the upstream solution into `RunContext.inputs` of the downstream physics
// (CouplingImpl.map); a monolithic coupling solves its two physics as one group (CouplingImpl.run). The merged
// Solution tags each field with its physics id, keys scalars `<physics id>.<name>` (and also by bare name when that
// name is unique), keys module stage times `<physics id>.<stage>` (stage sums and the shared prepare stages unprefixed),
// sums stats (per physics in stats.byPhysics) and carries one run record. A study with one physics and no coupling is
// the plain module run (same Solution object).

import type { CoupledInput, CouplingNode, FieldData, PhysicsModule, RunContext, Solution, Spec, StudyNode } from '@amp/spec/types';
import { isoNow } from '@amp/spec';
import { COUPLINGS, COUPLING_NEEDS, couplingImpl, type CouplingImpl } from './couplings/index.ts';
import { specReadiness } from './common/ctx.ts';
import { attachMesh, checkAbort } from './common/solution.ts';

type SolutionExt = Solution & { notes?: string[]; normalization?: string };

let defaultModules: Record<string, PhysicsModule> = {};
/** Set the module registry used when runStudy / studyReadiness get no `modules` (done by @amp/physics index.ts). */
export function useModules(reg: Record<string, PhysicsModule>): void { defaultModules = reg; }

export interface StudyOptions {
  /** study id (default: prep.study for runStudy, the first study for studyReadiness) */
  studyId?: string;
  /** physics modules by type (default: the @amp/physics registry) */
  modules?: Record<string, PhysicsModule>;
  /** coupling implementations (default: core + photonic + two-way) */
  couplings?: readonly CouplingImpl[];
}
export interface RunStudyOptions extends StudyOptions {
  progress?: RunContext['progress'];
  signal?: AbortSignal;
}

export interface StudyGroup { ids: string[]; coupling?: CouplingNode }
export interface StudyPlan {
  study: StudyNode | null;
  /** physics ids the study solves */
  physics: string[];
  /** solve order: single physics, or the two physics of a monolithic coupling */
  groups: StudyGroup[];
  /** sequential couplings between physics of the study */
  edges: CouplingNode[];
  reasons: string[];
}

const physType = (spec: Spec, id: string) => (spec.physics ?? []).find((p) => p.id === id)?.type;

/** Order and checks of a study's physics and couplings (no module readiness). */
export function planStudy(spec: Spec, studyId?: string, o: StudyOptions & { physicsId?: string } = {}): StudyPlan {
  const reasons: string[] = [];
  const studies = (spec.studies ?? []) as StudyNode[];
  const study = studyId !== undefined ? studies.find((s) => s.id === studyId) ?? null : studies[0] ?? null;
  if (!study) return { study: null, physics: [], groups: [], edges: [], reasons: [studyId !== undefined ? `no study '${studyId}' in the spec` : 'no study in the spec'] };
  const listed = (study as { physics?: string[] }).physics;
  const physics = listed?.length ? [...listed] : o.physicsId ? [o.physicsId] : [];
  if (!physics.length) reasons.push(`study '${study.id}' lists no physics`);
  for (const pid of physics) if (!physType(spec, pid)) reasons.push(`physics '${pid}' not in the spec`);
  const impls = o.couplings ?? COUPLINGS;
  const inStudy = new Set(physics);
  const nodes = ((spec as { couplings?: CouplingNode[] }).couplings ?? []).filter((c) => inStudy.has(c.to));
  const edges: CouplingNode[] = [];
  const mono: CouplingNode[] = [];
  for (const c of nodes) {
    const impl = couplingImpl(c.type, impls);
    if (!inStudy.has(c.from)) { reasons.push(`coupling '${c.id}' (${c.type}): physics '${c.from}' is not solved by study '${study.id}'`); continue; }
    if (!impl) { reasons.push(`coupling '${c.id}': no implementation of coupling type '${c.type}' in @amp/physics`); continue; }
    const ft = physType(spec, c.from), tt = physType(spec, c.to);
    if (ft !== impl.from || tt !== impl.to) { reasons.push(`coupling '${c.id}' (${c.type}) needs ${impl.from} -> ${impl.to}, got ${ft} -> ${tt}`); continue; }
    if (impl.kind === 'monolithic') { if (!impl.run) reasons.push(`coupling '${c.id}' (${c.type}): monolithic implementation has no run()`); else mono.push(c); }
    else if (!impl.map) reasons.push(`coupling '${c.id}' (${c.type}): sequential implementation has no map()`);
    else edges.push(c);
  }
  // groups: monolithic couplings join their two physics
  const groupOf = new Map<string, StudyGroup>();
  const groups: StudyGroup[] = [];
  for (const c of mono) {
    if (groupOf.has(c.from) || groupOf.has(c.to)) { reasons.push(`coupling '${c.id}': a physics in more than one monolithic coupling is not supported`); continue; }
    const g: StudyGroup = { ids: [c.from, c.to], coupling: c };
    groupOf.set(c.from, g); groupOf.set(c.to, g); groups.push(g);
  }
  for (const pid of physics) if (!groupOf.has(pid)) { const g: StudyGroup = { ids: [pid] }; groupOf.set(pid, g); groups.push(g); }
  for (const e of edges) if (groupOf.get(e.from) === groupOf.get(e.to)) reasons.push(`coupling '${e.id}': sequential coupling inside the monolithic group of '${e.from}' and '${e.to}'`);
  // Kahn order over groups; ties in study order
  const rank = (g: StudyGroup) => Math.min(...g.ids.map((id) => physics.indexOf(id)));
  const indeg = new Map<StudyGroup, number>(groups.map((g) => [g, 0]));
  for (const e of edges) { const a = groupOf.get(e.from)!, b = groupOf.get(e.to)!; if (a !== b) indeg.set(b, indeg.get(b)! + 1); }
  const order: StudyGroup[] = [];
  const ready = groups.filter((g) => indeg.get(g) === 0);
  while (ready.length) {
    ready.sort((a, b) => rank(a) - rank(b));
    const g = ready.shift()!;
    order.push(g);
    for (const e of edges) {
      const a = groupOf.get(e.from)!, b = groupOf.get(e.to)!;
      if (a !== g || a === b) continue;
      indeg.set(b, indeg.get(b)! - 1);
      if (indeg.get(b) === 0) ready.push(b);
    }
  }
  if (order.length < groups.length) reasons.push(`couplings form a cycle among ${groups.filter((g) => !order.includes(g)).flatMap((g) => g.ids).join(', ')} (sequential couplings must be acyclic; two-way couplings are monolithic)`);
  return { study, physics, groups: order.length === groups.length ? order : groups, edges, reasons };
}

/** Readiness of a whole study: module readiness of each physics, coupling implementations and order, coupling property needs. */
export function studyReadiness(spec: Spec, studyId?: string, o: StudyOptions & { physicsId?: string } = {}): { ready: boolean; reasons: string[]; order: string[] } {
  const plan = planStudy(spec, studyId, o);
  const mods = o.modules ?? defaultModules;
  const reasons = [...plan.reasons];
  // physics of a monolithic group are assembled by the coupling (e.g. piezo: stiffness tensor C instead of E, nu;
  // electrodes instead of a terminal), so the single-module readiness does not apply to them
  const inMono = new Set(plan.groups.filter((g) => g.coupling).flatMap((g) => g.ids));
  for (const pid of plan.physics) {
    const t = physType(spec, pid);
    if (!t || inMono.has(pid)) continue;
    const mod = mods[t];
    if (!mod) { reasons.push(`no @amp/physics module registered for type '${t}' (${pid})`); continue; }
    const r = mod.readiness(spec, pid);
    if (!r.ready) reasons.push(...r.reasons.map((x) => `${pid}: ${x}`));
  }
  for (const c of [...plan.edges, ...plan.groups.flatMap((g) => (g.coupling ? [g.coupling] : []))]) {
    const need = COUPLING_NEEDS[c.type];
    if (!need) continue;
    for (const [end, props] of [['to', need.to], ['from', need.from]] as const) {
      if (!props?.length) continue;
      try {
        for (const x of specReadiness(spec, c[end], { props })) if (x.startsWith('materials.')) reasons.push(`coupling '${c.id}': ${x}`);
      } catch (e) { reasons.push(`coupling '${c.id}': ${(e as Error).message}`); }
    }
  }
  // thermal strain enters the static elastic solve only: modal analysis has no thermal prestress (audit FE item 1)
  for (const c of plan.edges) if (c.type === 'thermal-expansion' && plan.study?.type === 'eigen') reasons.push(`coupling '${c.id}': thermal-expansion into an eigen study is not supported (no thermal prestress in modal analysis)`);
  // electro-optic uses one electrostatics solve: exactly one terminal condition (audit FE item 3)
  for (const c of plan.edges) if (c.type === 'electro-optic') {
    const terms = ((spec.physics ?? []).find((p) => p.id === c.from)?.bcs ?? []).filter((b) => b.type === 'terminal').map((b) => b.id);
    if (terms.length > 1) reasons.push(`coupling '${c.id}' (electro-optic): electrostatics '${c.from}' has ${terms.length} terminal conditions (${terms.join(', ')}); electro-optic supports exactly one terminal (settings.terminal selects its 1 V solve), since several terminals give one solve per terminal (param steps)`);
  }
  // a merged solution holds one step set: at most one solve group may produce steps (MO finding, DevLog-031)
  const stepped = plan.groups.map((g) => ({ g, k: g.ids.map((id) => stepKindOf(spec, id, plan.study)).find((x) => x) })).filter((x) => x.k);
  if (stepped.length > 1) reasons.push(`physics ${stepped.map((x) => `'${x.g.ids.join('+')}' (${x.k})`).join(' and ')} all produce steps, and a merged multiphysics solution holds one step set${stepped.some((x) => x.k!.startsWith('param')) ? '; an electrostatics physics feeding a coupling needs one terminal (plus ground or potentials): the coupling uses its 1 V or applied solve' : ''}`);
  // monolithic groups: the coupling's own readiness (MT, DevLog-033 R3)
  const impls = o.couplings ?? COUPLINGS;
  for (const g of plan.groups) if (g.coupling) {
    try { reasons.push(...(couplingImpl(g.coupling.type, impls)?.readiness?.(spec, g.coupling) ?? []).map((x) => `coupling '${g.coupling!.id}': ${x}`)); }
    catch (e) { reasons.push(`coupling '${g.coupling.id}': ${(e as Error).message}`); }
  }
  const uniq = [...new Set(reasons)];
  return { ready: uniq.length === 0, reasons: uniq, order: plan.groups.flatMap((g) => g.ids) };
}

/** Steps a physics will produce in a study (prediction for readiness; null = none). */
function stepKindOf(spec: Spec, pid: string, study: StudyNode | null): string | null {
  const p = (spec.physics ?? []).find((x) => x.id === pid);
  if (!p || !study) return null;
  switch (p.type) {
    case 'electrostatics': { const n = (p.bcs ?? []).filter((b) => b.type === 'terminal').length; return n > 1 ? `param steps: ${n} terminal solves` : null; }
    case 'heat': return study.type === 'time' ? 'time steps' : null;
    case 'em-modes': case 'emw': case 'emw-axisym': case 'acoustics': return 'eigen steps';
    case 'elastic': return study.type === 'eigen' ? 'eigen steps' : null;
    default: return null;
  }
}

/** Fields of one physics in a (possibly monolithic) solution. */
function viewOf(sol: Solution, pid: string, group: StudyGroup): Solution {
  if (!group.coupling) return sol;
  return { ...sol, fields: sol.fields.filter((f) => (f.physics ?? group.coupling!.from) === pid) };
}

/** Run every physics of the study (C11). */
export async function runStudy(prep: RunContext, opts: RunStudyOptions = {}): Promise<SolutionExt> {
  const spec = prep.spec;
  const sid = opts.studyId ?? prep.study.id;
  const plan = planStudy(spec, sid, { ...opts, physicsId: prep.physicsId });
  if (plan.reasons.length) throw new Error(`study '${sid}' not ready: ${plan.reasons.join('; ')}`);
  const study = sid === prep.study.id ? prep.study : plan.study!;
  const mods = opts.modules ?? defaultModules;
  const impls = opts.couplings ?? COUPLINGS;
  const progress = opts.progress ?? prep.progress;
  const signal = opts.signal ?? prep.signal;
  const modOf = (pid: string): PhysicsModule => {
    const t = physType(spec, pid)!;
    const m = mods[t];
    if (!m) throw new Error(`no @amp/physics module registered for type '${t}' (${pid})`);
    return m;
  };
  const base = (pid: string): RunContext => ({ ...prep, physicsId: pid, study, progress, signal });
  // one physics, no coupling: the plain module run
  if (plan.groups.length === 1 && !plan.groups[0]!.coupling && !plan.edges.length) {
    const pid = plan.groups[0]!.ids[0]!;
    return (await modOf(pid).run(base(pid))) as SolutionExt;
  }
  const startedAt = isoNow();
  const sols = new Map<string, { sol: SolutionExt; group: StudyGroup }>();
  const notes: string[] = [];
  const coupleMs: Record<string, number> = {};
  for (const g of plan.groups) {
    checkAbort(signal);
    const inputsFor = (pid: string): CoupledInput[] => plan.edges.filter((e) => e.to === pid).map((e) => {
      const up = sols.get(e.from);
      if (!up) throw new Error(`coupling '${e.id}': '${e.from}' has not been solved before '${pid}'`);
      const t0 = performance.now();
      const inp = couplingImpl(e.type, impls)!.map!({ up: viewOf(up.sol, e.from, up.group), upId: e.from, down: base(pid), node: e });
      coupleMs[pid] = (coupleMs[pid] ?? 0) + performance.now() - t0;
      const n = (inp.data as { notes?: unknown }).notes;
      if (Array.isArray(n)) notes.push(...n.map(String));
      return inp;
    });
    const ctxOf = (pid: string): RunContext => {
      const inputs = inputsFor(pid);
      const pr: RunContext['progress'] = (stage, frac, msg) => progress(stage, frac, `${pid}${msg ? `: ${msg}` : ''}`);
      return { ...base(pid), progress: pr, ...(inputs.length ? { inputs } : {}) };
    };
    if (g.coupling) {
      const ctx: Record<string, RunContext> = {};
      for (const pid of g.ids) ctx[pid] = ctxOf(pid);
      const sol = (await couplingImpl(g.coupling.type, impls)!.run!({ ctx, node: g.coupling })) as SolutionExt;
      for (const pid of g.ids) sols.set(pid, { sol, group: g });
    } else {
      const pid = g.ids[0]!;
      const sol = (await modOf(pid).run(ctxOf(pid))) as SolutionExt;
      sols.set(pid, { sol, group: g });
    }
  }
  checkAbort(signal);
  const merged = mergeSolutions(plan, sols, prep, startedAt, coupleMs);
  if (notes.length) merged.notes = [...new Set([...(merged.notes ?? []), ...notes])];
  return merged;
}

function mergeSolutions(plan: StudyPlan, sols: Map<string, { sol: SolutionExt; group: StudyGroup }>, prep: RunContext, startedAt: string, coupleMs: Record<string, number>): SolutionExt {
  const distinct: Array<{ sol: SolutionExt; group: StudyGroup; ids: string[] }> = [];
  for (const g of plan.groups) distinct.push({ sol: sols.get(g.ids[0]!)!.sol, group: g, ids: g.ids });
  // fields, tagged by physics
  const fields: FieldData[] = [];
  for (const d of distinct) for (const f of d.sol.fields) fields.push({ ...f, physics: f.physics ?? (d.group.coupling ? d.group.coupling.from : d.ids[0]!) });
  // steps: at most one distinct step set
  const stepped = distinct.filter((d) => d.sol.steps);
  let steps: Solution['steps'] | undefined;
  for (const d of stepped) {
    const s = d.sol.steps!;
    if (!steps) { steps = s; continue; }
    const same = s.kind === steps.kind && s.unit === steps.unit && s.values.length === steps.values.length && s.values.every((v, i) => v === steps!.values[i]);
    if (!same) throw new Error(`physics ${stepped.map((x) => x.ids.join('+')).join(' and ')} have different steps (${steps.kind}, ${s.kind}); a merged multiphysics solution holds one step set (an electrostatics physics in a coupled study: use one terminal plus ground)`);
  }
  // scalars: <pid>.<name>, plus the bare name when unique across physics
  const scalars: Solution['scalars'] = {};
  const bare = new Map<string, Array<{ value: number; unit: string }>>();
  for (const d of distinct) {
    for (const [k, v] of Object.entries(d.sol.scalars)) {
      const pre = k.split('.')[0]!;
      const key = d.ids.includes(pre) && k.includes('.') ? k : `${d.group.coupling ? d.group.coupling.from : d.ids[0]!}.${k}`;
      scalars[key] = v;
      const name = key.slice(key.indexOf('.') + 1);
      bare.set(name, [...(bare.get(name) ?? []), v]);
    }
  }
  for (const [name, vs] of bare) if (vs.length === 1 && !Object.hasOwn(scalars, name)) scalars[name] = vs[0]!;
  // timing: the shared prepare stages once, module stages summed and per physics
  const prepTiming = (prep as RunContext & { timing?: Record<string, number> }).timing ?? {};
  const timing: Record<string, number> = { ...prepTiming };
  for (const d of distinct) {
    const tag = d.ids.join('+');
    for (const [k, v] of Object.entries(d.sol.timing)) {
      if (Object.hasOwn(prepTiming, k)) continue;
      timing[`${tag}.${k}`] = v;
      timing[k] = (timing[k] ?? 0) + v;
    }
  }
  for (const [pid, v] of Object.entries(coupleMs)) { timing[`${pid}.couple`] = v; timing.couple = (timing.couple ?? 0) + v; }
  // stats
  const byPhysics: NonNullable<Solution['stats']['byPhysics']> = {};
  let dof = 0, nnz = 0, it = 0, hasNnz = false, hasIt = false;
  for (const d of distinct) {
    const s = d.sol.stats;
    byPhysics[d.ids.join('+')] = { dof: s.dof, solver: s.solver, ...(s.nnz !== undefined ? { nnz: s.nnz } : {}), ...(s.iterations !== undefined ? { iterations: s.iterations } : {}), ...(s.residual !== undefined ? { residual: s.residual } : {}) };
    dof += s.dof;
    if (s.nnz !== undefined) { nnz += s.nnz; hasNnz = true; }
    if (s.iterations !== undefined) { it += s.iterations; hasIt = true; }
  }
  const stats: Solution['stats'] = { dof, solver: distinct.map((d) => `${d.ids.join('+')}: ${d.sol.stats.solver}`).join('; '), ...(hasNnz ? { nnz } : {}), ...(hasIt ? { iterations: it } : {}), byPhysics };
  const first = distinct[0]!.sol;
  const out: SolutionExt = {
    meshHash: first.meshHash, fields, ...(steps ? { steps } : {}), scalars, stats, timing,
    run: { ...first.run, startedAt },
  };
  for (const d of distinct) if (d.sol.meshHash !== out.meshHash) throw new Error(`physics ${d.ids.join('+')} solved on a different mesh (${d.sol.meshHash.slice(0, 12)})`);
  const notes = [...new Set(distinct.flatMap((d) => d.sol.notes ?? []))];
  if (notes.length) out.notes = notes;
  const norm = distinct.filter((d) => d.sol.normalization).map((d) => `${d.ids.join('+')}: ${d.sol.normalization}`);
  if (norm.length) out.normalization = norm.join('; ');
  attachMesh(out, prep.mesh);
  return out;
}
