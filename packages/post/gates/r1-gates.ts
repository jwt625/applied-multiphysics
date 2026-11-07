// SPDX-License-Identifier: GPL-3.0-or-later
// R1 gates 1-6 (DevLog-023 s.4 R1; DevLog-026 s.2): real engine solves of sims/kirsch-exact.yaml and sims/coax-line.yaml
// through the eval-harness path (prepareRun with hFactor from the eval case's convergence.h_factors: nested levels by
// refineUniform; module.run), then the R1 kernels against closed forms. Rule: the error decreases at the element's
// expected order between nested levels (observed order of the last pair >= 0.75 x expected, the harness band of 25 %
// used as a lower bound; the error must decrease at every refinement), or every level is at the round-off floor; the
// finest-level error is reported. No absolute tolerance. The `results` section of the sims is dropped before the solve
// (it does not enter the solve; lane R0 changes its schema in parallel).

import { readFileSync } from 'node:fs';
import { parseYaml, resolveParams } from '@amp/spec';
import { prepareRun, registry } from '@amp/physics';
import type { Mesh, Solution } from '@amp/spec/types';
import { NPC } from '@amp/physics/common/mesh';
import { dimEq, parseUnit } from '@amp/core/units';
import { attachMesh, cutLine, edgeDataset, evalIntegral, evalMeasure, evalPoint, facetsOfBoundaries, type LineDataset, type PointSet, type ParamScope } from '../src/index.ts';

const root = new URL('../../../', import.meta.url);
const read = (rel: string) => readFileSync(new URL(rel, root), 'utf8');

export interface Level { hFactor: number; mesh: Mesh; sol: Solution; dof: number; ms: number }
export interface GateRow {
  gate: string; quantity: string; unit: string; expected_order: number;
  levels: Array<{ hFactor: number; dof: number; value?: number; error: number }>;
  orders: number[]; finest_error: number; finest_rel: number | null; status: 'pass' | 'fail' | 'info'; basis: string; note?: string;
}

function specOf(rel: string): Record<string, unknown> {
  const spec = parseYaml(read(rel)).data as Record<string, unknown>;
  delete spec.results;
  return spec;
}

export function hFactorsOf(caseRel: string): number[] {
  const c = parseYaml(read(caseRel)).data as { convergence?: { h_factors?: number[] } };
  const hf = c.convergence?.h_factors;
  if (!hf?.length) throw new Error(`${caseRel}: no convergence.h_factors`);
  return hf;
}

/** Levels as the eval engine worker builds them: prepareRun({case, spec, physicsId, level, hFactor}) then module.run
 *  (stationary studies: no dtFactor). */
export async function solveLevels(simRel: string, hFactors: number[], caseRel?: string): Promise<{ levels: Level[]; params: ParamScope }> {
  const spec = specOf(simRel);
  const kase = caseRel ? (parseYaml(read(caseRel)).data as Record<string, unknown>) : undefined;
  const physicsId = String(((spec.physics as Array<{ id?: unknown }> | undefined) ?? [])[0]?.id ?? '');
  const levels: Level[] = [];
  for (const [i, hFactor] of hFactors.entries()) {
    const t0 = performance.now();
    const ctx = await prepareRun({ ...(kase ? { case: kase } : {}), spec, physicsId, hFactor, level: i });
    const type = (ctx.spec.physics ?? []).find((p) => p.id === ctx.physicsId)!.type;
    const sol = attachMesh(await registry[type]!.run(ctx), ctx.mesh);
    levels.push({ hFactor, mesh: ctx.mesh, sol, dof: sol.stats.dof, ms: performance.now() - t0 });
  }
  return { levels, params: resolveParams(spec.params).scope };
}

const ROUNDOFF = 1e-12;   // relative error floor: below it on every level the value is exact to round-off

function verdict(gate: string, quantity: string, unit: string, p: number, lv: Level[], err: number[], scale: number, value?: number[], note?: string, info = false): GateRow {
  const orders: number[] = [];
  for (let k = 0; k + 1 < err.length; k++) orders.push(err[k]! > 0 && err[k + 1]! > 0 ? Math.log(err[k]! / err[k + 1]!) / Math.log(lv[k]!.hFactor / lv[k + 1]!.hFactor) : NaN);
  const floor = err.every((e) => e <= ROUNDOFF * scale);
  const decreasing = err.every((e, k) => k === 0 || e < err[k - 1]!);
  const ok = floor || (decreasing && orders[orders.length - 1]! >= 0.75 * p);
  return {
    gate, quantity, unit, expected_order: p,
    levels: lv.map((l, k) => ({ hFactor: l.hFactor, dof: l.dof, ...(value ? { value: value[k]! } : {}), error: err[k]! })),
    orders, finest_error: err[err.length - 1]!, finest_rel: scale ? err[err.length - 1]! / scale : null,
    status: info ? 'info' : ok ? 'pass' : 'fail', basis: floor ? `round-off floor (< ${ROUNDOFF} relative on every level)` : `observed order of the last pair >= 0.75 x ${p}, decreasing`,
    ...(note ? { note } : {}),
  };
}

