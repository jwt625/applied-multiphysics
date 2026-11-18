// SPDX-License-Identifier: GPL-3.0-or-later
// `em-modes` physics module (C4): full-vector waveguide modes of a 2D cross-section on a C2 triangle mesh, using the
// EO vector mode solver ported in ./vector-mode.mjs (Nedelec order 1-2 + Lagrange, Lee-Sun-Cendes pencil,
// shift-invert block Arnoldi). Inputs in SI (metres); the kernel works in um.
//
// Spec mapping (amp-spec/0):
//   physics {type: em-modes, select: [dom...], settings?: {order?: 1 | 2}, bcs: [{type: pec | pmc, select: [bnd...]}]}
//   materials[].select domains; property `n` (refractive index, real) or `eps_r` from RunContext.materials
//   study {type: mode, settings: {wavelength, nModes, neffShift?}}
//   Boundaries not listed as PEC are PMC (natural condition of the formulation).
// Results: steps {kind: eigen, values: n_eff (descending), unit: '1'}; scalars neff_<k>, teFraction_<k>, ng_<k>
//   (non-dispersive materials: eps_g = eps), powerW_<k>; fields per mode (step k) on triangle centroids (DG0):
//   Ex, Ey, Ez, Hx, Hy, Hz, normE (EO phase convention: E_t, H_t real, E_z = j ez, H_z = j hz), normalised to
//   max |E| = 1 V/m. Result expression names: <physicsId>.neff, <physicsId>.Ex ... <physicsId>.normE.
// Coupled inputs (C11, DevLog-032): with thermo-optic / electro-optic entries in RunContext.inputs, run() goes through
//   modes/coupled.ts (perturbed permittivity, first-order overlaps, VpiL, Ppi); without inputs the path above is
//   unchanged. Uniaxial materials (n.perp, n.par) need settings.crystals [{material, cut, propagation, rotation?}].
// Options (lane S2, DevLog-043; each off unless set, results then unchanged): settings.loss (eps = (n - j kappa)^2
//   from material kappa), settings.dispersion (eps_g = n (n - lambda dn/dlambda) in n_g; dndlambda per material;
//   lossy materials: complex eps_g = N (N - lambda dN/dlambda), N = n - j kappa, with dkappadlambda per material or 0),
//   settings.pml (complex coordinate stretching on outer domains, transform.ts), settings.bend (bend in the x-z plane,
//   axis parallel to y, metric or conformal model). Complex solves add kappaEff_<k>, Lprop_<k>, bendLossDbPer90_<k>;
//   runs with PML add pmlFraction_<k>. With a transform (audit fixes 2026-11-18, DevLog-043 s.8): confinement, powerW
//   and H_t use the transformed eps' and nu weights (physical outside the PML for the metric bend); E_z is reported in
//   bend coordinates (h E_z, metric model); TE fraction, effective area and all values in PML cells are computational-coordinate values.

import type { FieldData, Mesh, PhysicsModule, RunContext, Solution, Spec, StudyNode } from '@amp/spec/types';
import { resolveParams, resolveQuantity } from '@amp/spec';
import { buildVectorModel, solveVectorModes } from './vector-mode.mjs';
import { NPC, nCells, nNodes, selectEntities } from '../common/mesh.ts';
import { StageTimer, checkAbort, makeSolution, scalar, attachMesh } from '../common/solution.ts';
import { runCoupledModes, photonicInputs, crystalsOf, materialOptics, kernelTensor, type Crystal } from './coupled.ts';
import { modeTransform, type PmlRegion, type BendOptions } from './transform.ts';
import type { ModeTransform } from './vector-mode.mjs';

const UM = 1e6; // metres -> um
/** Default PML profile s = 1 - j a xi^p (numerical modelling choice; DevLog-043 s.4 convergence study). */
export const PML_DEFAULT = { strength: 2, power: 2 } as const;

/** Relative permittivity of a domain: scalar (isotropic) or [xx, xy, yy, zz]; optional loss eps = eps' - j eps''. */
export type DomainEps = number | [number, number, number, number];

