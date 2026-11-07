// SPDX-License-Identifier: GPL-3.0-or-later
// Lane MT (DevLog-033): solid modal analysis and axisymmetric elasticity against closed forms. Coefficients are
// arbitrary test numbers, not material data (LE11 uses the NAFEMS benchmark inputs of eval case CP-02).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boxMesh, rectTriMesh, nCells, nNodes } from '../src/common/mesh.ts';
import { solveElasticModes } from '../src/elastic/modal.ts';
import { solveElasticAxisym } from '../src/elastic/axisym.ts';
import { meshCylinder } from '@amp/mesh';
import type { Mesh } from '@amp/spec/types';
import { cantileverRoot } from '../gates/mt-common.ts';

const fill = (n: number, v: number) => new Float64Array(n).fill(v);
const E = 1.0e11, nu = 0.25, rho = 5000;   // test numbers
const c0 = Math.sqrt(E / rho);

test('Euler-Bernoulli cantilever roots (1.8751, 4.6941, 7.8548 to 4 decimals)', () => {
  assert.equal(cantileverRoot(1).toFixed(4), '1.8751');
  assert.equal(cantileverRoot(2).toFixed(4), '4.6941');
  assert.equal(cantileverRoot(3).toFixed(4), '7.8548');
});

test('modal 2D plane stress: slender cantilever (L/h = 50) f1..f3 vs Euler-Bernoulli', async () => {
  const L = 1, h = 0.02;
  const m = rectTriMesh({ x: [0, L], y: [0, h], nx: 100, ny: 2, order: 2 });
  const nc = nCells(m);
  const s = await solveElasticModes({ mesh: m, model: 'plane-stress', E: fill(nc, E), nu: fill(nc, nu), rho: fill(nc, rho), bcs: [{ type: 'fixed', select: ['bnd:rect.left'] }], nModes: 3 });
  const I = h ** 3 / 12, A = h;
  for (let n = 1; n <= 3; n++) {
    const x = cantileverRoot(n), fEB = (x * x * Math.sqrt((E * I) / (rho * A * L ** 4))) / (2 * Math.PI);
    const f = s.scalars[`f_${n - 1}`]!.value, rel = (f - fEB) / fEB;
    // Timoshenko (shear + rotary inertia) lowers the continuum value by O((x h / L)^2 / 12 (1 + E / (kappa G))), < 0.5 % here
    assert.ok(rel < 0.001 && rel > -0.008, `mode ${n}: f ${f} EB ${fEB} rel ${rel}`);
  }
  assert.ok(s.detail.eigResidual.every((r) => r < 1e-6), `residuals ${Array.from(s.detail.eigResidual)}`);
  assert.equal(s.steps!.kind, 'eigen');
  assert.equal(s.fields.filter((f) => f.name === 'u').length, 3);
});

test('modal 3D tet10: cantilever bar (L/a = 20) degenerate bending pair vs Euler-Bernoulli', async () => {
  const L = 1, a = 0.05;
  const m = boxMesh({ x: [0, L], y: [0, a], z: [0, a], nx: 40, ny: 2, nz: 2, cell: 'tet10' });
  const nc = nCells(m);
  const s = await solveElasticModes({ mesh: m, model: '3d', E: fill(nc, E), nu: fill(nc, nu), rho: fill(nc, rho), bcs: [{ type: 'fixed', select: ['bnd:box.xmin'] }], nModes: 2 });
  const x = cantileverRoot(1), fEB = (x * x * Math.sqrt((E * a ** 4 / 12) / (rho * a * a * L ** 4))) / (2 * Math.PI);
  for (const k of [0, 1]) {
    const rel = (s.scalars[`f_${k}`]!.value - fEB) / fEB;
    assert.ok(Math.abs(rel) < 0.006, `mode ${k}: rel ${rel}`);
  }
});

test('modal 3D tet10: free-free bar first axial mode f = c / (2 L) (shift-invert at the expected value)', async () => {
  const L = 1, a = 0.05;
  const m = boxMesh({ x: [0, L], y: [0, a], z: [0, a], nx: 40, ny: 2, nz: 2, cell: 'tet10' });
  const nc = nCells(m), nn = nNodes(m);
  const fAx = c0 / (2 * L);
  const s = await solveElasticModes({ mesh: m, model: '3d', E: fill(nc, E), nu: fill(nc, nu), rho: fill(nc, rho), bcs: [], nModes: 4, shiftHz: fAx });
  // axial mode: largest share of u_x in the M-norm proxy sum u_x^2 / sum |u|^2
  let best = -1, share = 0;
  s.fields.forEach((f, i) => { let ax = 0, all = 0; for (let v = 0; v < nn; v++) { ax += f.data[3 * v]! ** 2; all += f.data[3 * v]! ** 2 + f.data[3 * v + 1]! ** 2 + f.data[3 * v + 2]! ** 2; } if (ax / all > share) { share = ax / all; best = i; } });
  assert.ok(share > 0.9, `axial share ${share}`);
  const rel = (s.scalars[`f_${best}`]!.value - fAx) / fAx;
  // Rayleigh-Love lateral inertia: rel -nu^2 pi^2 a^2 / (12 L^2) (square, r_p^2 = a^2 / 6), -1.29e-4 here
  assert.ok(Math.abs(rel) < 1e-3, `axial rel ${rel}`);
});

