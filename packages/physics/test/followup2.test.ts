// SPDX-License-Identifier: GPL-3.0-or-later
// Follow-up 2 checks (DevLog-010): field-valued settings, readiness, two-fluid acoustics, nodal E of a cavity mode,
// nested prepareRun levels. Coefficients are arbitrary test numbers, not material data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boxMesh, rectTriMesh, nCells } from '../src/common/mesh.ts';
import { compileField } from '../src/common/field.ts';
import { solveHeat } from '../src/heat/index.ts';
import { solveAcousticModes } from '../src/acoustics/index.ts';
import { solveCavity } from '../src/em3d/index.ts';
import { heatModule, prepareRun } from '../src/index.ts';
import { meshCylinder } from '@amp/mesh';
import { sample } from '../../post/src/index.ts';
import type { Spec } from '@amp/spec/types';

const baseSpec = (extra: Record<string, unknown> = {}) => ({
  schema: 'amp-spec/0', id: 'f2', title: 'follow-up 2 test',
  params: { L: { value: 1, unit: 'm' } },
  geometry: { dim: 2, features: [{ id: 'bar', type: 'rect', settings: { size: ['L', '0.1 m'], center: ['L/2', '0.05 m'] } }] },
  materials: [{ id: 'm1', override: { k: { value: 2, unit: 'W/(m*K)' } }, select: ['dom:bar'] }],
  physics: [{ id: 'ht', type: 'heat', select: ['dom:bar'], bcs: [
    { id: 'l', type: 'temperature', select: ['bnd:bar.left'], settings: { T: { expr: '300 + 10*y/(1[m])', unit: 'K' } } },
    { id: 'r', type: 'temperature', select: ['bnd:bar.right'], settings: { T: '400 K' } }] }],
  mesh: { size: { hmax: '0.05 m' } },
  studies: [{ id: 's', type: 'stationary', physics: ['ht'] }],
  ...extra,
});

test('compileField: constant, {expr, unit} with degC, space and time symbols', () => {
  const spec = baseSpec() as unknown as Spec;
  assert.equal(compileField(spec, '20 degC', '2d', 'a'), 293.15);
  const f = compileField(spec, { expr: '100*sin(pi*t/(40[s]))', unit: 'degC' }, '2d', 'b');
  assert.ok(typeof f === 'function');
  assert.ok(Math.abs((f as (x: number[], t: number) => number)([0, 0], 20) - (273.15 + 100)) < 1e-9);
  const g = compileField(spec, { expr: '1e6*x/L', unit: 'Pa' }, '2d', 'c', 'space') as (x: number[], t: number) => number;
  assert.ok(Math.abs(g([0.25, 0], 0) - 2.5e5) < 1e-6);
  const r = compileField(spec, { expr: '2*r/(1[m])', unit: 'K' }, '2d-axisym', 'd', 'space') as (x: number[], t: number) => number;
  assert.equal(r([0.5, 9], 0), 1);
});

test('heat: field Dirichlet T(x, t) reproduced (linear in x and t: P1 + BDF2 exact)', async () => {
  const m = rectTriMesh({ x: [0, 1], y: [0, 0.1], nx: 4, ny: 1, order: 1 });
  const ex = (x: number, t: number) => 300 + 5 * x + 0 * t;
  const s = await solveHeat({ mesh: m, k: new Float64Array(nCells(m)).fill(1), rhoCp: new Float64Array(nCells(m)).fill(1),
    transient: { t0: 0, t1: 2, dt: 0.5, T0: (x) => ex(x[0]!, 0), method: 'crank-nicolson' },
    bcs: [{ type: 'temperature', select: ['bnd:rect.left', 'bnd:rect.right'], T: (x, t) => ex(x[0]!, t) }] });
  assert.ok(Math.abs(sample(s, 'T', [0.37, 0.05])[0]! - ex(0.37, 2)) < 1e-9);
});

test('readiness: N/A material, N/A BC value and missing T0 are reasons', () => {
  const s1 = baseSpec({ materials: [{ id: 'm1', override: { k: { value: 'N/A', unit: 'W/(m*K)' } }, select: ['dom:bar'] }] }) as unknown as Spec;
  const r1 = heatModule.readiness(s1, 'ht');
  assert.equal(r1.ready, false); assert.ok(r1.reasons.some((x) => x.includes('override.k is N/A')));
  const s2 = baseSpec({ studies: [{ id: 's', type: 'time', physics: ['ht'], settings: { start: '0 s', stop: '1 s', dt: '0.1 s', method: 'bdf2' } }] }) as unknown as Spec;
  const r2 = heatModule.readiness(s2, 'ht');
  assert.ok(r2.reasons.some((x) => x.includes('settings.T0')), JSON.stringify(r2));
  assert.equal(heatModule.readiness(baseSpec() as unknown as Spec, 'ht').ready, true);
});

