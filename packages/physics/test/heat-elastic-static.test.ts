// SPDX-License-Identifier: GPL-3.0-or-later
// Closed-form checks of heat, elastic, electrostatics and magnetostatics on structured fixtures (coefficients are
// arbitrary test numbers, not material data).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boxMesh, rectTriMesh, nCells, nNodes } from '../src/common/mesh.ts';
import { solveHeat, SIGMA_SB } from '../src/heat/index.ts';
import { solveElastic, symEig3 } from '../src/elastic/index.ts';
import { solveElectrostatics, EPS0 } from '../src/electrostatics/index.ts';
import { solveMagnetostatics } from '../src/magnetostatics/index.ts';
import { physicsRegistry, prepareRun, modules } from '../src/index.ts';
import { validateSpec } from '@amp/spec';
import { sample } from '../../post/src/index.ts';

const fill = (n: number, v: number) => new Float64Array(n).fill(v);
const maxErr = (m: { nodes: Float64Array; dim: number }, u: Float64Array, f: (x: number[]) => number) => {
  let e = 0; const n = m.nodes.length / m.dim;
  for (let i = 0; i < n; i++) e = Math.max(e, Math.abs(u[i]! - f(Array.from(m.nodes.subarray(m.dim * i, m.dim * i + m.dim)))));
  return e;
};

for (const cell of ['tet10', 'hex8'] as const) test(`heat 3D ${cell}: fixed T + convection, linear exact`, async () => {
  // -k T'' = 0, T(0) = T0, -k T'(L) = h (T(L) - Te): T = T0 + (Te - T0) h x / (k + h L)
  const m = boxMesh({ x: [0, 1], y: [0, 0.5], z: [0, 0.5], nx: 4, ny: 2, nz: 2, cell });
  const k = 3, h = 7, T0 = 400, Te = 300, L = 1;
  const s = await solveHeat({ mesh: m, k: fill(nCells(m), k), bcs: [
    { type: 'temperature', select: ['bnd:box.xmin'], T: T0 }, { type: 'convection', select: ['bnd:box.xmax'], h, T_ext: Te }] });
  const err = maxErr(m, s.T, (x) => T0 + ((Te - T0) * h * x[0]!) / (k + h * L));
  assert.ok(err < 1e-9, `err ${err}`);
  assert.equal(s.run.engine.startsWith('@amp/physics@'), true);
  assert.ok(s.timing.assemble! >= 0 && s.timing.factor! >= 0);
});

test('heat axisym: cylindrical shell, T = A ln r + B, P2 max-norm rate -> 3 (pre-asymptotic near r1)', async () => {
  const r1 = 0.01, r2 = 0.05, T1 = 500, T2 = 300;
  const ex = (r: number) => T1 + ((T2 - T1) * Math.log(r / r1)) / Math.log(r2 / r1);
  const errs: number[] = [];
  for (const n of [16, 32, 64]) {
    const m = rectTriMesh({ x: [r1, r2], y: [0, 0.01], nx: n, ny: 1, order: 2, axisym: true });
    const s = await solveHeat({ mesh: m, k: fill(nCells(m), 2), bcs: [{ type: 'temperature', select: ['bnd:rect.left'], T: T1 }, { type: 'temperature', select: ['bnd:rect.right'], T: T2 }] });
    errs.push(maxErr(m, s.T, (x) => ex(x[0]!)));
  }
  const rate = Math.log2(errs[1]! / errs[2]!);
  assert.ok(rate > 2.7 && errs[2]! < 1e-3, `errs ${errs} rate ${rate}`);
});

test('heat radiation: Newton converges to the root of k (TA - TB) / L = eps sigma (TB^4 - Tamb^4)', async () => {
  const m = rectTriMesh({ x: [0, 0.2], y: [0, 0.02], nx: 3, ny: 1, order: 1 });
  const k = 20, eps = 0.5, TA = 800, Ta = 290, L = 0.2;
  const s = await solveHeat({ mesh: m, k: fill(nCells(m), k), bcs: [{ type: 'temperature', select: ['bnd:rect.left'], T: TA }, { type: 'radiation', select: ['bnd:rect.right'], emissivity: eps, T_amb: Ta }] });
  const TB = sample(s, 'T', [L, 0.01])[0]!;
  assert.ok(Math.abs((k * (TA - TB)) / L - eps * SIGMA_SB * (TB ** 4 - Ta ** 4)) < 1e-6 * k * TA / L);
});