test('axisym static: Lame thick cylinder, plane strain (rollers on z faces), u_r and hoop stress at the bore', async () => {
  const a = 0.1, b = 0.2, p = 1e8;
  const m = rectTriMesh({ x: [a, b], y: [0, 0.02], nx: 24, ny: 2, order: 2, axisym: true });
  const nc = nCells(m);
  const s = await solveElasticAxisym({ mesh: m, model: 'axisym', E: fill(nc, E), nu: fill(nc, nu), bcs: [
    { type: 'roller', select: ['bnd:rect.bottom'] }, { type: 'roller', select: ['bnd:rect.top'] }, { type: 'pressure', select: ['bnd:rect.left'], p }] });
  const A = (p * a * a) / (b * b - a * a), B = (p * a * a * b * b) / (b * b - a * a);
  const ur = (r: number) => ((1 + nu) / E) * ((1 - 2 * nu) * A * r + B / r);
  let v0 = -1; for (let v = 0; v < nNodes(m); v++) if (Math.abs(m.nodes[2 * v]! - a) < 1e-12 && Math.abs(m.nodes[2 * v + 1]!) < 1e-12) v0 = v;
  const relU = (s.u[2 * v0]! - ur(a)) / ur(a);
  const sphi = s.fields.find((f) => f.name === 'sphi')!.data[v0]!, szz = s.fields.find((f) => f.name === 'szz')!.data[v0]!;
  assert.ok(Math.abs(relU) < 2e-5, `u_r rel ${relU}`);   // P2 cannot represent B / r exactly
  assert.ok(Math.abs(sphi - (A + B / (a * a))) / (A + B / (a * a)) < 2e-3, `sphi ${sphi} vs ${A + B / (a * a)}`);
  assert.ok(Math.abs(szz - 2 * nu * A) / (2 * nu * A) < 2e-2, `szz ${szz} vs ${2 * nu * A}`);
});

test('axisym static: uniform heating of a free disk with a hole gives zero stress, u_r = alpha dT r', async () => {
  const m = rectTriMesh({ x: [0.05, 0.2], y: [0, 0.05], nx: 6, ny: 2, order: 2, axisym: true });
  const nc = nCells(m), nn = nNodes(m), al = 1e-5, dT = 50;
  const s = await solveElasticAxisym({ mesh: m, model: 'axisym', E: fill(nc, E), nu: fill(nc, nu), bcs: [{ type: 'roller', select: ['bnd:rect.bottom'] }],
    thermal: { alpha: fill(nc, al), T: fill(nn, 300 + dT), Tref: 300 } });
  let e = 0; for (let v = 0; v < nn; v++) e = Math.max(e, Math.abs(s.u[2 * v]! - al * dT * m.nodes[2 * v]!));
  assert.ok(e < 1e-12, `u_r err ${e}`);
  assert.ok(s.scalars.mises_max!.value < 1e-3 * E * al * dT, `mises ${s.scalars.mises_max!.value}`);
});

/** Free-free solid cylinder: axisym n = 0 spectrum vs 3D tet10 spectrum near each axisym frequency. */
test('modal axisym vs 3D: free solid cylinder, the first non-rigid axisym frequency appears in the 3D spectrum (both modes: gates/mt-gates.ts)', async () => {
  const R = 0.1, H = 0.3;
  const ma = rectTriMesh({ x: [0, R], y: [0, H], nx: 8, ny: 24, order: 2, axisym: true });
  const nca = nCells(ma);
  const sa = await solveElasticModes({ mesh: ma, model: 'axisym', E: fill(nca, E), nu: fill(nca, nu), rho: fill(nca, rho), bcs: [], nModes: 3 });
  // axisym n = 0 has one rigid mode (axial translation)
  assert.equal(sa.scalars.f_0!.value, 0);
  const m3 = meshCylinder({ id: 'cyl', radius: R, height: H, base: [0, 0, 0], axis: 'z' }, { mesh2d: { hmax: 0.035 }, dz: 0.035, cell: 'tet4', order: 2 } as Parameters<typeof meshCylinder>[1]) as Mesh;
  const nc3 = nCells(m3);
  for (const k of [1]) {
    const fa = sa.scalars[`f_${k}`]!.value;
    const s3 = await solveElasticModes({ mesh: m3, model: '3d', E: fill(nc3, E), nu: fill(nc3, nu), rho: fill(nc3, rho), bcs: [], nModes: 4, shiftHz: fa });
    const near = Math.min(...Object.values(s3.scalars).map((x) => Math.abs(x.value - fa) / fa));
    assert.ok(near < 5e-3, `axisym f_${k} = ${fa}: nearest 3D rel ${near} (${Object.values(s3.scalars).map((x) => x.value.toFixed(1)).join(', ')})`);
  }
});
