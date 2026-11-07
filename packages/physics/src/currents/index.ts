// SPDX-License-Identifier: GPL-3.0-or-later
// Electric currents, DC conduction (C4 type 'currents', DevLog-031): -div(sigma grad V) = 0 on 2D (per unit depth, or
// times settings.thickness), 2D axisymmetric (full body of revolution, weight r) and 3D meshes, with the scalar H1
// machinery of electrostatics (common/scalar.ts). Conditions: ground (V = 0), potential (V field), terminal (an
// electrode at a terminal voltage V, or carrying a total current I that sets its voltage), insulation (n . J = 0,
// natural). Solve by superposition: one unit solve per terminal (terminal = 1 V, all other fixed boundaries 0 V) and one
// for the potential boundaries; conductance matrix G_ij = int sigma grad U_i . grad U_j dV (energy form); the current
// into the domain through terminal i is I_i = sum_j G_ij V_j + I_p,i, so current terminals get V_c from
// G_cc V_c = I_c - I_p,c - G_cv V_v. Outputs: V (H1), E = -grad V and J = sigma E (cell means, DG0), Joule heat
// density Q = cell mean of sigma |grad V|^2 (DG0, W/m^3; r-weighted mean in axisymmetry, so the integral of Q is the
// Joule power exactly), and the scalars I_<t>, V_<t>, R_<t> = 1 / G_tt (other terminals and grounds at 0 V),
// G_<i>_<j>, P (Joule power, energy form). sigma comes from the materials; nothing is defaulted.
// Out-of-plane drive (2D planar, settings.outOfPlane; DevLog-031 X3): the 2D section of long straight conductors that
// carry current along z (the out-of-plane axis) between two end contacts. With L much larger than the section and no
// in-plane current, E = (0, 0, E_z) with the same E_z in every conductor of the physics (they are in parallel between
// the same contacts); E_z = V / length, or E_z = I / G' with G' = int sigma dA (S m), or E_z given. Then J_z = sigma
// E_z, Q = sigma E_z^2, I = E_z G', P' = E_z^2 G' (W/m), R' = 1 / G' (Ohm/m). End effects are neglected. No in-plane
// potential is solved (no V field; in-plane conditions other than insulation are an error).

import type { Mesh, PhysicsModule, RunContext, Solution, Spec } from '@amp/spec/types';
import { NPC, facetNodes, facetsOn, nCells, nNodes, selectEntities } from '../common/mesh.ts';
import { assembleCells, matVec, restrict, SpdSolver, cellOrder } from '../common/scalar.ts';
import { defaultRule, gatherX, physGrad, shapeTable } from '../common/lagrange.ts';
import { makeSolution, StageTimer, scalar, attachMesh, checkAbort } from '../common/solution.ts';
import { bcsOf, cellProps, physicsNode, q as qty } from '../common/ctx.ts';
import { compileField, spaceOf } from '../common/field.ts';

export interface CurrentsTerminal { id: string; select: string[]; V?: number; I?: number }

export interface CurrentsProblem {
  mesh: Mesh;
  /** per-cell conductivity (S/m); NaN, sigma <= 0 or mask 0 = not in the conduction domain */
  sigma: Float64Array;
  mask?: Uint8Array;
  terminals: CurrentsTerminal[];
  ground?: string[];
  potentials?: Array<{ select: string[]; V: number | ((x: ArrayLike<number>) => number) }>;
  /** 2D planar only: out-of-plane thickness (m); without it 2D values are per unit depth */
  thickness?: number;
  /** boundaries stated as insulating (checked to exist; natural condition) */
  insulation?: string[];
  /** 2D planar only: drive along the out-of-plane axis instead of an in-plane solve (exactly one form) */
  outOfPlane?: { Ez?: number; V?: number; length?: number; I?: number };
  solver?: 'cholesky' | 'amg-pcg';
  spec?: unknown;
  signal?: AbortSignal;
  /** notes of the spec binding (e.g. materials with sigma <= 0 left out of the conduction domain) */
  notes?: string[];
}

