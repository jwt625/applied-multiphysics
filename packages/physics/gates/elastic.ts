// SPDX-License-Identifier: GPL-3.0-or-later
// H1 gates: SM-01 Kirsch (exact-traction quarter plate: K_t, hoop stress, displacements, stress L2 error rate;
// plus K_t(W/D) under uniform remote tension converging to 3), SM-02 NAFEMS LE1 (sigma_yy at D).
// Usage: nice -n 10 node --max-old-space-size=1536 gates/elastic.ts [SM-01 SM-02]

import { buildGeometry2D } from '@amp/geom';
import { mesh2d } from '@amp/mesh';
import { sample } from '@amp/post';
import type { Mesh } from '@amp/spec/types';
import { solveElastic, stressErrorL2, type ElasticProblem } from '../src/elastic/index.ts';
import { nCells } from '../src/common/mesh.ts';
import { readCase, expectedValue, GateLog, waitForLoad, evaluate, printTable, timeToAccuracy, type Level, type Target } from './common.ts';

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

function plateMesh(L: number, a: number, f: number, hmaxFrac: number): Mesh {
  const g = buildGeometry2D({ features: [
    { id: 'q', type: 'rect', x: [0, L], y: [0, L] }, { id: 'h', type: 'circle', c: [0, 0], r: a },
    { id: 'p', type: 'difference', target: 'q', tools: ['h'] }] });
  return mesh2d(g, { hmax: L * hmaxFrac * f, grade: 0.3 * f, refine: [{ select: ['bnd:h.edge'], h: (a / 6) * f, grade: 0.3 * f }], order: 2 });
}

await waitForLoad();

if (want('SM-01')) {
  const c = readCase('a', 'SM-01');
  const L = c.geometry.spec.quarter_domain_m[0][1] as number, a = c.geometry.spec.hole_radius_m as number;
  const { E, nu } = c.materials.plate as { E: number; nu: number };
  const S = c.bcs[3].params.s_inf as number;
  const ids = ['K_t', 'syy_hole_side', 'ux_at_L_0', 'uy_at_0_L'];
  const targets: Target[] = ids.map((id, j) => ({ id, ref: expectedValue('SM-01', id).value, unit: expectedValue('SM-01', id).unit, rel: c.references[j].tolerance.rel }));
  const levels: Level[] = [];
  const l2: Array<{ h: number; err: number }> = [];
  for (const [i, f] of [1, 0.5, 0.25, 0.125].entries()) {
    const t0 = performance.now();
    const m = plateMesh(L, a, f, 0.2);
    const tm = performance.now() - t0;
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
  printTable('SM-01 (exact Kirsch traction, quarter plate L = 10 a)', levels, res, log);
  const rates = l2.slice(1).map((r, i) => Math.log(l2[i]!.err / r.err) / Math.log(l2[i]!.h / r.h));
  const fitRate = rates[rates.length - 1]!;
  const rateMin = c.references[4].tolerance.rule.min as number;
  console.log(`  stress rel L2 error: ${l2.map((r) => r.err.toExponential(3)).join(', ')}; rates ${rates.map((r) => r.toFixed(2)).join(', ')}; ${fitRate >= rateMin ? 'PASS' : 'FAIL'} rate >= ${rateMin}`);
  const tta = timeToAccuracy(levels, targets);
  console.log(`  time to accuracy: ${tta.level === null ? 'not reached' : `L${tta.level} ${tta.wall_ms!.toFixed(1)} ms`}; all levels ${levels.reduce((s, l) => s + l.wall_ms, 0).toFixed(1)} ms`);
  log.write({ kind: 'field', id: 'SM-01', l2, rates, pass: fitRate >= rateMin });
  log.write({ kind: 'speed', id: 'SM-01', tta });

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
  const targets: Target[] = [{ id: 'sigma_yy_D', ref: c.references[0].value, unit: 'Pa', rel: c.references[0].tolerance.rel }];
  const levels: Level[] = [];
  for (const [i, f] of [1, 0.5, 0.25, 0.125].entries()) {
    const t0 = performance.now();
    const g = buildGeometry2D({ features: [
      { id: 'box', type: 'rect', x: [0, go.semi_x], y: [0, go.semi_y] },
      { id: 'outer', type: 'ellipse', c: [0, 0], rx: go.semi_x, ry: go.semi_y },
      { id: 'inner', type: 'ellipse', c: [0, 0], rx: gi.semi_x, ry: gi.semi_y },
      { id: 'q', type: 'intersection', inputs: ['box', 'outer'] },
      { id: 'm', type: 'difference', target: 'q', tools: ['inner'] }] });
    const m = mesh2d(g, { hmax: 0.4 * f, grade: 0.3 * f, refine: [{ select: ['bnd:inner.edge'], h: 0.1 * f, grade: 0.3 * f }], order: 2 });
    const tm = performance.now() - t0;
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
  printTable('SM-02 NAFEMS LE1', levels, res, log);
  const tta = timeToAccuracy(levels, targets);
  console.log(`  time to accuracy: ${tta.level === null ? 'not reached' : `L${tta.level} ${tta.wall_ms!.toFixed(1)} ms`}`);
  log.write({ kind: 'speed', id: 'SM-02', tta });
}
console.log(`\nlog: ${log.path}`);