/** Points of a line used for the max error: the element-crossing points (piece start, middle, end) and n uniform points. */
function linePts(mesh: Mesh, p0: number[], p1: number[], snap = 0): { sets: Array<{ ps: PointSet; s: Float64Array }>; line: LineDataset } {
  const C = cutLine(mesh, p0, p1, { mode: 'crossing' }), U = cutLine(mesh, p0, p1, { n: 1001, ...(snap ? { snap } : {}) });
  return { sets: [{ ps: C.points, s: C.s }, { ps: U.points, s: U.s }, { ps: C.quad.points, s: C.quad.s! }], line: C };
}

function maxErr(sol: Solution, expr: string, sets: Array<{ ps: PointSet; s: Float64Array }>, exact: (i: number, ps: PointSet, s: Float64Array) => number, o: { params?: ParamScope; defs?: Record<string, string>; physicsId?: string }): number {
  let m = 0;
  for (const { ps, s } of sets) {
    const v = evalPoint(sol, expr, ps, o).values;
    for (let i = 0; i < ps.n; i++) if (ps.cell[i]! >= 0) m = Math.max(m, Math.abs(v[i]! - exact(i, ps, s)));
  }
  return m;
}

/** Warm timing (median of 5 after one warm-up) of a cut line (500 points + crossings, sxx at the points) and of a
 *  domain integral of solid.mises, per Kirsch level (DevLog-023 s.3.7 budgets). */
function bench(levels: Level[]): Array<{ hFactor: number; dof: number; cutline500_ms: number; domain_integral_ms: number }> {
  const med = (f: () => void) => { f(); const t: number[] = []; for (let i = 0; i < 5; i++) { const t0 = performance.now(); f(); t.push(performance.now() - t0); } return +t.sort((a, b) => a - b)[2]!.toFixed(2); };
  return levels.map((l) => ({
    hFactor: l.hFactor, dof: l.dof,
    cutline500_ms: med(() => { const c = cutLine(l.mesh, [0, 0.005], [0.05, 0.05], { n: 500 }); evalPoint(l.sol, 'solid.sxx', c.points); }),
    domain_integral_ms: med(() => { evalIntegral(l.sol, 'solid.mises', { kind: 'domain' }); }),
  }));
}