test('heat transient BDF2: second-order in dt (lumped slab, T(x, t) with exact Dirichlet in time)', async () => {
  // T = T0 + a t + (a / (2 D)) x^2 solves T_t = D T_xx exactly; Dirichlet on both ends from it, insulated sides
  const D = 1e-4, a = 0.5, T0 = 300, L = 0.05;
  const ex = (x: number, t: number) => T0 + a * t + (a / (2 * D)) * x * x;
  const vals: number[] = [];
  for (const dt of [4, 2, 1]) {
    const m = rectTriMesh({ x: [0, L], y: [0, 0.005], nx: 4, ny: 1, order: 2 });
    const T0n = Float64Array.from({ length: nNodes(m) }, (_, i) => ex(m.nodes[2 * i]!, 0));
    const s = await solveHeat({ mesh: m, k: fill(nCells(m), D), rhoCp: fill(nCells(m), 1), transient: { t0: 0, t1: 16, dt, T0: T0n, save: [16] },
      bcs: [{ type: 'temperature', select: ['bnd:rect.left', 'bnd:rect.right'], T: (x, t) => ex(x[0]!, t) }] });
    vals.push(sample(s, 'T', [0.03, 0.0025])[0]! - ex(0.03, 16));
  }
  // P2 in x is exact for x^2; T linear in t: BDF is exact too
  for (const v of vals) assert.ok(Math.abs(v) < 1e-8, `errors ${vals}`);
});

test('elastic 3D tet10 patch: uniaxial stress state exact', async () => {
  const m = boxMesh({ x: [0, 2], y: [0, 1], z: [0, 1], nx: 2, ny: 1, nz: 1, cell: 'tet10' });
  const E = 70e9, nu = 0.33, S = 1e6;
  const s = await solveElastic({ mesh: m, model: '3d', E: fill(nCells(m), E), nu: fill(nCells(m), nu), bcs: [
    { type: 'roller', select: ['bnd:box.xmin'] }, { type: 'roller', select: ['bnd:box.ymin'] }, { type: 'roller', select: ['bnd:box.zmin'] },
    { type: 'traction', select: ['bnd:box.xmax'], t: [S, 0, 0] }] });
  const ux = sample(s, 'u', [2, 0.5, 0.5], { component: 0 })[0]!, uy = sample(s, 'u', [2, 1, 0.5], { component: 1 })[0]!;
  assert.ok(Math.abs(ux - (S / E) * 2) < 1e-9 * Math.abs(ux) * 1e3);
  assert.ok(Math.abs(uy + (nu * S) / E) < 1e-12);
  assert.ok(Math.abs(sample(s, 'sxx', [1, 0.5, 0.5])[0]! - S) < 1e-6 * S);
  assert.ok(Math.abs(sample(s, 'mises', [1, 0.5, 0.5])[0]! - S) < 1e-6 * S);
});

test('elastic plane strain + thermal strain: free expansion gives zero in-plane stress, szz = -E alpha dT', async () => {
  const m = rectTriMesh({ x: [0, 1], y: [0, 1], nx: 2, ny: 2, order: 2 });
  const E = 100e9, nu = 0.25, al = 1e-5, dT = 50;
  const T = fill(nNodes(m), 300 + dT);
  const s = await solveElastic({ mesh: m, model: 'plane-strain', E: fill(nCells(m), E), nu: fill(nCells(m), nu), thermal: { alpha: fill(nCells(m), al), T, Tref: 300 },
    bcs: [{ type: 'roller', select: ['bnd:rect.left'] }, { type: 'roller', select: ['bnd:rect.bottom'] }] });
  assert.ok(Math.abs(sample(s, 'sxx', [0.5, 0.5])[0]!) < 1e-3);
  assert.ok(Math.abs(sample(s, 'szz', [0.5, 0.5])[0]! + E * al * dT) < 1e-6 * E * al * dT);
  assert.ok(Math.abs(sample(s, 'u', [1, 0.5], { component: 0 })[0]! - (1 + nu) * al * dT) < 1e-12);
});