export interface ModesProblem {
  mesh: Mesh;
  /** per domain index (mesh.entities.domains): relative permittivity (real part) */
  eps: DomainEps[];
  /** per domain index: loss part eps'' >= 0 (eps = eps' - j eps''); omit for lossless */
  epsIm?: DomainEps[];
  /** boundary entity ids with PEC; every other outer boundary is PMC */
  pec?: string[];
  /** vacuum wavelength (m) */
  wavelength: number;
  nModes: number;
  /** shift index: modes with n_eff closest below it first (default: just above the largest index) */
  neffShift?: number;
  order?: 1 | 2;
  /** cells taking part (default all); cells outside get no DOFs (a perfect conductor) */
  cellMask?: Uint8Array;
  blockSize?: number;
  tol?: number;
  fields?: boolean;
  /** per-triangle permittivity tensors [xx, xy, yy, zz] (4 per triangle) replacing `eps` (coupled path, DevLog-032) */
  epsTri?: Float64Array;
  /** a kernel model built earlier for the same mesh, PEC set, order and cell mask (reused by the coupled path) */
  model?: any;
  /** per domain index: group permittivity eps_g = eps - (lambda / 2) d eps / d lambda = n (n - lambda dn/dlambda)
   *  (material dispersion in n_g, DevLog-043); omit = non-dispersive (eps_g = eps, complex in a lossy solve) */
  epsG?: DomainEps[];
  /** per domain index: loss part of eps_g = epsG - j epsGIm; required in a lossy solve that gives epsG (error otherwise),
   *  default epsIm only when epsG is omitted too (non-dispersive) */
  epsGIm?: DomainEps[];
  /** coordinate transform (PML stretching, bend metric), per triangle complex factors (transform.ts modeTransform) */
  transform?: ModeTransform;
  /** bend radius (m) of the transform, for bendLossDbPer90_<k> */
  bendRadius?: number;
  /** notes carried into the Solution */
  notes?: string[];
  signal?: AbortSignal;
  progress?: (stage: string, frac: number, msg?: string) => void;
}

export interface ModesOutput {
  solution: Solution;
  /** raw kernel result (modes with n_eff, teFraction, residual, fields, warnings, inertia, stats) */
  result: any;
  model: any;
}

const tensorOf = (e: DomainEps): [number, number, number, number] => (typeof e === 'number' ? [e, 0, e, e] : e);

/** Kernel mesh (um) + PEC sets from a C2 mesh. */
export function kernelMesh(mesh: Mesh, pecIds: readonly string[] = []) {
  if (mesh.dim !== 2) throw new Error('em-modes: 2D mesh required');
  if (mesh.axisym) throw new Error('em-modes: axisymmetric meshes are not supported');
  const type = mesh.cells.type;
  if (type !== 'tri3' && type !== 'tri6') throw new Error(`em-modes: tri3 or tri6 cells required, got ${type}`);
  const k = NPC[type];
  const nc = nCells(mesh), nn = nNodes(mesh);
  const tri = new Int32Array(3 * nc);
  for (let c = 0; c < nc; c++) for (let a = 0; a < 3; a++) tri[3 * c + a] = mesh.cells.conn[k * c + a]!;
  const x = new Float64Array(nn), y = new Float64Array(nn);
  for (let i = 0; i < nn; i++) { x[i] = mesh.nodes[2 * i]! * UM; y[i] = mesh.nodes[2 * i + 1]! * UM; }
  const pecNodes = new Uint8Array(nn);
  const pecKeys = new Set<number>();
  const kf = NPC[mesh.facets.type];
  const bset = new Set(pecIds.length ? selectEntities(mesh.entities, 'boundaries', pecIds) : []);
  const nf = mesh.facets.conn.length / kf;
  for (let f = 0; f < nf; f++) {
    if (!bset.has(mesh.facets.boundary[f]!)) continue;
    const a = mesh.facets.conn[kf * f]!, b = mesh.facets.conn[kf * f + 1]!;
    pecNodes[a] = 1; pecNodes[b] = 1;
    pecKeys.add(a < b ? a * nn + b : b * nn + a);
  }
  return {
    mesh: { nNodes: nn, nTris: nc, tri, x, y, triRegion: mesh.cells.domain },
    pecNodes,
    pecEdge: (a: number, b: number) => pecKeys.has(a < b ? a * nn + b : b * nn + a),
  };
}