/** Solve a small dense system (partial pivoting); throws on a singular matrix. */
function denseSolve(A: number[][], b: number[]): number[] {
  const n = b.length, M = A.map((r, i) => [...r, b[i]!]);
  const scale = Math.max(1e-300, ...A.flat().map(Math.abs));
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r]![c]!) > Math.abs(M[p]![c]!)) p = r;
    if (Math.abs(M[p]![c]!) <= 1e-13 * scale) throw new Error('currents: the current terminals have no conducting path to a fixed potential (singular conductance block)');
    [M[c], M[p]] = [M[p]!, M[c]!];
    for (let r = c + 1; r < n; r++) { const f = M[r]![c]! / M[c]![c]!; for (let k = c; k <= n; k++) M[r]![k]! -= f * M[c]![k]!; }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) { let s = M[r]![n]!; for (let k = r + 1; k < n; k++) s -= M[r]![k]! * x[k]!; x[r] = s / M[r]![r]!; }
  return x;
}

export async function solveCurrents(p: CurrentsProblem): Promise<Solution & { V: Float64Array; G: Float64Array; I: Float64Array; Vt: Float64Array }> {
  const timer = new StageTimer();
  const m = p.mesh, n = nNodes(m), nc = nCells(m), dim = m.dim, axi = !!m.axisym;
  if (dim === 1) throw new Error('currents: 1D meshes are not supported');
  if (p.thickness !== undefined && (dim !== 2 || axi)) throw new Error('currents: thickness applies to 2D planar models only');
  // cells with sigma <= 0 (insulators) are outside the conduction domain: in the mask they would leave nodes with an
  // all-zero row (singular matrix; audit FE item 2)
  const mask = Uint8Array.from(p.sigma, (v, c) => ((p.mask ? p.mask[c] : 1) && Number.isFinite(v) && v > 0 ? 1 : 0));
  if (!mask.some((x) => x)) throw new Error('currents: no conducting cell (sigma > 0) in the domain');
  const sig = Float64Array.from(p.sigma, (v, c) => (mask[c] ? v : 0));
  if (p.outOfPlane) return outOfPlane(p, mask, sig, timer);
  const A = timer.time('assemble', () => assembleCells(m, { k: sig, mask, weight: axi ? 'r' : 'none' }));
  const K = A.K!;
  // measure factor: 2 pi (axisym), thickness (2D with thickness), 1 (3D; 2D per unit depth)
  const fac = axi ? 2 * Math.PI : dim === 2 ? (p.thickness ?? 1) : 1;
  const perDepth = dim === 2 && !axi && p.thickness === undefined;
  const nt = p.terminals.length;
  for (const t of p.terminals) {
    if ((t.V === undefined) === (t.I === undefined)) throw new Error(`currents: terminal '${t.id}' needs exactly one of V or I`);
    if (t.I !== undefined && perDepth) throw new Error(`currents: terminal '${t.id}' sets a current (A): a 2D planar model needs settings.thickness`);
  }
  // Dirichlet sets; a node in two sets is an error (no overlap order)
  const role = new Int32Array(n).fill(-1);   // -1 free, 0..nt-1 terminal, nt ground, nt + 1 + k potential k
  const claim = (nodes: Int32Array, r: number, what: string) => {
    for (const v of nodes) {
      if (role[v]! >= 0 && role[v] !== r) throw new Error(`currents: ${what} shares a node with another fixed-potential boundary (${role[v]! < nt ? `terminal '${p.terminals[role[v]!]!.id}'` : role[v] === nt ? 'ground' : 'a potential boundary'})`);
      role[v] = r;
    }
  };
  const termNodes = p.terminals.map((t) => facetNodes(m, facetsOn(m, t.select)));
  termNodes.forEach((ns, i) => claim(ns, i, `terminal '${p.terminals[i]!.id}'`));
  if (p.ground?.length) claim(facetNodes(m, facetsOn(m, p.ground)), nt, 'ground');
  const pots = (p.potentials ?? []).map((x) => ({ nodes: facetNodes(m, facetsOn(m, x.select)), V: x.V }));
  pots.forEach((x, k) => claim(x.nodes, nt + 1 + k, 'a potential boundary'));
  if (p.insulation?.length) facetsOn(m, p.insulation);
  const fixed = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (!A.active[i] || role[i]! >= 0) fixed[i] = 1;
  const hasRef = !!p.ground?.length || pots.length > 0 || p.terminals.some((t) => t.V !== undefined);
  if (!hasRef) throw new Error('currents: no ground, potential or voltage terminal: the potential is not fixed');
  const free = Uint8Array.from(fixed, (f) => (f ? 0 : 1));
  const R = timer.time('assemble', () => restrict(A.pat, K, free));
  const S = new SpdSolver(R.pat, p.solver ?? 'cholesky');
  timer.time('factor', () => S.factor(R.val));
  const solveWith = (uc: Float64Array): Float64Array => {
    const b = new Float64Array(R.pat.n);
    for (let i = 0; i < n; i++) {
      if (!free[i]) continue;
      let s = 0;
      for (let z = A.pat.rowptr[i]!; z < A.pat.rowptr[i + 1]!; z++) { const c = A.pat.colidx[z]!; if (fixed[c]) s -= K[z]! * uc[c]!; }
      b[R.map[i]!] = s;
    }
    const x = timer.time('solve', () => S.solve(b));
    const u = uc.slice();
    for (let i = 0; i < n; i++) if (free[i]) u[i] = x[R.map[i]!]!;
    return u;
  };
  const U = termNodes.map((ns) => { checkAbort(p.signal); const uc = new Float64Array(n); for (const v of ns) uc[v] = 1; return solveWith(uc); });
  let Up: Float64Array | null = null;
  if (pots.length) {
    const uc = new Float64Array(n);
    const x = new Float64Array(dim);
    for (const pt of pots) for (const v of pt.nodes) {
      if (typeof pt.V === 'number') uc[v] = pt.V;
      else { for (let d = 0; d < dim; d++) x[d] = m.nodes[dim * v + d]!; uc[v] = pt.V(x); }
    }
    Up = solveWith(uc);
  }
  // conductance matrix and the potential-boundary currents (energy form)
  const t0 = performance.now();
  const KU = U.map((u) => { const o = new Float64Array(n); matVec(A.pat, K, u, o); return o; });
  const dot = (a: Float64Array, b: Float64Array) => { let s = 0; for (let i = 0; i < n; i++) s += a[i]! * b[i]!; return s; };
  const G = new Float64Array(nt * nt);
  for (let i = 0; i < nt; i++) for (let j = 0; j < nt; j++) G[i * nt + j] = fac * dot(U[i]!, KU[j]!);
  const Ip = Float64Array.from({ length: nt }, (_, i) => (Up ? fac * dot(Up, KU[i]!) : 0));
  const Vt = Float64Array.from(p.terminals, (t) => t.V ?? NaN);
  const cur = p.terminals.map((t, i) => (t.I !== undefined ? i : -1)).filter((i) => i >= 0);
  if (cur.length) {
    const vol = p.terminals.map((t, i) => (t.V !== undefined ? i : -1)).filter((i) => i >= 0);
    const Acc = cur.map((i) => cur.map((j) => G[i * nt + j]!));
    const rhs = cur.map((i) => p.terminals[i]!.I! - Ip[i]! - vol.reduce((s, j) => s + G[i * nt + j]! * Vt[j]!, 0));
    const vc = denseSolve(Acc, rhs);
    cur.forEach((i, k) => { Vt[i] = vc[k]!; });
  }
  const V = Up ? Up.slice() : new Float64Array(n);
  for (let j = 0; j < nt; j++) { const u = U[j]!, s = Vt[j]!; if (s !== 0) for (let i = 0; i < n; i++) V[i]! += s * u[i]!; }
  const I = Float64Array.from({ length: nt }, (_, i) => { let s = Ip[i]!; for (let j = 0; j < nt; j++) s += G[i * nt + j]! * Vt[j]!; return s; });
  const KV = new Float64Array(n); matVec(A.pat, K, V, KV);
  const P = fac * dot(V, KV);
  // cell means of E, J and sigma |grad V|^2 (quadrature exact for the P2 gradient products on straight cells)
  const k = NPC[m.cells.type], ord = cellOrder(m);
  const rule = defaultRule(m.cells.type, m.cells.type === 'hex8' ? 3 : 2 * ord + (axi ? 1 : 0));
  const tb = shapeTable(m.cells.type, rule);
  const X = new Float64Array(k * dim), Gr = new Float64Array(k * dim), g = new Float64Array(dim);
  const Ec = new Float64Array(nc * dim), Jc = new Float64Array(nc * dim), Qc = new Float64Array(nc);
  for (let e = 0; e < nc; e++) {
    if (!mask[e]) { for (let d = 0; d < dim; d++) { Ec[dim * e + d] = NaN; Jc[dim * e + d] = NaN; } Qc[e] = NaN; continue; }
    gatherX(m.nodes, dim, m.cells.conn, e, k, X);
    let wsum = 0, qs = 0;
    const es = new Float64Array(dim);
    for (let qp = 0; qp < rule.n; qp++) {
      let w = physGrad(tb, qp, X, dim, Gr) * rule.wts[qp]!;
      if (axi) { let rr = 0; for (let a = 0; a < k; a++) rr += tb.N[qp * k + a]! * X[dim * a]!; w *= rr; }
      g.fill(0);
      for (let a = 0; a < k; a++) { const va = V[m.cells.conn[k * e + a]!]!; for (let d = 0; d < dim; d++) g[d]! += Gr[dim * a + d]! * va; }
      let g2 = 0; for (let d = 0; d < dim; d++) { g2 += g[d]! ** 2; es[d]! -= g[d]! * w; }
      qs += sig[e]! * g2 * w; wsum += w;
    }
    for (let d = 0; d < dim; d++) { Ec[dim * e + d] = es[d]! / wsum; Jc[dim * e + d] = (sig[e]! * es[d]!) / wsum; }
    Qc[e] = qs / wsum;
  }
  timer.add('post', performance.now() - t0);
  const space: 'H1P1' | 'H1P2' = ord === 2 ? 'H1P2' : 'H1P1';
  const comps = dim as 2 | 3;
  const fields: Solution['fields'] = [
    { name: 'V', unit: 'V', space, components: 1, data: V },
    { name: 'E', unit: 'V/m', space: 'DG0', components: comps, data: Ec },
    { name: 'J', unit: 'A/m^2', space: 'DG0', components: comps, data: Jc },
    { name: 'Q', unit: 'W/m^3', space: 'DG0', components: 1, data: Qc },
  ];
  const uI = perDepth ? 'A/m' : 'A', uG = perDepth ? 'S/m' : 'S', uR = perDepth ? 'Ohm*m' : 'Ohm', uP = perDepth ? 'W/m' : 'W';
  const scalars: Solution['scalars'] = { P: scalar(P, uP) };
  p.terminals.forEach((t, i) => {
    scalars[`I_${t.id}`] = scalar(I[i]!, uI);
    scalars[`V_${t.id}`] = scalar(Vt[i]!, 'V');
    scalars[`R_${t.id}`] = scalar(1 / G[i * nt + i]!, uR);
    p.terminals.forEach((t2, j) => { scalars[`G_${t.id}_${t2.id}`] = scalar(G[i * nt + j]!, uG); });
  });
  const sol = await makeSolution({
    mesh: m, ...(p.spec !== undefined ? { spec: p.spec } : { problemDigest: { physics: 'currents', terminals: p.terminals.map((t) => t.id), n } }),
    fields, scalars, stats: { dof: R.pat.n, nnz: R.pat.nnz, solver: S.kind }, timer,
  });
  attachMesh(sol, m);
  return Object.assign(sol, { V, G, I, Vt });
}