export async function runR1Gates(opt: { bench?: boolean } = {}): Promise<{ rows: GateRow[]; runs: Array<{ sim: string; levels: Array<{ hFactor: number; dof: number; cells: number; ms: number; meshHash: string }> }>; bench?: ReturnType<typeof bench> }> {
  const rows: GateRow[] = [];
  // ---------------------------------------------------------------------------------------------------- Kirsch
  // the case levels plus one more halving (still nested): with three levels the gate-3 error is pre-asymptotic, its
  // near-hole (+) and far-field (-) parts cancel (DevLog-026 s.4)
  const hk = hFactorsOf('eval/cases/a/SM-01.yaml');
  const K = await solveLevels('sims/kirsch-exact.yaml', [...hk, hk[hk.length - 1]! / 2], 'eval/cases/a/SM-01.yaml');
  const P = K.params as ReadonlyMap<string, { si: number }>;
  const a = P.get('a')!.si, L = P.get('L')!.si, s = P.get('s_inf')!.si;
  const o = { params: K.params, physicsId: 'solid' };
  const kx = (y: number) => s * (1 + (a * a) / (2 * y * y) + (3 * a ** 4) / (2 * y ** 4));         // sigma_xx(0, y)
  const ky = (x: number) => s * (1 - (5 * a * a) / (2 * x * x) + (3 * a ** 4) / (2 * x ** 4));     // sigma_xx(x, 0)
  const I3 = s * ((L - a) + (a * a / 2) * (1 / a - 1 / L) + (a ** 4 / 2) * (1 / a ** 3 - 1 / L ** 3));
  const g1: number[] = [], g2: number[] = [], g3: number[] = [], g3v: number[] = [], g3l1: number[] = [], g3near: number[] = [], g3far: number[] = [], g4: number[] = [], g4p: number[] = [], g6: number[] = [], g6v: number[] = [], poly: number[] = [];
  const A6 = L * L - (Math.PI * a * a) / 4;
  for (const l of K.levels) {
    const m = l.mesh;
    const X = linePts(m, [0, a], [0, L]);
    g1.push(maxErr(l.sol, 'solid.sxx', X.sets, (i, ps) => kx(ps.x[2 * i + 1]!), o));
    const Y = linePts(m, [a, 0], [L, 0]);
    g2.push(maxErr(l.sol, 'solid.sxx', Y.sets, (i, ps) => ky(ps.x[2 * i]!), o));
    const I = evalIntegral(l.sol, 'solid.sxx', X.line, o);
    if (!dimEq(I.dim, parseUnit('N/m').dim)) throw new Error(`gate 3 unit ${I.unit} (N/m expected)`);
    g3v.push(I.value); g3.push(Math.abs(I.value - I3));
    // L1 line error int |sigma_h - sigma| ds over the same quadrature (no cancellation): information
    // and the signed error split at y = 2a (near the hole / far field): the parts cancel in the gate-3 error
    {
      const q = X.line.quad, v = evalPoint(l.sol, 'solid.sxx', q.points, o).values;
      let e = 0, en = 0, ef = 0;
      for (let i = 0; i < q.points.n; i++) { const y = q.points.x[2 * i + 1]!, d = (v[i]! - kx(y)) * q.w[i]!; e += Math.abs(d); if (y < 2 * a) en += d; else ef += d; }
      g3l1.push(e); g3near.push(en); g3far.push(ef);
    }
    const E = edgeDataset(m, ['bnd:hole.edge']);
    const stt = 'sxx*sin(th)^2 + syy*cos(th)^2 - 2*sxy*sin(th)*cos(th)', defs = { th: 'atan2(y, x)' };
    const exact4 = (i: number, ps: PointSet) => { const x = ps.x[2 * i]!, y = ps.x[2 * i + 1]!, r2 = x * x + y * y; return s * (1 - 2 * ((x * x - y * y) / r2)); };
    g4.push(maxErr(l.sol, stt, [{ ps: E.points, s: E.s }, { ps: E.quad.points, s: E.quad.s! }], exact4, { ...o, defs }));
    g4p.push(Math.abs(evalPoint(l.sol, stt, [[0, a]], { ...o, defs }).values[0]! - 3 * s));
    const A = evalMeasure(m, { kind: 'domain', ids: ['dom:plate'] });
    g6v.push(A.value); g6.push(Math.abs(A.value - A6));
    // polygonal (chord) hole with the same corner nodes: excess area sum (a^2/2)(theta - sin theta) per facet
    let ex = 0;
    const kf = NPC[m.facets.type];
    for (const f of facetsOfBoundaries(m, ['bnd:hole.edge'])) {
      const n0 = m.facets.conn[kf * f]!, n1 = m.facets.conn[kf * f + 1]!;
      const t0 = Math.atan2(m.nodes[2 * n0 + 1]!, m.nodes[2 * n0]!), t1 = Math.atan2(m.nodes[2 * n1 + 1]!, m.nodes[2 * n1]!), th = Math.abs(t1 - t0);
      ex += (a * a / 2) * (th - Math.sin(th));
    }
    poly.push(ex);
  }
  const lv = K.levels;
  rows.push(verdict('1', 'max |sigma_xx(0, y) - Kirsch|, y in [a, L]', 'Pa', 2, lv, g1, s));
  rows.push(verdict('2', 'max |sigma_xx(x, 0) - Kirsch|, x in [a, L]', 'Pa', 2, lv, g2, s));
  rows.push(verdict('3', 'int_a^L sigma_xx(0, y) dy', 'N/m', 2, lv, g3, Math.abs(I3), g3v, `closed form ${I3.toPrecision(9)} N/m`));
  rows.push(verdict('3i', 'int_a^L |sigma_xx,h - sigma_xx| dy (L1 line error, information)', 'N/m', 2, lv, g3l1, Math.abs(I3), undefined, undefined, true));
  rows.push(verdict('3n', 'signed error of int sigma_xx dy over y in [a, 2a] (information; value column = signed)', 'N/m', 2, lv, g3near.map(Math.abs), Math.abs(I3), g3near, undefined, true));
  rows.push(verdict('3f', 'signed error of int sigma_xx dy over y in [2a, L] (information; value column = signed)', 'N/m', 2, lv, g3far.map(Math.abs), Math.abs(I3), g3far, undefined, true));
  rows.push(verdict('4', 'max |sigma_thetatheta - s_inf (1 - 2 cos 2 theta)| on bnd:hole.edge', 'Pa', 2, lv, g4, s, undefined, 'expression sxx*sin(th)^2 + syy*cos(th)^2 - 2*sxy*sin(th)*cos(th), defs th = atan2(y, x); evaluated at the facet nodes and the facet Gauss points'));
  rows.push(verdict('4b', '|sigma_thetatheta(0, a) - 3 s_inf|', 'Pa', 2, lv, g4p, 3 * s));
  rows.push(verdict('6', '|area(dom:plate) - (L^2 - pi a^2/4)|', 'm^2', 4, lv, g6, A6, g6v,
    `chord-polygon hole with the same corner nodes: excess ${poly.map((v) => v.toExponential(3)).join(', ')} m^2 per level (order 2); the P2 isoparametric arcs give the error column; both are geometry (hole discretization) errors, the quadrature is exact for the isoparametric map`));
  // ------------------------------------------------------------------------------------------------------ coax
  const C = await solveLevels('sims/coax-line.yaml', hFactorsOf('eval/cases/a/EM-01.yaml'), 'eval/cases/a/EM-01.yaml');
  const Q = C.params as ReadonlyMap<string, { si: number }>;
  const ra = Q.get('a')!.si, rb = Q.get('b')!.si, lnba = Math.log(rb / ra);
  const phi = 0.3;   // radial line at a generic angle (not along a mesh symmetry), rad
  const e5v: number[] = [], e5e: number[] = [], e5i: number[] = [], e5iv: number[] = [], e5g: number[] = [], e5c: number[] = [];
  const oc = { params: C.params, physicsId: 'es' };
  for (const l of C.levels) {
    const p0 = [ra * Math.cos(phi), ra * Math.sin(phi)], p1 = [rb * Math.cos(phi), rb * Math.sin(phi)];
    const X = linePts(l.mesh, p0, p1, 1e-6);
    const rOf = (i: number, ps: PointSet) => Math.sqrt(ps.x[2 * i]! ** 2 + ps.x[2 * i + 1]! ** 2);
    e5v.push(maxErr(l.sol, 'es.V', X.sets, (i, ps) => Math.log(rb / rOf(i, ps)) / lnba, oc));
    e5e.push(maxErr(l.sol, '-d(es.V, r)', X.sets, (i, ps) => 1 / (rOf(i, ps) * lnba), oc));
    // the integral on the line along phi = 0 (its ends are mesh nodes on both conductors at every level)
    const X0 = cutLine(l.mesh, [ra, 0], [rb, 0], { mode: 'crossing' });
    const I = evalIntegral(l.sol, '-d(es.V, r)', X0, oc);
    if (!dimEq(I.dim, parseUnit('V').dim)) throw new Error(`gate 5 unit ${I.unit} (V expected)`);
    e5iv.push(I.value); e5i.push(Math.abs(I.value - 1));
    // at phi = 0.3 the line end r = a lies off the discretized conductor: V_h(a) != 1 (geometry), information only;
    // kernel consistency: the quadrature reproduces V_h(start) - V_h(end)
    const Ig = evalIntegral(l.sol, '-d(es.V, r)', X.line, oc), Vp = evalPoint(l.sol, 'es.V', X.line.points, oc).values;
    e5g.push(Math.abs(Ig.value - 1)); e5c.push(Math.abs(Ig.value - (Vp[0]! - Vp[Vp.length - 1]!)));
  }
  const lc = C.levels;
  rows.push(verdict('5a', 'max |V(r) - ln(b/r)/ln(b/a)| on a radial cut line', 'V', 3, lc, e5v, 1));
  rows.push(verdict('5b', 'max |-d(es.V, r) - 1/(r ln(b/a))| on the cut line', 'V/m', 2, lc, e5e, 1 / (ra * lnba)));
  rows.push(verdict('5c', '|int_a^b E_r dr - 1 V| on the cut line phi = 0 (identity check of the cut-line quadrature)', 'V', 2, lc, e5i, 1, e5iv, 'an identity, not a convergence test: for any discrete solution with V_h = 1 / 0 at the conductor nodes the integral of -dV_h/ds over the element pieces is V_h(a) - V_h(b) = 1, up to the Gauss 3 error on curved cells; it passes on the round-off floor and tests the crossing quadrature and d() only'));
  rows.push(verdict('5d', '|int E_r ds - 1 V| on the cut line phi = 0.3 rad (information)', 'V', 2, lc, e5g, 1, undefined, 'r = a at phi = 0.3 lies inside the mesh, off the P2 arc of the conductor, so V_h(a) != 1: a geometry error that oscillates with the node positions (not monotone)', true));
  rows.push(verdict('5e', '|int E_r ds - (V_h(start) - V_h(end))| on phi = 0.3 (kernel consistency)', 'V', 2, lc, e5c, 1, undefined, undefined, true));
  return {
    rows, ...(opt.bench ? { bench: bench(K.levels) } : {}),
    runs: [{ sim: 'sims/kirsch-exact.yaml', levels: K.levels }, { sim: 'sims/coax-line.yaml', levels: C.levels }].map((r) => ({
      sim: r.sim, levels: r.levels.map((l) => ({ hFactor: l.hFactor, dof: l.dof, cells: l.mesh.cells.conn.length / NPC[l.mesh.cells.type], ms: +l.ms.toFixed(1), meshHash: l.mesh.hash })),
    })),
  };
}
