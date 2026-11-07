// SPDX-License-Identifier: GPL-3.0-or-later
// Lane MT (DevLog-033): monolithic piezoelectric u-V against the 1D thickness-mode closed forms (derivation in
// DevLog-033 s.4.3). Material numbers are arbitrary test numbers, not data of any real material.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boxMesh, rectTriMesh, nCells } from '../src/common/mesh.ts';
import { solvePiezo, type PiezoProblem } from '../src/coupled/piezo.ts';
import { stiffnessMatrix, piezoMatrix, eulerZXZ, rotateStiffness, rotatePiezo, rotate2, isotropicStiffness, type Mat } from '../src/coupled/tensors.ts';
import type { Mesh } from '@amp/spec/types';

// test numbers (6mm, z = poling)
const C = stiffnessMatrix('hexagonal-6mm', { C11: 1.3e11, C12: 7e10, C13: 6e10, C33: 1.0e11, C44: 3e10 });
const e = piezoMatrix('hexagonal-6mm', { e15: 8, e31: -3, e33: 10 });
const eps: Mat = [[6e-9, 0, 0], [0, 6e-9, 0], [0, 0, 5e-9]];
const rho = 7000;
const cD = 1.0e11 + 10 ** 2 / 5e-9, vD = Math.sqrt(cD / rho), kt2 = 10 ** 2 / (5e-9 * cD);

/** roots of tan X = X / kt^2 in ((j - 1/2) pi, (j + 1/2) pi) ... first root in (0, pi/2). */
function shortRoot(j: number): number {
  const g = (x: number) => Math.sin(x) - (x / kt2) * Math.cos(x);
  let a = j === 0 ? 1e-6 : (j - 0.5) * Math.PI + 1e-9, b = (j + 0.5) * Math.PI - 1e-9;
  for (let i = 0; i < 200; i++) { const m = 0.5 * (a + b); if (Math.sign(g(m)) === Math.sign(g(a))) a = m; else b = m; }
  return 0.5 * (a + b);
}

function rotated(R: Mat) { return { rho, C: rotateStiffness(C, R), e: rotatePiezo(e, R), eps: rotate2(eps, R) }; }

function column(m: Mesh, model: 'plane-strain' | '3d', lateral: string[], bottom: string, top: string, open: boolean, R: Mat, axis: number, extra: Partial<PiezoProblem> = {}): PiezoProblem {
  const nc = nCells(m);
  return {
    mesh: m, model, solid: new Uint8Array(nc).fill(1), dielectric: new Uint8Array(nc).fill(1), matOf: new Int32Array(nc), mats: [rotated(R)],
    // in-plane components fixed on every lateral face (only the interior centre nodes stay free in-plane; the
    // cross-section is 20x thinner than the column so their modes lie far above the thickness modes)
    solidBcs: lateral.flatMap((s) => [0, 1, 2].slice(0, m.dim).filter((c) => c !== axis).map((c) => ({ type: 'displacement' as const, select: [s], component: c, value: 0 }))),
    ground: open ? [bottom] : [bottom, top], potentials: [], floating: open ? [{ id: 'top', select: [top] }] : [],
    study: { kind: 'eigen', nModes: 12 }, ...extra,
  };
}

const t = 2e-3;
const fOpen = (n: number) => (n * vD) / (2 * t);
const fShort = (j: number) => (shortRoot(j) * 2 * vD) / (2 * Math.PI * t);

/** Thickness-extensional modes: share of the axis component in sum |u|^2 above 0.99 (the column's interior nodes
 * off the lateral faces are free in-plane, so other modes exist; they are skipped). */
function teModes(s: { fields: Array<{ name: string; data: Float64Array; step?: number }>; steps?: { values: Float64Array } }, dim: number, axis: number): number[] {
  const out: number[] = [];
  s.fields.filter((f) => f.name === 'u').forEach((f) => {
    let a = 0, all = 0;
    for (let i = 0; i < f.data.length; i += dim) for (let d = 0; d < dim; d++) { const v = f.data[i + d]! ** 2; all += v; if (d === axis) a += v; }
    if (a / all > 0.99) out.push(s.steps!.values[f.step!]!);
  });
  return out;
}