/** Programmatic solve: C2 mesh + per-domain permittivity -> C5 Solution (+ raw kernel result). */
export async function solveModes(p: ModesProblem, meta: { spec?: unknown; physicsId?: string } = {}): Promise<ModesOutput> {
  const timer = new StageTimer();
  const pid = meta.physicsId ?? 'ewg';
  if (!(p.wavelength > 0)) throw new Error('em-modes: wavelength must be > 0');
  if (!(Number.isInteger(p.nModes) && p.nModes >= 1)) throw new Error('em-modes: nModes must be an integer >= 1');
  const nDom = p.mesh.entities.domains.length;
  if (p.eps.length !== nDom) throw new Error(`em-modes: eps needs one entry per domain (${nDom}), got ${p.eps.length}`);
  p.progress?.('model', 0);
  const km = p.model ? null : timer.time('model', () => kernelMesh(p.mesh, p.pec ?? []));
  const nT = p.model ? p.model.mesh.nTris : km!.mesh.nTris;
  const dead = new Uint8Array(nT);
  if (p.cellMask) for (let t = 0; t < nT; t++) dead[t] = p.cellMask[t] ? 0 : 1;
  const model = p.model ?? timer.time('model', () => buildVectorModel(km!.mesh, {
    order: p.order ?? 2, pecNodes: km!.pecNodes, pecEdge: km!.pecEdge, dead,
    regionNames: p.mesh.entities.domains.map((d) => d.id),
  }));
  checkAbort(p.signal);
  const eps = new Float64Array(4 * nT);
  const epsIm = p.epsIm ? new Float64Array(4 * nT) : null;
  if (p.epsG && p.epsG.length !== nDom) throw new Error(`em-modes: epsG needs one entry per domain (${nDom}), got ${p.epsG.length}`);
  const epsG = p.epsG ? new Float64Array(4 * nT) : null;
  if (p.epsGIm && p.epsGIm.length !== nDom) throw new Error(`em-modes: epsGIm needs one entry per domain (${nDom}), got ${p.epsGIm.length}`);
  const epsGIm = p.epsGIm ? new Float64Array(4 * nT) : null;
  // a lossy solve with a dispersive eps_g states its loss part (the kernel default epsGIm = epsIm drops -lambda kappa dn/dlambda)
  if (p.epsIm && p.epsG && !p.epsGIm && p.epsIm.some((e) => tensorOf(e).some((v) => v !== 0))) throw new Error('em-modes: a lossy solve with epsG needs epsGIm (Im eps_g = 2 n kappa - lambda (n dkappa/dlambda + kappa dn/dlambda)); pass epsGIm = epsIm for a wavelength-independent loss part');
  if (p.epsTri && p.epsTri.length !== 4 * nT) throw new Error(`em-modes: epsTri needs 4 * nTris = ${4 * nT} values`);
  for (let t = 0; t < nT; t++) {
    const d = p.mesh.cells.domain[t]!;
    if (p.epsTri) eps.set(p.epsTri.subarray(4 * t, 4 * t + 4), 4 * t);
    else eps.set(tensorOf(p.eps[d]!), 4 * t);
    if (epsIm) epsIm.set(tensorOf(p.epsIm![d]!), 4 * t);
    if (epsG) epsG.set(tensorOf(p.epsG![d]!), 4 * t);
    if (epsGIm) epsGIm.set(tensorOf(p.epsGIm![d]!), 4 * t);
  }
  const lam = p.wavelength * UM;
  p.progress?.('solve', 0.1);
  const res = solveVectorModes(model, lam, {
    eps, epsIm, ...(epsG ? { epsG } : {}), ...(epsGIm ? { epsGIm } : {}), ...(p.transform ? { transform: p.transform } : {}),
    numModes: p.nModes, nTarget: p.neffShift ?? null, blockSize: p.blockSize ?? 1, tol: p.tol ?? 1e-7, fields: p.fields !== false,
  });
  checkAbort(p.signal);
  timer.add('assemble', res.timing.assembleMs);
  timer.add('factor', res.timing.factorMs);
  timer.add('solve', res.timing.eigenMs);
  timer.add('post', res.timing.postMs);
  const fields: FieldData[] = [];
  const scalars: Solution['scalars'] = {};
  res.modes.forEach((m: any, k: number) => {
    scalars[`neff_${k}`] = scalar(m.neff, '1');
    scalars[`teFraction_${k}`] = scalar(m.teFraction, '1');
    if (Number.isFinite(m.ng)) scalars[`ng_${k}`] = scalar(m.ng, '1');
    scalars[`powerW_${k}`] = scalar(m.powerW, 'W');
    if (m.lossy) scalars[`lossDbPerM_${k}`] = scalar(m.lossDbPerCm * 100, 'dB/m');
    // complex solves (loss, PML, bend; DevLog-043): -Im n_eff, power 1/e length, loss per 90 degree bend
    if (m.lossy && (p.epsIm || p.transform)) {
      scalars[`kappaEff_${k}`] = scalar(m.kappa, '1');
      if (m.alphaPerUm > 0) scalars[`Lprop_${k}`] = scalar(1e-6 / (2 * m.alphaPerUm), 'm');
      if (p.bendRadius !== undefined) scalars[`bendLossDbPer90_${k}`] = scalar(m.lossDbPerCm * 100 * (Math.PI / 2) * Math.abs(p.bendRadius), 'dB');
    }
    // share of int |E|^2 in PML cells (> 0.5: PML or radiation mode; a note names such modes)
    if (m.pmlFraction !== undefined) scalars[`pmlFraction_${k}`] = scalar(m.pmlFraction, '1');
    if (!m.fields) return;
    const F = m.fields;
    const normE = new Float64Array(nT);
    for (let t = 0; t < nT; t++) normE[t] = Math.hypot(F.ex[t], F.ey[t], F.ez[t], F.exIm?.[t] ?? 0, F.eyIm?.[t] ?? 0, F.ezIm?.[t] ?? 0);
    const add = (name: string, unit: string, data: Float64Array) => fields.push({ name, unit, space: 'DG0', components: 1, data, step: k });
    add('Ex', 'V/m', F.ex); add('Ey', 'V/m', F.ey); add('Ez', 'V/m', F.ez);
    add('Hx', 'A/m', F.hx); add('Hy', 'A/m', F.hy); add('Hz', 'A/m', F.hz);
    add('normE', 'V/m', normE);
  });
  if (res.modes[0]) scalars.neff = scalar(res.modes[0].neff, '1');
  const solution = await makeSolution({
    mesh: p.mesh,
    ...(meta.spec !== undefined ? { spec: meta.spec } : { problemDigest: { module: 'em-modes', physicsId: pid, wavelength: p.wavelength, nModes: p.nModes, order: p.order ?? 2, eps: p.eps, epsIm: p.epsIm ?? null, pec: p.pec ?? [], neffShift: p.neffShift ?? null, meshHash: p.mesh.hash, ...(p.epsG ? { epsG: p.epsG } : {}), ...(p.epsGIm ? { epsGIm: p.epsGIm } : {}), ...(p.transform ? { transform: digestTransform(p.transform) } : {}) } }),
    fields,
    steps: { kind: 'eigen', values: Float64Array.from(res.modes.map((m: any) => m.neff)), unit: '1' },
    scalars,
    stats: {
      dof: res.stats.dof, nnz: res.stats.nnzA, iterations: res.stats.operatorApplications,
      residual: res.modes.reduce((a: number, m: any) => Math.max(a, m.residual), 0),
      solver: `shift-invert block Arnoldi, supernodal LDL^T; Nedelec order ${model.order} + P${model.order}`,
    },
    timer,
  });
  attachMesh(solution, p.mesh);
  const notes = [...(p.notes ?? []), ...(p.transform ? (res.warnings as string[]).map((w) => `em-modes: ${w}`) : [])];
  if (notes.length) (solution as Solution & { notes?: string[] }).notes = notes;
  p.progress?.('done', 1);
  return { solution, result: res, model };
}