/** Out-of-plane drive of a 2D section (formulation in the file header). */
async function outOfPlane(p: CurrentsProblem, mask: Uint8Array, sig: Float64Array, timer: StageTimer): Promise<Solution & { V: Float64Array; G: Float64Array; I: Float64Array; Vt: Float64Array }> {
  const m = p.mesh, nc = nCells(m), o = p.outOfPlane!;
  if (m.dim !== 2 || m.axisym) throw new Error('currents: outOfPlane applies to 2D planar models only');
  if (p.thickness !== undefined) throw new Error('currents: outOfPlane and thickness exclude each other (the out-of-plane axis is the current direction)');
  if (p.terminals.length || p.ground?.length || p.potentials?.length) throw new Error('currents: outOfPlane takes no terminal, ground or potential condition (insulation only)');
  const forms = [o.Ez !== undefined, o.V !== undefined || o.length !== undefined, o.I !== undefined].filter(Boolean).length;
  if (forms !== 1 || ((o.V === undefined) !== (o.length === undefined))) throw new Error('currents: outOfPlane needs exactly one of Ez, V with length, or I');
  if (p.insulation?.length) facetsOn(m, p.insulation);
  const Gp = timer.time('assemble', () => { const a = assembleCells(m, { mask, weight: 'none', f: sig }); let x = 0; for (const v of a.F!) x += v; return x; });
  if (!(Gp > 0)) throw new Error('currents: outOfPlane: the section conducts no current (int sigma dA = 0)');
  const Ez = o.Ez ?? (o.V !== undefined ? o.V / o.length! : o.I! / Gp);
  const E = new Float64Array(3 * nc), J = new Float64Array(3 * nc), Q = new Float64Array(nc);
  for (let c = 0; c < nc; c++) {
    if (!mask[c]) { E.fill(NaN, 3 * c, 3 * c + 3); J.fill(NaN, 3 * c, 3 * c + 3); Q[c] = NaN; continue; }
    E[3 * c + 2] = Ez; J[3 * c + 2] = sig[c]! * Ez; Q[c] = sig[c]! * Ez * Ez;
  }
  const fields: Solution['fields'] = [
    { name: 'E', unit: 'V/m', space: 'DG0', components: 3, data: E },
    { name: 'J', unit: 'A/m^2', space: 'DG0', components: 3, data: J },
    { name: 'Q', unit: 'W/m^3', space: 'DG0', components: 1, data: Q },
  ];
  const I = Ez * Gp;
  const scalars: Solution['scalars'] = { Ez: scalar(Ez, 'V/m'), I: scalar(I, 'A'), P: scalar(Ez * Ez * Gp, 'W/m'), R_per_length: scalar(1 / Gp, 'Ohm/m'), ...(o.length !== undefined ? { V: scalar(Ez * o.length, 'V'), R: scalar(o.length / Gp, 'Ohm') } : {}) };
  const sol = await makeSolution({
    mesh: m, ...(p.spec !== undefined ? { spec: p.spec } : { problemDigest: { physics: 'currents', outOfPlane: o } }),
    fields, scalars, stats: { dof: 0, solver: 'out-of-plane (closed form per cell)' }, timer,
  });
  attachMesh(sol, m);
  return Object.assign(sol, { V: new Float64Array(0), G: Float64Array.of(Gp), I: Float64Array.of(I), Vt: new Float64Array(0) });
}