function checkSpectrum(f: number[], open: boolean, tol: number) {
  assert.ok(f.length >= 4, `thickness modes found: ${f.length}`);
  assert.ok(Math.abs(f[0]!) < 1e-6 * fOpen(1), `rigid mode ${f[0]}`);
  const ref = open ? [fOpen(1), fOpen(2), fOpen(3)] : [fShort(0), fOpen(2), fShort(1)];
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(f[i + 1]! - ref[i]!) / ref[i]! < tol, `${open ? 'open' : 'short'} mode ${i + 1}: ${f[i + 1]} vs ${ref[i]} (rel ${(f[i + 1]! - ref[i]!) / ref[i]!})`);
}

for (const open of [true, false]) test(`piezo 3D tet10 thickness mode, ${open ? 'open' : 'short'} circuit vs 1D closed form`, async () => {
  const m = boxMesh({ x: [0, 1e-4], y: [0, 1e-4], z: [0, t], nx: 1, ny: 1, nz: 16, cell: 'tet10' });
  const s = await solvePiezo(column(m, '3d', ['bnd:box.xmin', 'bnd:box.xmax', 'bnd:box.ymin', 'bnd:box.ymax'], 'bnd:box.zmin', 'bnd:box.zmax', open, eulerZXZ(0, 0, 0), 2));
  checkSpectrum(teModes(s, 3, 2), open, 1e-4);   // P2 dispersion error of mode 3 with 16 elements is ~5e-5
  // relative residual of the non-rigid pairs (for f = 0 the relative measure is undefined)
  assert.ok(Array.from(s.detail.eigResidual as Float64Array).every((r, i) => s.steps!.values[i] === 0 || r < 1e-6), `residuals ${Array.from(s.detail.eigResidual as Float64Array)}`);
});

test('piezo 3D rotated: column along x, crystal c axis along x (Euler ZXZ 90, 90, 0), open circuit', async () => {
  const m = boxMesh({ x: [0, t], y: [0, 1e-4], z: [0, 1e-4], nx: 16, ny: 1, nz: 1, cell: 'tet10' });
  const R = eulerZXZ(Math.PI / 2, Math.PI / 2, 0);
  assert.ok(Math.abs(R[0]![2]! - 1) < 1e-12, 'crystal z maps to model x');
  const s = await solvePiezo(column(m, '3d', ['bnd:box.ymin', 'bnd:box.ymax', 'bnd:box.zmin', 'bnd:box.zmax'], 'bnd:box.xmin', 'bnd:box.xmax', true, R, 0));
  checkSpectrum(teModes(s, 3, 0), true, 1e-4);
});

for (const open of [true, false]) test(`piezo 2D plane strain, c axis along model y (Euler 0, -90, 0), ${open ? 'open' : 'short'} circuit`, async () => {
  const m = rectTriMesh({ x: [0, 1e-4], y: [0, t], nx: 1, ny: 16, order: 2 });
  const s = await solvePiezo(column(m, 'plane-strain', ['bnd:rect.left', 'bnd:rect.right'], 'bnd:rect.bottom', 'bnd:rect.top', open, eulerZXZ(0, -Math.PI / 2, 0), 1));
  checkSpectrum(teModes(s, 2, 1), open, 1e-4);   // P2 dispersion error of mode 3 with 16 elements is ~5e-5
});