/** Small digest of a transform for the problem hash (sums of the factor arrays). */
function digestTransform(t: ModeTransform) {
  const sum = (a?: Float64Array | null) => (a ? a.reduce((x, v, i) => x + v * ((i % 7) + 1), 0) : null);
  return { model: t.model ?? 'metric', sx: sum(t.sx), sy: sum(t.sy), h: sum(t.h) };
}

// ------------------------------------------------------------------------------------------------- spec adapter

type AnyRec = Record<string, unknown>;
const NA = 'N/A';

function physicsNode(spec: Spec, physicsId: string): AnyRec | undefined {
  return (spec.physics ?? []).find((p) => p.id === physicsId) as AnyRec | undefined;
}

function modeStudy(spec: Spec, physicsId: string, study?: StudyNode): AnyRec | undefined {
  if (study && study.type === 'mode') return study as unknown as AnyRec;
  return (spec.studies ?? []).find((s) => s.type === 'mode' && s.physics.includes(physicsId)) as AnyRec | undefined;
}

const baseName = (id: string) => id.replace(/^dom:/, '').replace(/#.*$/, '');
const pieceOf = (id: string) => baseName(id).split('&');

function readiness(spec: Spec, physicsId: string): { ready: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const ph = physicsNode(spec, physicsId);
  if (!ph) return { ready: false, reasons: [`no physics '${physicsId}'`] };
  if (ph.type !== 'em-modes') reasons.push(`physics '${physicsId}' is ${String(ph.type)}, not em-modes`);
  if (spec.geometry.dim !== 2 || spec.geometry.axisym) reasons.push('em-modes needs a 2D (non-axisymmetric) geometry');
  const st = modeStudy(spec, physicsId);
  if (!st) reasons.push(`no study of type 'mode' for '${physicsId}'`);
  else {
    const s = (st.settings ?? {}) as AnyRec;
    if (s.wavelength === undefined || s.wavelength === NA) reasons.push('mode study: wavelength missing');
    if (s.nModes === undefined) reasons.push('mode study: nModes missing');
  }
  const order = ((ph.settings ?? {}) as AnyRec).order;
  if (order !== undefined && order !== 1 && order !== 2) reasons.push('settings.order must be 1 or 2');
  const sel = (ph.select ?? []) as string[];
  const mats = spec.materials ?? [];
  for (const d of sel) {
    // fragment pieces 'dom:a&b' belong to the materials selecting 'dom:a' or 'dom:b' (origin-set naming, @amp/geom)
    const m = mats.find((mm) => mm.select.some((s) => s === d || d.startsWith(`${s}#`) || s.startsWith(`${d}#`) || (!s.includes('#') && pieceOf(d).includes(baseName(s)))));
    if (!m) { reasons.push(`domain ${d}: no material`); continue; }
    const ov = (m.override ?? {}) as AnyRec;
    const v = ov.n ?? ov.eps_r;
    if (v === undefined && !m.ref) reasons.push(`material '${m.id}': no n or eps_r`);
    if (v === NA || (typeof v === 'object' && v !== null && (v as AnyRec).value === NA)) reasons.push(`material '${m.id}': n is N/A`);
  }
  for (const b of (ph.bcs ?? []) as AnyRec[]) if (b.type !== 'pec' && b.type !== 'pmc') reasons.push(`bc '${String(b.id)}': type ${String(b.type)} not supported by em-modes (pec, pmc)`);
  return { ready: reasons.length === 0, reasons };
}

/** Build the ModesProblem from a RunContext (spec + C2 mesh + resolved materials). */
export function problemFromContext(ctx: RunContext, crystals?: Map<string, Crystal>): ModesProblem {
  const { spec, mesh, physicsId } = ctx;
  const ph = physicsNode(spec, physicsId);
  if (!ph) throw new Error(`em-modes: no physics '${physicsId}'`);
  const st = modeStudy(spec, physicsId, ctx.study);
  if (!st) throw new Error(`em-modes: no mode study for '${physicsId}'`);
  const { scope } = resolveParams(spec.params);
  const s = (st.settings ?? {}) as AnyRec;
  const q = (v: unknown, what: string): number => {
    const r = resolveQuantity(v, scope);
    if (r.na) throw new Error(`em-modes: ${what} is N/A`);
    return r.si;
  };
  const wavelength = q(s.wavelength, 'wavelength');
  const nModes = Number(s.nModes);
  const neffShift = s.neffShift !== undefined ? q(s.neffShift, 'neffShift') : undefined;
  // permittivity per domain index from materials (property n -> eps = n^2, else eps_r)
  const nDom = mesh.entities.domains.length;
  const eps: Array<DomainEps | undefined> = new Array(nDom).fill(undefined);
  const activeDoms = new Set(selectEntities(mesh.entities, 'domains', (ph.select ?? []) as string[]));
  for (const m of spec.materials ?? []) {
    const props = ctx.materials[m.id];
    if (!props) continue;
    const doms = selectEntities(mesh.entities, 'domains', m.select);
    const e = props.n !== undefined ? props.n * props.n : props.eps_r;
    if (e === undefined || !Number.isFinite(e)) {
      // uniaxial index (n.perp, n.par; DevLog-032) with a crystal orientation from settings.crystals
      if (props['n.perp'] === undefined || props['n.par'] === undefined) continue;
      // only materials of domains this physics solves need an orientation (others keep the old skip)
      if (!doms.some((d) => activeDoms.has(d))) continue;
      const o = materialOptics(m.id, props, crystals ?? crystalsOf(ctx));
      if (!o) continue;
      const t = kernelTensor(o.A, [o.n[0] ** 2, o.n[1] ** 2, o.n[2] ** 2], `material '${m.id}'`);
      for (const d of doms) eps[d] = t;
      continue;
    }
    for (const d of doms) eps[d] = e;
  }
  const sel = (ph.select ?? []) as string[];
  const active = new Set(selectEntities(mesh.entities, 'domains', sel));
  const nc = nCells(mesh);
  const cellMask = new Uint8Array(nc);
  for (let c = 0; c < nc; c++) cellMask[c] = active.has(mesh.cells.domain[c]!) ? 1 : 0;
  for (const d of active) if (eps[d] === undefined) throw new Error(`em-modes: domain ${mesh.entities.domains[d]!.id} has no n / eps_r in RunContext.materials`);
  // DevLog-043 options (all off unless set): loss, dispersion, pml, bend
  const set = (ph.settings ?? {}) as AnyRec;
  const notes: string[] = [];
  const matsIn = (spec.materials ?? []).map((m) => ({ m, props: ctx.materials[m.id], doms: selectEntities(mesh.entities, 'domains', m.select).filter((d) => active.has(d)) }))
    .filter((r) => r.props && r.doms.length);
  let epsIm: DomainEps[] | undefined;
  if (set.loss === true) {
    const im: DomainEps[] = new Array(nDom).fill(0);
    const used: string[] = [];
    for (const { m, props, doms } of matsIn) {
      if (props!['kappa.perp'] !== undefined || props!['kappa.par'] !== undefined) throw new Error(`em-modes loss: uniaxial kappa of material '${m.id}' is not supported yet`);
      const kap = props!.kappa;
      if (kap === undefined) continue;
      if (!(kap >= 0)) throw new Error(`em-modes loss: material '${m.id}' kappa = ${kap} must be >= 0`);
      const n = props!.n;
      if (n === undefined) throw new Error(`em-modes loss: material '${m.id}' has kappa but no n (eps = (n - j kappa)^2 needs both)`);
      // N = n + i kappa (e^{-i omega t}) == n - j kappa (e^{+j omega t}); eps = n^2 - kappa^2 - j 2 n kappa
      for (const d of doms) { eps[d] = n * n - kap * kap; im[d] = 2 * n * kap; }
      used.push(`${m.id} (n ${n}, kappa ${kap}: eps = ${n * n - kap * kap} - j ${2 * n * kap})`);
    }
    if (used.length) {
      epsIm = im;
      const ngNote = set.dispersion !== undefined && set.dispersion !== false ? '' : '; n_g is the real part of the complex group index with eps_g = eps (no material dispersion)';
      notes.push(`em-modes loss: complex permittivity eps = (n - j kappa)^2 for ${used.join('; ')}${ngNote}`);
    }
    else notes.push('em-modes loss: on, but no material of the selection has kappa (lossless solve)');
  } else {
    const withK = matsIn.filter((r) => r.props!.kappa !== undefined).map((r) => r.m.id);
    if (withK.length) notes.push(`em-modes: material(s) ${withK.join(', ')} have kappa but settings.loss is off (lossless solve)`);
  }
  let epsG: DomainEps[] | undefined;
  let epsGIm: DomainEps[] | undefined;
  if (set.dispersion !== undefined && set.dispersion !== false) {
    const lam = wavelength;
    const dObj = (typeof set.dispersion === 'object' && set.dispersion !== null ? set.dispersion : {}) as AnyRec;
    const map = (dObj.dndlambda ?? {}) as Record<string, unknown>;
    const kMap = (dObj.dkappadlambda ?? {}) as Record<string, unknown>;
    const g: Array<DomainEps | undefined> = eps.map((e) => e);
    const gIm: DomainEps[] | undefined = epsIm ? epsIm.slice() : undefined;
    const missing: string[] = [];
    const used: string[] = [];
    const lossyUsed: string[] = [];
    const kappaConst: string[] = [];
    const dOf = (id: string, props: Record<string, number>, comp?: 'perp' | 'par'): number | undefined => {
      const mv = map[id];
      if (mv !== undefined) {
        const v = comp ? (typeof mv === 'object' && mv !== null && comp in (mv as AnyRec) ? (mv as AnyRec)[comp] : undefined) : mv;
        if (v === undefined) return undefined;
        return typeof v === 'number' ? v : q(v, `dispersion.dndlambda.${id}${comp ? `.${comp}` : ''}`);
      }
      return comp ? props[`dn_dlambda.${comp}`] : props.dn_dlambda;
    };
    for (const { m, props, doms } of matsIn) {
      const P = props!;
      if (P.n !== undefined && Number.isFinite(P.n)) {
        const dn = dOf(m.id, P);
        if (dn === undefined || !Number.isFinite(dn)) { missing.push(m.id); continue; }
        const n = P.n, ng = n - lam * dn;
        const kap = epsIm ? P.kappa : undefined;
        if (kap !== undefined && gIm) {
          // lossy: eps_g = N (N - lambda dN/dlambda), N = n - j kappa, dN/dlambda = dn/dlambda - j dkappa/dlambda
          const kv = kMap[m.id];
          const dkIn = kv !== undefined ? (typeof kv === 'number' ? kv : q(kv, `dispersion.dkappadlambda.${m.id}`)) : P.dkappa_dlambda;
          if (dkIn !== undefined && !Number.isFinite(dkIn)) throw new Error(`em-modes dispersion: dkappa/dlambda of material '${m.id}' is not finite`);
          const dk = dkIn ?? 0;
          if (dkIn === undefined) kappaConst.push(m.id);
          for (const d of doms) { g[d] = n * n - kap * kap - lam * (n * dn - kap * dk); gIm[d] = 2 * n * kap - lam * (n * dk + kap * dn); }
          lossyUsed.push(`${m.id} (n ${n}, kappa ${kap}, dn/dlambda ${dn} 1/m, dkappa/dlambda ${dkIn === undefined ? '0 (not given)' : `${dk} 1/m`})`);
          continue;
        }
        for (const d of doms) g[d] = n * ng;
        used.push(`${m.id} (n ${n}, dn/dlambda ${dn} 1/m, material n_g ${ng})`);
      } else if (P['n.perp'] !== undefined && P['n.par'] !== undefined) {
        const o = materialOptics(m.id, P, crystals ?? crystalsOf(ctx));
        const dp = dOf(m.id, P, 'perp'), de = dOf(m.id, P, 'par');
        if (!o || dp === undefined || de === undefined || !Number.isFinite(dp) || !Number.isFinite(de)) { missing.push(`${m.id} (perp and par)`); continue; }
        const gi = (i: number) => o.n[i]! * (o.n[i]! - lam * (i === 2 ? de : dp));
        const t = kernelTensor(o.A, [gi(0), gi(1), gi(2)], `material '${m.id}' (eps_g)`);
        for (const d of doms) g[d] = t;
        used.push(`${m.id} (n.perp ${P['n.perp']}, n.par ${P['n.par']}, dn/dlambda perp ${dp}, par ${de} 1/m)`);
      } else missing.push(`${m.id} (no n: eps_r-only materials have no dispersion data)`);
    }
    if (missing.length) throw new Error(`em-modes dispersion: no dn/dlambda for material(s) ${missing.join(', ')} (settings.dispersion.dndlambda.<material> in 1/m, or a library dn_dlambda); no default is assumed`);
    epsG = g.map((e) => e ?? 1);
    if (gIm) epsGIm = gIm;
    if (used.length) notes.push(`em-modes dispersion: n_g with eps_g = n (n - lambda dn/dlambda) at lambda = ${lam} m for ${used.join('; ')}`);
    if (lossyUsed.length) notes.push(`em-modes dispersion: lossy material(s) with complex eps_g = N (N - lambda dN/dlambda), N = n - j kappa, dN/dlambda = dn/dlambda - j dkappa/dlambda, at lambda = ${lam} m: ${lossyUsed.join('; ')}; n_g is the real part of the complex group index`);
    if (kappaConst.length) notes.push(`em-modes dispersion: no dkappa/dlambda for ${kappaConst.join(', ')} (settings.dispersion.dkappadlambda.<material> in 1/m or a material dkappa_dlambda): kappa treated as wavelength-independent in n_g`);
  }
  let transform: ModeTransform | undefined;
  let bendRadius: number | undefined;
  const pmlIn = set.pml as Array<AnyRec> | undefined;
  const bendIn = set.bend as AnyRec | undefined;
  if ((pmlIn && pmlIn.length) || bendIn) {
    const pml: PmlRegion[] = (pmlIn ?? []).map((r, i) => {
      const doms = selectEntities(mesh.entities, 'domains', (r.select ?? []) as string[]);
      if (!doms.length) throw new Error(`em-modes pml[${i}]: select matches no domain`);
      const off = doms.filter((d) => !active.has(d));
      if (off.length) throw new Error(`em-modes pml[${i}]: domain(s) ${off.map((d) => mesh.entities.domains[d]!.id).join(', ')} are not in the physics selection`);
      const pair = (v: unknown, w: string): [number, number] | undefined => (v === undefined ? undefined : [q((v as unknown[])[0], `pml[${i}].${w}[0]`), q((v as unknown[])[1], `pml[${i}].${w}[1]`)]);
      const x = pair(r.x, 'x'), y = pair(r.y, 'y');
      return { domains: doms, strength: r.strength !== undefined ? Number(r.strength) : PML_DEFAULT.strength, power: r.power !== undefined ? Number(r.power) : PML_DEFAULT.power, ...(x ? { x } : {}), ...(y ? { y } : {}) };
    });
    const bend: BendOptions | undefined = bendIn ? { radius: q(bendIn.radius, 'bend.radius'), x0: bendIn.x0 !== undefined ? q(bendIn.x0, 'bend.x0') : 0, model: (bendIn.model as 'metric' | 'conformal' | undefined) ?? 'metric' } : undefined;
    const tr = modeTransform(mesh, { pml, ...(bend ? { bend } : {}), ...(active.size < nDom ? { cellMask } : {}), domainName: (d) => mesh.entities.domains[d]!.id });
    transform = { sx: tr.sx, sy: tr.sy, h: tr.h, model: tr.model };
    if (bend) { bendRadius = bend.radius; notes.push(`em-modes bend: ${bend.model} model, radius ${bend.radius} m, centre of curvature at x = ${(bend.x0 ?? 0) - bend.radius} m (bend in the x-z plane, axis parallel to y); n_eff referenced to the radius |R| at x = ${bend.x0 ?? 0} m${bend.model === 'metric' ? '; field Ez is reported in bend coordinates (h Ez, h = 1 + (x - x0) / R)' : ''}${bend.model === 'conformal' ? '; conformal = Heiblum-Harris scalar equivalent index n (1 + (x - x0) / R), an approximation' : ''}`); }
    if (tr.layers.length) notes.push(`em-modes pml: ${tr.layers.map((l) => `${mesh.entities.domains[l.domain]!.id}${l.x ? ` x ${l.x[0]} -> ${l.x[1]} m` : ''}${l.y ? ` y ${l.y[0]} -> ${l.y[1]} m` : ''}`).join('; ')}; s = 1 - j a xi^p (a, p per entry; defaults a ${PML_DEFAULT.strength}, p ${PML_DEFAULT.power})`);
  }
  const pec: string[] = [];
  for (const b of (ph.bcs ?? []) as Array<{ type: string; select: string[] }>) if (b.type === 'pec') pec.push(...b.select);
  // inactive cells (outside the physics selection) get no DOFs: their boundary acts as PEC (kernel `dead` triangles)
  const order = ((ph.settings ?? {}) as AnyRec).order as 1 | 2 | undefined;
  return {
    mesh, eps: eps.map((e) => e ?? 1), pec, wavelength, nModes, ...(neffShift !== undefined ? { neffShift } : {}),
    ...(order ? { order } : {}), ...(active.size < nDom ? { cellMask } : {}), signal: ctx.signal, progress: ctx.progress,
    ...(epsIm ? { epsIm } : {}), ...(epsG ? { epsG } : {}), ...(epsGIm ? { epsGIm } : {}), ...(transform ? { transform } : {}), ...(bendRadius !== undefined ? { bendRadius } : {}),
    ...(notes.length ? { notes } : {}),
  };
}

export const emModes: PhysicsModule = {
  type: 'em-modes',
  dims: ['2d'],
  readiness,
  async run(ctx: RunContext): Promise<Solution> {
    const r = readiness(ctx.spec, ctx.physicsId);
    if (!r.ready) throw new Error(`em-modes not ready: ${r.reasons.join('; ')}`);
    if (photonicInputs(ctx).length || ctx.inputs?.length) {
      const crystals = crystalsOf(ctx);
      const base = problemFromContext(ctx, crystals);
      // the first-order overlaps of the coupled path are not transformed (DevLog-043 O1)
      if (base.transform) throw new Error('em-modes: pml / bend together with thermo-optic or electro-optic couplings is not supported yet');
      const sol = await runCoupledModes(ctx, base, (p) => solveModes(p, { spec: ctx.spec, physicsId: ctx.physicsId }));
      if (base.notes?.length) { const x = sol as Solution & { notes?: string[] }; x.notes = [...new Set([...(x.notes ?? []), ...base.notes])]; }
      return sol;
    }
    const out = await solveModes(problemFromContext(ctx), { spec: ctx.spec, physicsId: ctx.physicsId });
    return out.solution;
  },
};

export default emModes;
