// SPDX-License-Identifier: GPL-3.0-or-later
// H1 gates: SM-01 Kirsch (exact-traction quarter plate: K_t, hoop stress, displacements, stress L2 error rate;
// plus K_t(W/D) under uniform remote tension converging to 3), SM-02 NAFEMS LE1 (sigma_yy at D).
// Usage: nice -n 10 node --max-old-space-size=1536 gates/elastic.ts [SM-01 SM-02]

import { buildGeometry2D } from '@amp/geom';
import { mesh2d, refineUniform } from '@amp/mesh';
import { sample } from '../../post/src/index.ts';
import type { Mesh } from '@amp/spec/types';
import { solveElastic, stressErrorL2, type ElasticProblem } from '../src/elastic/index.ts';
import { nCells } from '../src/common/mesh.ts';
import { readCase, caseTarget, GateLog, waitForLoad, evaluate, printTable, speedLine, ExitCode, type Level, type Target } from './common.ts';
const exit = new ExitCode();

const only = process.argv.slice(2);
const want = (id: string) => !only.length || only.includes(id);
const log = new GateLog('elastic');

/** Kirsch (1898) plane stress field for remote tension S along x around a hole of radius a: [sxx, syy, sxy]. */
export function kirsch(S: number, a: number, x: number, y: number): number[] {
  const r2 = x * x + y * y, th = Math.atan2(y, x), c2 = Math.cos(2 * th), s2 = Math.sin(2 * th);
  const q = (a * a) / r2, q2 = q * q;
  const srr = (S / 2) * (1 - q) + (S / 2) * (1 - 4 * q + 3 * q2) * c2;
  const stt = (S / 2) * (1 + q) - (S / 2) * (1 + 3 * q2) * c2;
  const srt = -(S / 2) * (1 + 2 * q - 3 * q2) * s2;
  const c = Math.cos(th), s = Math.sin(th);
  return [srr * c * c + stt * s * s - 2 * srt * s * c, srr * s * s + stt * c * c + 2 * srt * s * c, (srr - stt) * s * c + srt * (c * c - s * s)];
}

/** Nested level sequence: the base CDT mesh and k uniform refinements (new boundary nodes on the exact curves). */
function nested(g: ReturnType<typeof buildGeometry2D>, base: Mesh, nLevels: number): Array<{ m: Mesh; ms: number }> {
  const out = [{ m: base, ms: 0 }];
  for (let k = 1; k < nLevels; k++) { const t0 = performance.now(); out.push({ m: refineUniform(out[k - 1]!.m, { geometry: g }), ms: performance.now() - t0 }); }
  return out;
}

await waitForLoad();

if (want('SM-01')) {
  const c = readCase('a', 'SM-01');
  const L = c.geometry.spec.quarter_domain_m[0][1] as number, a = c.geometry.spec.hole_radius_m as number;
  const { E, nu } = c.materials.plate as { E: number; nu: number };
  const S = c.bcs[3].params.s_inf as number;
  // theoretical orders (P2): point displacements 3; nodal-averaged stresses 2
  const targets: Target[] = [caseTarget('a', 'SM-01', 'K_t', { order: 2 }), caseTarget('a', 'SM-01', 'syy_hole_side', { order: 2 }),
    caseTarget('a', 'SM-01', 'ux_at_L_0', { order: 3 }), caseTarget('a', 'SM-01', 'uy_at_0_L', { order: 3 })];
  const levels: Level[] = [];
  const l2: Array<{ h: number; err: number }> = [];
  const tg0 = performance.now();
  const g1 = buildGeometry2D({ features: [
    { id: 'q', type: 'rect', x: [0, L], y: [0, L] }, { id: 'h', type: 'circle', c: [0, 0], r: a },
    { id: 'p', type: 'difference', target: 'q', tools: ['h'] }] });
  const seq = nested(g1, mesh2d(g1, { hmax: L * 0.2, refine: [{ select: ['bnd:h.edge'], h: a / 6 }], order: 2 }), 4);
  seq[0]!.ms = performance.now() - tg0;
  for (const [i, f] of [1, 0.5, 0.25, 0.125].entries()) {
    const m = seq[i]!.m, tm = seq[i]!.ms;
    const nc = nCells(m);
    const p: ElasticProblem = {
      mesh: m, model: 'plane-stress', E: new Float64Array(nc).fill(E), nu: new Float64Array(nc).fill(nu),
      bcs: [
        { type: 'roller', select: ['bnd:q.left'] }, { type: 'roller', select: ['bnd:q.bottom'] },
        { type: 'traction', select: ['bnd:q.right', 'bnd:q.top'], t: (x, n) => { const s = kirsch(S, a, x[0]!, x[1]!); return [s[0]! * n[0]! + s[2]! * n[1]!, s[2]! * n[0]! + s[1]! * n[1]!]; } },
      ],
    };
    const t1 = performance.now();
    const s = await solveElastic(p);
    const wall = performance.now() - t1 + tm;
    const values = {
      K_t: sample(s, 'sxx', [0, a])[0]! / S,
      syy_hole_side: sample(s, 'syy', [a, 0])[0]!,
      ux_at_L_0: sample(s, 'u', [L, 0], { component: 0 })[0]!,
      uy_at_0_L: sample(s, 'u', [0, L], { component: 1 })[0]!,
    };
    const err = stressErrorL2(p, s.u, (x) => kirsch(S, a, x[0]!, x[1]!));
    l2.push({ h: (a / 6) * f, err });
    levels.push({ level: i, h: f, dof: s.stats.dof, wall_ms: wall, stages: { mesh: +tm.toFixed(1), ...Object.fromEntries(Object.entries(s.timing).map(([k, v]) => [k, +v.toFixed(1)])) }, values });
  }
  const res = evaluate(levels, targets);
  printTable('SM-01 (exact Kirsch traction, quarter plate L = 10 a; nested levels)', levels, res, log);
  exit.add(res);
  const rates = l2.slice(1).map((r, i) => Math.log(l2[i]!.err / r.err) / Math.log(l2[i]!.h / r.h));
  const fitRate = rates[rates.length - 1]!;
  const rateMin = c.references[4].tolerance.rule.min as number;
  console.log(`  stress rel L2 error: ${l2.map((r) => r.err.toExponential(3)).join(', ')}; rates ${rates.map((r) => r.toFixed(2)).join(', ')}; ${fitRate >= rateMin ? 'PASS' : 'FAIL'} rate >= ${rateMin}`);
  speedLine('SM-01', levels, targets, res, log);
  log.write({ kind: 'field', id: 'SM-01', l2, rates, pass: fitRate >= rateMin });
  if (!(fitRate >= rateMin) && exit.code === 0) exit.code = 2;

  // K_t(W/D) under uniform remote tension (finite plate, R3 SM-01 condition W/D >= 20): converges to 3
  console.log('  K_t(W/D), uniform traction on x = W/2, top free:');
  const kt: Array<{ WD: number; Kt: number; dof: number; ms: number }> = [];
  for (const WD of [2.5, 5, 10, 20, 40, 80]) {
    const Lw = (WD * 2 * a) / 2;
    const t0 = performance.now();
    const g = buildGeometry2D({ features: [
      { id: 'q', type: 'rect', x: [0, Lw], y: [0, Lw] }, { id: 'h', type: 'circle', c: [0, 0], r: a },
      { id: 'p', type: 'difference', target: 'q', tools: ['h'] }] });
    const m = mesh2d(g, { hmax: Lw / 8, refine: [{ select: ['bnd:h.edge'], h: a / 48 }], order: 2 });
    const nc = nCells(m);
    const s = await solveElastic({ mesh: m, model: 'plane-stress', E: new Float64Array(nc).fill(E), nu: new Float64Array(nc).fill(nu),
      bcs: [{ type: 'roller', select: ['bnd:q.left'] }, { type: 'roller', select: ['bnd:q.bottom'] }, { type: 'traction', select: ['bnd:q.right'], t: [S, 0] }] });
    const Kt = sample(s, 'sxx', [0, a])[0]! / S;
    kt.push({ WD, Kt, dof: s.stats.dof, ms: performance.now() - t0 });
    console.log(`    W/D ${WD}: K_t ${Kt.toFixed(5)} (K_t - 3 = ${(Kt - 3).toExponential(3)}), dof ${s.stats.dof}, ${(performance.now() - t0).toFixed(0)} ms`);
  }
  log.write({ kind: 'kt-vs-width', id: 'SM-01', kt });
}

