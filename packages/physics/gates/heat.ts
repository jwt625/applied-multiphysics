// SPDX-License-Identifier: GPL-3.0-or-later
// H2 gates: HT-01 (NAFEMS T4), HT-02 (NAFEMS T3), HT-03 (NAFEMS T2), HT-04 (Carslaw-Jaeger semi-infinite solid).
// Material values and BCs from eval/cases/a/HT-0x.yaml; references from eval/expected/HT-0x.json.
// Usage: nice -n 10 node --max-old-space-size=1536 gates/heat.ts [HT-01 HT-02 ...]

import { rectTriMesh } from '../src/common/mesh.ts';
import { solveHeat, type HeatProblem } from '../src/heat/index.ts';
import { sample } from '../../post/src/index.ts';
import { readCase, caseTarget, GateLog, waitForLoad, evaluate, printTable, speedLine, ExitCode, type Level, type Target } from './common.ts';
import { buildGeometry2D } from '@amp/geom';
import { mesh2d } from '@amp/mesh';

const ZC = 273.15; // K at 0 degC (definition of the Celsius scale)
const only = process.argv.slice(2);
const want = (id: string) => !only.length || only.includes(id);
const log = new GateLog('heat');
const summary: Record<string, unknown>[] = [];

const exit = new ExitCode();

/** One level: mesh build (timed, stage 'mesh') + solve + probes. */
async function level(i: number, h: number, mk: () => HeatProblem, probes: Record<string, number[]>, step?: number): Promise<Level> {
  const t0 = performance.now();
  const p = mk();
  const tm = performance.now() - t0;
  const s = await solveHeat(p);
  const wall = performance.now() - t0;
  const values: Record<string, number> = {};
  for (const [k, pt] of Object.entries(probes)) values[k] = sample(s, 'T', pt, step === undefined ? {} : { step })[0]! - ZC;
  return { level: i, h, dof: s.stats.dof, wall_ms: wall, stages: { mesh: +tm.toFixed(1), ...Object.fromEntries(Object.entries(s.timing).map(([a, b]) => [a, +b.toFixed(1)])) }, values };
}

function finish(id: string, levels: Level[], targets: Target[]) {
  const res = evaluate(levels, targets);
  printTable(id, levels, res, log);
  speedLine(id, levels, targets, res, log);
  exit.add(res);
  summary.push({ id, status: res.map((r) => `${r.target}:${r.status}`) });
}

await waitForLoad();

if (want('HT-01')) {
  const c = readCase('a', 'HT-01');
  const k = c.materials.plate.k as number;
  const [Lx, Ly] = c.geometry.spec.plate_m as [number, number];
  const [ex, ey] = c.geometry.spec.points_m.E as [number, number];
  const bc = c.bcs as Array<Record<string, any>>;
  // P2 point value: theoretical order 3 (L-infinity, smooth solution away from the Dirichlet / convection corner)
  const targets: Target[] = [caseTarget('a', 'HT-01', 'T_E', { order: 3 })];
  const ref = { value: targets[0]!.ref };
  const levels: Level[] = [];
  for (const [i, n] of [5, 10, 20, 40].entries()) {
    levels.push(await level(i, Ly / n, () => { const m = rectTriMesh({ x: [0, Lx], y: [0, Ly], nx: Math.round(n * Lx / Ly * 1.5), ny: Math.round(n * 1.5), order: 2 }); const nc = m.cells.conn.length / 6; return {
      mesh: m, k: new Float64Array(nc).fill(k), bcs: [
        { type: 'temperature', select: ['bnd:rect.bottom'], T: bc[0]!.value },
        { type: 'insulation', select: ['bnd:rect.left'] },
        { type: 'convection', select: ['bnd:rect.right', 'bnd:rect.top'], h: bc[2]!.h, T_ext: bc[2]!.T_inf },
      ] }; }, { T_E: [ex, ey] }));
  }
  finish('HT-01', levels, targets);
  // cross-check on the L3 unstructured mesher (tri6), one level
  const g = buildGeometry2D({ features: [{ id: 'plate', type: 'rect', x: [0, Lx], y: [0, Ly] }] });
  const mu = mesh2d(g, { hmax: Ly / 40, order: 2 });
  const nc = mu.cells.conn.length / 6;
  const lu = await level(0, Ly / 40, () => ({ mesh: mu, k: new Float64Array(nc).fill(k), bcs: [
    { type: 'temperature', select: ['bnd:plate.bottom'], T: bc[0]!.value },
    { type: 'convection', select: ['bnd:plate.right', 'bnd:plate.top'], h: bc[2]!.h, T_ext: bc[2]!.T_inf }] }), { T_E: [ex, ey] });
  console.log(`  L3 mesh2d tri6 hmax ${Ly / 40}: dof ${lu.dof}, T_E ${lu.values.T_E!.toPrecision(10)} degC, rel err ${((lu.values.T_E! - ref.value) / ref.value).toExponential(2)}, ${lu.wall_ms.toFixed(1)} ms`);
  log.write({ kind: 'crosscheck', id: 'HT-01', mesher: 'L3 mesh2d', level: lu });
}