test('piezo stationary: clamped and free capacitance of the laterally constrained plate, C_free = C_clamped / (1 - kt^2)', async () => {
  const m = boxMesh({ x: [0, 1e-3], y: [0, 1e-3], z: [0, t], nx: 1, ny: 1, nz: 4, cell: 'tet10' });
  const A = 1e-6, V0 = 1;
  const base = column(m, '3d', ['bnd:box.xmin', 'bnd:box.xmax', 'bnd:box.ymin', 'bnd:box.ymax'], 'bnd:box.zmin', 'bnd:box.zmax', false, eulerZXZ(0, 0, 0), 2);
  const run = (clamped: boolean) => solvePiezo({ ...base, ground: ['bnd:box.zmin'], potentials: [{ id: 'top', select: ['bnd:box.zmax'], V: V0 }], floating: [], study: { kind: 'stationary' },
    solidBcs: [...base.solidBcs, { type: 'fixed', select: ['bnd:box.zmin'] }, ...(clamped ? [{ type: 'fixed' as const, select: ['bnd:box.zmax'] }] : [])] });
  const cl = await run(true), fr = await run(false);
  const Cc = (5e-9 * A) / t;
  assert.ok(Math.abs(cl.scalars.Q_top!.value - Cc * V0) / (Cc * V0) < 1e-10, `clamped Q ${cl.scalars.Q_top!.value} vs ${Cc * V0}`);
  assert.ok(Math.abs(fr.scalars.Q_top!.value - (Cc * V0) / (1 - kt2)) / ((Cc * V0) / (1 - kt2)) < 1e-10, `free Q ${fr.scalars.Q_top!.value} vs ${(Cc * V0) / (1 - kt2)}`);
  assert.ok(Math.abs(cl.scalars.Q_ground!.value + Cc * V0) / (Cc * V0) < 1e-10, 'charge balance');
});

test('tensors: isotropic stiffness is rotation invariant; 6mm stiffness invariant about z', () => {
  const Ci = isotropicStiffness(1e11, 0.3), R = eulerZXZ(0.3, 1.1, -0.7);
  const Cr = rotateStiffness(Ci, R);
  for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) assert.ok(Math.abs(Cr[i]![j]! - Ci[i]![j]!) < 1e-4, `iso ${i}${j}`);
  const C6 = rotateStiffness(C, eulerZXZ(0.77, 0, 0));
  for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) assert.ok(Math.abs(C6[i]![j]! - C[i]![j]!) < 1e-4, `6mm ${i}${j}`);
  const e6 = rotatePiezo(e, eulerZXZ(0.77, 0, 0));
  for (let i = 0; i < 3; i++) for (let j = 0; j < 6; j++) assert.ok(Math.abs(e6[i]![j]! - e[i]![j]!) < 1e-12, `e 6mm ${i}${j}`);
});

test('tensors: 3m stiffness and e invariant under the 3-fold rotation about z (120 deg)', () => {
  const C3 = stiffnessMatrix('trigonal-3m', { C11: 2.0e11, C12: 5.5e10, C13: 7.5e10, C14: 9e9, C33: 2.4e11, C44: 6e10 });
  const e3 = piezoMatrix('trigonal-3m', { e15: 3.7, e22: 2.4, e31: 0.2, e33: 1.3 });
  const R = eulerZXZ((2 * Math.PI) / 3, 0, 0);
  const Cr = rotateStiffness(C3, R), er = rotatePiezo(e3, R);
  for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) assert.ok(Math.abs(Cr[i]![j]! - C3[i]![j]!) < 1e-3, `C ${i}${j}: ${Cr[i]![j]} vs ${C3[i]![j]}`);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 6; j++) assert.ok(Math.abs(er[i]![j]! - e3[i]![j]!) < 1e-12, `e ${i}${j}: ${er[i]![j]} vs ${e3[i]![j]}`);
  // mirror x -> -x (y-z mirror plane) leaves both invariant
  const Mx: Mat = [[-1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const Cm = rotateStiffness(C3, Mx), em = rotatePiezo(e3, Mx);
  for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) assert.ok(Math.abs(Cm[i]![j]! - C3[i]![j]!) < 1e-3, `Cm ${i}${j}`);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 6; j++) assert.ok(Math.abs(em[i]![j]! - e3[i]![j]!) < 1e-12, `em ${i}${j}`);
});