// ------------------------------------------------------------------------------------------------- spec binding

export const CURRENTS_BCS = ['ground', 'potential', 'terminal', 'insulation'] as const;

export function currentsProblemFromContext(ctx: RunContext): CurrentsProblem {
  const spec = ctx.spec as Spec, m = ctx.mesh;
  const { mask, values } = cellProps(ctx, ['sigma']);
  const ph = physicsNode(spec, ctx.physicsId) as { settings?: { thickness?: unknown; outOfPlane?: Record<string, unknown> } };
  const terminals: CurrentsTerminal[] = [], ground: string[] = [], insulation: string[] = [];
  const potentials: NonNullable<CurrentsProblem['potentials']> = [];
  for (const b of bcsOf(spec, ctx.physicsId)) {
    const s = b.settings ?? {};
    if (b.type === 'ground') ground.push(...b.select);
    else if (b.type === 'insulation') insulation.push(...b.select);
    else if (b.type === 'potential') {
      const f = compileField(spec, s.V, spaceOf(m), `${b.id}.V`, 'space');
      potentials.push({ select: b.select, V: typeof f === 'number' ? f : (x) => f(x, 0) });
    } else if (b.type === 'terminal') {
      const t: CurrentsTerminal = { id: b.id, select: b.select };
      if (s.V !== undefined) t.V = qty(spec, s.V, `${b.id}.V`);
      if (s.I !== undefined) t.I = qty(spec, s.I, `${b.id}.I`);
      terminals.push(t);
    } else throw new Error(`currents: unsupported condition '${b.type}'`);
  }
  const p: CurrentsProblem = { mesh: m, sigma: values.sigma!, mask, terminals, ground, potentials, insulation, spec, signal: ctx.signal };
  // materials with sigma <= 0 in the physics domains: outside the conduction domain (named in a note)
  const zero: string[] = [];
  for (const mat of spec.materials ?? []) {
    const v = ctx.materials[mat.id]?.sigma;
    if (typeof v !== 'number' || v > 0) continue;
    const doms = new Set(selectEntities(m.entities, 'domains', mat.select));
    for (let c = 0; c < mask.length; c++) if (mask[c] && doms.has(m.cells.domain[c]!)) { zero.push(mat.id); break; }
  }
  if (zero.length) p.notes = [`currents: material(s) ${zero.map((x) => `'${x}'`).join(', ')} have sigma <= 0: their cells are outside the conduction domain (no V, E, J or Q there)`];
  if (ph.settings?.thickness !== undefined) p.thickness = qty(spec, ph.settings.thickness, 'settings.thickness');
  const op = ph.settings?.outOfPlane;
  if (op) {
    p.outOfPlane = {};
    for (const k of ['Ez', 'V', 'length', 'I'] as const) if (op[k] !== undefined) p.outOfPlane[k] = qty(spec, op[k], `settings.outOfPlane.${k}`);
  }
  return p;
}