if (want('SM-02')) {
  const c = readCase('a', 'SM-02');
  const gi = c.geometry.spec.inner_ellipse_m, go = c.geometry.spec.outer_ellipse_m;
  const { E, nu } = c.materials.steel as { E: number; nu: number };
  const P = c.bcs[2].value as number;
  const D = c.geometry.spec.points_m.D as [number, number];
  const targets: Target[] = [caseTarget('a', 'SM-02', 'sigma_yy_D', { order: 2 })];
  const levels: Level[] = [];
  const tg0 = performance.now();
  const g = buildGeometry2D({ features: [
      { id: 'box', type: 'rect', x: [0, go.semi_x], y: [0, go.semi_y] },
      { id: 'outer', type: 'ellipse', c: [0, 0], rx: go.semi_x, ry: go.semi_y },
      { id: 'inner', type: 'ellipse', c: [0, 0], rx: gi.semi_x, ry: gi.semi_y },
      { id: 'q', type: 'intersection', inputs: ['box', 'outer'] },
      { id: 'm', type: 'difference', target: 'q', tools: ['inner'] }] });
  const seq = nested(g, mesh2d(g, { hmax: 0.4, refine: [{ select: ['bnd:inner.edge'], h: 0.1 }], order: 2 }), 4);
  seq[0]!.ms = performance.now() - tg0;
  for (const [i, f] of [1, 0.5, 0.25, 0.125].entries()) {
    const m = seq[i]!.m, tm = seq[i]!.ms;
    const ents = m.entities.boundaries.map((b) => b.id);
    const pick = (pre: string) => ents.filter((x) => x.startsWith(pre));
    const nc = nCells(m);
    const t1 = performance.now();
    const s = await solveElastic({ mesh: m, model: 'plane-stress', E: new Float64Array(nc).fill(E), nu: new Float64Array(nc).fill(nu),
      bcs: [{ type: 'roller', select: pick('bnd:box.left') }, { type: 'roller', select: pick('bnd:box.bottom') }, { type: 'pressure', select: pick('bnd:outer.'), p: -P }] });
    const wall = performance.now() - t1 + tm;
    if (i === 0) console.log(`  LE1 boundaries: ${ents.join(', ')}`);
    levels.push({ level: i, h: f, dof: s.stats.dof, wall_ms: wall, stages: { mesh: +tm.toFixed(1), ...Object.fromEntries(Object.entries(s.timing).map(([k, v]) => [k, +v.toFixed(1)])) }, values: { sigma_yy_D: sample(s, 'syy', D)[0]! } });
  }
  const res = evaluate(levels, targets);
  printTable('SM-02 NAFEMS LE1 (nested levels)', levels, res, log);
  speedLine('SM-02', levels, targets, res, log);
  exit.add(res);
}
console.log(`\nlog: ${log.path}`);
exit.set();