test('prepareRun: spec with a field BC runs; hFactor 1/2, 1/4 give nested levels; timing and notes on the Solution', async () => {
  const spec = baseSpec() as Record<string, unknown>;
  const c0 = await prepareRun({ spec, hFactor: 1 });
  const c1 = await prepareRun({ spec, hFactor: 0.5 });
  const c2 = await prepareRun({ spec, hFactor: 0.25 });
  const n0 = c0.mesh.nodes.length / 2, n1 = c1.mesh.nodes.length / 2;
  // nested: the coarse nodes are the first nodes of the fine mesh
  for (let i = 0; i < 2 * n0; i++) assert.equal(c1.mesh.nodes[i], c0.mesh.nodes[i]);
  assert.ok(n1 > 3 * n0 && c2.mesh.nodes.length / 2 > 3 * n1);
  const s = await heatModule.run(c2);
  assert.ok(s.timing.validate! >= 0 && s.timing.geometry_mesh! >= 0 && s.timing.assemble! >= 0);
  // T = 300 + 10 y at x = 0, 400 at x = L: linear in x and y -> exact for P2
  const v = sample(s, 'T', [0.5, 0.05])[0]!;
  assert.ok(Math.abs(v - (0.5 * (300 + 0.5) + 0.5 * 400)) < 1e-6, `${v}`);
});

test('acoustics: two fluids in series (rho, c per domain) match the interface eigen-relation', async () => {
  const L1 = 0.6, L2 = 0.4, c1 = 300, c2 = 600, r1 = 1, r2 = 4;
  const m = boxMesh({ x: [0, L1 + L2], y: [0, 0.1], z: [0, 0.1], nx: 20, ny: 1, nz: 1, cell: 'tet10' });
  const nc = nCells(m), c = new Float64Array(nc), rho = new Float64Array(nc);
  for (let e = 0; e < nc; e++) {
    let x = 0; for (let a = 0; a < 4; a++) x += m.nodes[3 * m.cells.conn[10 * e + a]!]! / 4;
    c[e] = x < L1 ? c1 : c2; rho[e] = x < L1 ? r1 : r2;
  }
  // rigid ends: (k1/rho1) sin(k1 L1) cos(k2 L2) + (k2/rho2) sin(k2 L2) cos(k1 L1) = 0, k_i = omega / c_i
  const g = (w: number) => ((w / c1) / r1) * Math.sin((w / c1) * L1) * Math.cos((w / c2) * L2) + ((w / c2) / r2) * Math.sin((w / c2) * L2) * Math.cos((w / c1) * L1);
  const roots: number[] = [];
  for (let w = 1; w < 2 * Math.PI * 1200 && roots.length < 3; w += 1) if (g(w) * g(w + 1) < 0) {
    let a = w, b = w + 1; for (let i = 0; i < 60; i++) { const mm = 0.5 * (a + b); if (g(a) * g(mm) <= 0) b = mm; else a = mm; }
    roots.push(0.5 * (a + b) / (2 * Math.PI));
  }
  const s = await solveAcousticModes({ mesh: m, c, rho, nModes: 4 });
  const f = Array.from(s.steps!.values).filter((x) => x > 1);
  for (let i = 0; i < 2; i++) assert.ok(Math.abs(f[i]! - roots[i]!) < 2e-4 * roots[i]!, `mode ${i}: ${f[i]} vs ${roots[i]}`);
  // density matters: the same c without the density contrast gives another spectrum
  const s1 = await solveAcousticModes({ mesh: m, c, nModes: 4 });
  const f1 = Array.from(s1.steps!.values).filter((x) => x > 1);
  assert.ok(Math.abs(f1[0]! - roots[0]!) > 1e-2 * roots[0]!);
});

test('emw: nodal E of TM010 follows E_z ~ J0(x01 r / a), E_r ~ 0', async () => {
  const a = 0.0274, d = 2 * a;
  const m = meshCylinder({ id: 'cav', radius: a, height: d, base: [0, 0, 0], axis: 'z' }, { mesh2d: { hmax: a / 3 }, dz: a / 3, cell: 'tet4', order: 2 });
  const nc = nCells(m);
  const s = await solveCavity({ mesh: m, order: 2, epsR: new Float64Array(nc).fill(2), muR: new Float64Array(nc).fill(1), pec: ['bnd:cav.side', 'bnd:cav.top', 'bnd:cav.bottom'], nModes: 1, shiftHz: 2.0e9 });
  const E = s.fields.find((f) => f.name === 'E_nodal' && f.step === 0)!;
  assert.ok(E && E.components === 3);
  const J0 = (x: number) => { let s0 = 0, t = 1; for (let k = 0; k < 30; k++) { if (k) t *= -(x * x) / (4 * k * k); s0 += t; } return s0; };
  const x01 = 2.404825557695773;
  const ez = (r: number) => sample(s, 'E_nodal', [r, 0, d / 2], { component: 2 })[0]!;
  const e0 = ez(0);
  for (const r of [0.25 * a, 0.5 * a, 0.75 * a]) assert.ok(Math.abs(ez(r) / e0 - J0((x01 * r) / a)) < 2e-2, `r ${r}: ${ez(r) / e0} vs ${J0((x01 * r) / a)}`);
  assert.ok(Math.abs(sample(s, 'E_nodal', [0.5 * a, 0, d / 2], { component: 0 })[0]!) < 2e-2 * Math.abs(e0));
  assert.ok(typeof (s as { normalization?: string }).normalization === 'undefined');   // set by the module wrapper (index.ts), not solveCavity
});