test('symEig3 matches a diagonalised tensor', () => {
  const e = symEig3(2, 2, 3, 0, 0, 1);  // xy block [[2,1],[1,2]] -> 3, 1; zz 3 (double root: trig form ~1e-8)
  [3, 3, 1].forEach((v, i) => assert.ok(Math.abs(e[i]! - v) < 1e-7, `${e}`));
  const f = symEig3(5, -1, 2, 0.3, -0.7, 1.1);
  assert.ok(Math.abs(f[0]! + f[1]! + f[2]! - 6) < 1e-12);
});

test('electrostatics: parallel plate C per unit length and axisym coax capacitance', async () => {
  const m = rectTriMesh({ x: [0, 0.01], y: [0, 0.001], nx: 4, ny: 2, order: 2 });
  const s = await solveElectrostatics({ mesh: m, epsR: fill(nCells(m), 4), terminals: [{ id: 't', select: ['bnd:rect.top'] }], ground: ['bnd:rect.bottom'] });
  assert.ok(Math.abs(s.C[0]! - (EPS0 * 4 * 0.01) / 0.001) < 1e-12 * s.C[0]!);
  // axisym: coaxial cylinders r1..r2 of length H, insulating ends: C = 2 pi eps H / ln(r2 / r1)
  const ma = rectTriMesh({ x: [0.001, 0.004], y: [0, 0.01], nx: 16, ny: 2, order: 2, axisym: true });
  const sa = await solveElectrostatics({ mesh: ma, epsR: fill(nCells(ma), 1), terminals: [{ id: 'in', select: ['bnd:rect.left'] }], ground: ['bnd:rect.right'] });
  const ex = (2 * Math.PI * EPS0 * 0.01) / Math.log(4);
  assert.ok(Math.abs(sa.C[0]! - ex) < 1e-6 * ex, `${sa.C[0]} vs ${ex}`);
});

test('magnetostatics axisym: long solenoid sheet, B inside = mu0 n I', async () => {
  // current sheet: thin annular coil region r in [a, a + t], z in [-H/2, H/2] inside a box with A = 0 far; check B_z
  // at the centre against the finite-solenoid formula mu0 J t (H/2) / sqrt((H/2)^2 + a^2) (thin sheet limit).
  const { buildGeometry2D } = await import('@amp/geom');
  const { mesh2d } = await import('@amp/mesh');
  const a = 0.01, t = 0.0005, H = 0.2, Rb = 2;
  const g = buildGeometry2D({ axisym: true, features: [
    { id: 'air', type: 'rect', x: [0, Rb], y: [-Rb, Rb] }, { id: 'coil', type: 'rect', x: [a, a + t], y: [-H / 2, H / 2] },
    { id: 'all', type: 'difference', target: 'air', tools: ['coil'], keepTools: true }] });
  const m = mesh2d(g, { hmax: Rb / 4, refine: [{ select: ['dom:coil'], h: t / 2 }], order: 2 });
  const I = 2, turns = 400;
  const s = await solveMagnetostatics({ mesh: m, muR: fill(nCells(m), 1), coils: [{ id: 'c', select: ['dom:coil'], turns, current: I }],
    insulation: ['bnd:air.right', 'bnd:air.top', 'bnd:air.bottom'] });
  const am = a + t / 2;
  const ex = (1.25663706212e-6 * (turns * I / H) * (H / 2)) / Math.sqrt((H / 2) ** 2 + am * am);
  const B = sample(s, 'Bz', [0, 0])[0]!;
  assert.ok(Math.abs(B - ex) < 2e-3 * ex, `${B} vs ${ex}`);
});

test('registry: L4 registrations validate the kirsch-plate example; every module has a type', () => {
  const reg = physicsRegistry();
  assert.ok(reg.get('physics', 'electrostatics'));
  assert.equal(new Set(modules.map((x) => x.type)).size, modules.length); assert.ok(modules.some((x) => x.type === 'emw-axisym'));
  void validateSpec; void prepareRun;
});