export const currentsModule: PhysicsModule = {
  type: 'currents',
  dims: ['2d', '2d-axisym', '3d'],
  readiness(spec, physicsId) {
    const reasons: string[] = [];
    try {
      const ph = physicsNode(spec as Spec, physicsId) as { bcs?: Array<{ id: string; type: string; settings?: Record<string, unknown> }>; settings?: { thickness?: unknown; outOfPlane?: Record<string, unknown> }; select?: string[] };
      if (!ph.select?.length) reasons.push('physics has no domain selection');
      const ok = new Set<string>(CURRENTS_BCS);
      for (const b of ph.bcs ?? []) if (!ok.has(b.type)) reasons.push(`unsupported condition '${b.type}'`);
      const bcs = ph.bcs ?? [];
      for (const b of bcs.filter((x) => x.type === 'terminal')) {
        const s = b.settings ?? {};
        if ((s.V === undefined) === (s.I === undefined)) reasons.push(`terminal '${b.id}' needs exactly one of settings.V or settings.I`);
      }
      const geo = (spec as Spec).geometry as { dim?: number; axisym?: boolean } | undefined;
      const planar2d = geo?.dim === 2 && !geo.axisym;
      const op = ph.settings?.outOfPlane;
      if (op) {
        if (!planar2d) reasons.push('settings.outOfPlane applies to 2D planar models only');
        if (ph.settings?.thickness !== undefined) reasons.push('settings.outOfPlane and settings.thickness exclude each other');
        const forms = [op.Ez !== undefined, op.V !== undefined || op.length !== undefined, op.I !== undefined].filter(Boolean).length;
        if (forms !== 1 || ((op.V === undefined) !== (op.length === undefined))) reasons.push('settings.outOfPlane needs exactly one of Ez, V with length, or I');
        for (const b of bcs) if (b.type !== 'insulation') reasons.push(`condition '${b.id}' (${b.type}): an out-of-plane drive takes insulation conditions only`);
        return { ready: !reasons.length, reasons };
      }
      const fixedRef = bcs.some((b) => b.type === 'ground' || b.type === 'potential' || (b.type === 'terminal' && b.settings?.V !== undefined));
      if (!fixedRef) reasons.push('no ground, potential or voltage terminal (the potential is not fixed)');
      if (planar2d && ph.settings?.thickness === undefined && bcs.some((b) => b.type === 'terminal' && b.settings?.I !== undefined)) reasons.push('a current terminal (A) in a 2D planar model needs settings.thickness');
      if (!planar2d && ph.settings?.thickness !== undefined) reasons.push('settings.thickness applies to 2D planar models only');
    } catch (e) { reasons.push((e as Error).message); }
    return { ready: !reasons.length, reasons };
  },
  async run(ctx) {
    ctx.progress('assemble', 0);
    const p = currentsProblemFromContext(ctx);
    const s = await solveCurrents(p);
    if (p.notes?.length) (s as Solution & { notes?: string[] }).notes = [...((s as { notes?: string[] }).notes ?? []), ...p.notes];
    ctx.progress('done', 1);
    return s;
  },
};
