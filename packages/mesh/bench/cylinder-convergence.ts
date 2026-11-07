// SPDX-License-Identifier: GPL-3.0-or-later
// L4 follow-up: volume and surface-area convergence of cylinder meshes (RF-01 / RF-21 cavity, a = 2.74 cm, d = 2a)
// against pi a^2 d and 2 pi a (a + d): fresh meshes at h = a/2, a/4, a/8 (tet4 straight, tet10 curved), and nested
// sequences by refineUniform from h = a/2 with the side projector. JSONL to logs/l3-cyl-convergence-<stamp>.jsonl.
// Run: nice -n 10 node --max-old-space-size=1536 packages/mesh/bench/cylinder-convergence.ts

import { mkdirSync, appendFileSync } from 'node:fs';
import type { Mesh } from '@amp/geom';
import { meshCylinder, cylinderSideProjector, refineUniform, curvedQuality, boundaryMeasure } from '../src/index.ts';

const a = 0.0274, d = 2 * a;
const spec = { id: 'cav', radius: a, height: d, base: [0, 0, 0] as [number, number, number], axis: 'z' as const };
const V = Math.PI * a * a * d, S = 2 * Math.PI * a * (a + d);
const root = new URL('../../../', import.meta.url);
mkdirSync(new URL('logs/', root), { recursive: true });
const log = new URL(`logs/l3-cyl-convergence-${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}.jsonl`, root);
const all = (m: Mesh) => m.entities.boundaries.map((_, i) => i);
const rec = (series: string, level: number, h: number, m: Mesh) => {
  const q = curvedQuality(m);
  const vol = q.volume!, area = boundaryMeasure(m, all(m));
  const r = { series, level, h, cellType: m.cells.type, cells: m.cells.domain.length, nodes: m.nodes.length / 3, volume: vol, volRelErr: (vol - V) / V, area, areaRelErr: (area - S) / S, minJacobianRatioP2: q.minJacobianRatioP2 ?? null, nInverted: q.nInverted ?? null, hash: m.hash };
  appendFileSync(log, JSON.stringify(r) + '\n');
  return r;
};
const rows: Array<ReturnType<typeof rec>> = [];
for (const order of [1, 2] as const)
  for (const k of [2, 4, 8]) {
    const h = a / k;
    rows.push(rec(`fresh tet${order === 1 ? 4 : 10}`, k, h, meshCylinder(spec, { mesh2d: { hmax: h }, dz: h, order })));
  }
for (const order of [1, 2] as const) {
  let m = meshCylinder(spec, { mesh2d: { hmax: a / 2 }, dz: a / 2, order });
  const proj = cylinderSideProjector(m, spec);
  for (let l = 0; l < 3; l++) {
    rows.push(rec(`nested tet${order === 1 ? 4 : 10}`, l, a / 2 / 2 ** l, m));
    if (l < 2) m = refineUniform(m, { project: proj });
  }
}
let prev: (typeof rows)[number] | null = null;
for (const r of rows) {
  const same = prev && prev.series === r.series;
  const pv = same ? Math.log(Math.abs(prev!.volRelErr / r.volRelErr)) / Math.log(prev!.h / r.h) : NaN;
  const pa = same ? Math.log(Math.abs(prev!.areaRelErr / r.areaRelErr)) / Math.log(prev!.h / r.h) : NaN;
  console.log(`| ${r.series} | ${(r.h * 1e3).toFixed(2)} | ${r.cells} | ${r.volRelErr.toExponential(2)} | ${Number.isNaN(pv) ? '-' : pv.toFixed(2)} | ${r.areaRelErr.toExponential(2)} | ${Number.isNaN(pa) ? '-' : pa.toFixed(2)} | ${r.minJacobianRatioP2 === null ? `inverted ${r.nInverted}` : r.minJacobianRatioP2.toFixed(3)} |`);
  prev = r;
}
console.log(`log: ${log.pathname.split('/').slice(-2).join('/')}`);