if (want('HT-02')) {
  const c = readCase('a', 'HT-02');
  const { k, cp, rho } = c.materials.bar as { k: number; cp: number; rho: number };
  const L = c.geometry.spec.bar_m as number;
  const tEnd = 32;
  // h and dt halved together; BDF2 time error dominates: theoretical order 2
  const targets: Target[] = [{ ...caseTarget('a', 'HT-02', 'T_x0.08_t32', { order: 2 }), id: 'T' }];
  const T0 = c.initial.T as number;
  const levels: Level[] = [];
  // BC at x = L from the case: 273.15 + 100 sin(pi t / 40) K
  const TL = (_x: Float64Array, t: number) => ZC + 100 * Math.sin((Math.PI * t) / 40);
  for (const [i, n] of [5, 10, 20, 40].entries()) {
    const dt = tEnd / (8 * 2 ** i);
    levels.push(await level(i, dt, () => { const m = rectTriMesh({ x: [0, L], y: [0, L / 10], nx: n, ny: 1, order: 2 }); const nc = m.cells.conn.length / 6; return {
      mesh: m, k: new Float64Array(nc).fill(k), rhoCp: new Float64Array(nc).fill(rho * cp),
      bcs: [{ type: 'temperature', select: ['bnd:rect.left'], T: c.bcs[0].value }, { type: 'temperature', select: ['bnd:rect.right'], T: TL }],
      transient: { t0: 0, t1: tEnd, dt, T0, save: [tEnd], method: 'bdf2' } }; }, { T: [0.08, L / 20] }));
  }
  finish('HT-02', levels, targets);
}

if (want('HT-03')) {
  const c = readCase('a', 'HT-03');
  const k = c.materials.rod.k as number;
  const L = c.geometry.spec.rod_m as number;
  // 1D linear conduction: P1 is nodally exact, so the finest level is gated (case tolerance without Richardson)
  const targets: Target[] = [{ ...caseTarget('a', 'HT-03', 'T_B.k55.6.sigma_codata'), id: 'T_B', after: 'finest' }];
  const levels: Level[] = [];
  for (const [i, n] of [2, 4, 8].entries()) {
    levels.push(await level(i, L / n, () => { const m = rectTriMesh({ x: [0, L], y: [0, L / 10], nx: n, ny: 1, order: 1 }); const nc = m.cells.conn.length / 3; return {
      mesh: m, k: new Float64Array(nc).fill(k),
      bcs: [{ type: 'temperature', select: ['bnd:rect.left'], T: c.bcs[0].value }, { type: 'radiation', select: ['bnd:rect.right'], emissivity: c.bcs[1].emissivity, T_amb: c.bcs[1].T_amb }] }; }, { T_B: [L, L / 20] }));
  }
  // probe returns degC; compare in K
  for (const l of levels) l.values.T_B! += ZC;
  finish('HT-03', levels, targets);
}

if (want('HT-04')) {
  const c = readCase('a', 'HT-04');
  const { k, rho, c: cp } = c.materials.steel as { k: number; rho: number; c: number };
  const [x0, x1] = c.geometry.spec.domain_m as [number, number];
  const depths = [0.0223, 0.0859, 0.1866, 0.3462];
  const ids = ['T_x0.0223_t2000', 'T_x0.0859_t2000', 'T_x0.1866_t2000', 'T_x0.3462_t2000'];
  const targets: Target[] = ids.map((id, j) => ({ ...caseTarget('a', 'HT-04', id, { order: 2 }), id: `T_${depths[j]}` }));
  const levels: Level[] = [];
  const tEnd = c.study.t_end as number;
  for (const [i, n] of [20, 40, 80, 160].entries()) {
    // grading: x = L s^2 concentrates cells at the heated face
    const dt = tEnd / (10 * 2 ** i);
    const probes: Record<string, number[]> = {};
    depths.forEach((d) => { probes[`T_${d}`] = [d, 0.005]; });
    levels.push(await level(i, dt, () => { const m = rectTriMesh({ x: [x0, x1], y: [0, 0.01], nx: n, ny: 1, order: 2, xs: (s) => s * s }); const nc = m.cells.conn.length / 6; return {
      mesh: m, k: new Float64Array(nc).fill(k), rhoCp: new Float64Array(nc).fill(rho * cp),
      bcs: [{ type: 'convection', select: ['bnd:rect.left'], h: c.bcs[0].h, T_ext: c.bcs[0].T_inf }, { type: 'insulation', select: ['bnd:rect.right'] }],
      transient: { t0: 0, t1: tEnd, dt, T0: c.initial.T, save: [tEnd], method: 'bdf2' } }; }, probes));
  }
  finish('HT-04', levels, targets);
}

console.log(`\nlog: ${log.path}`);
console.log(JSON.stringify(summary));
exit.set();
