// SPDX-License-Identifier: GPL-3.0-or-later
// Lane MT (DevLog-033): monolithic acoustic-structure (u-p) eigenfrequencies: decoupled limit against the separate
// elastic and acoustics solvers, and a layered 1D column against the transmission-line equation (derivation in
// DevLog-033 s.4.4). Coefficients are arbitrary test numbers, not material data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rectTriMesh, nCells, makeMesh } from '../src/common/mesh.ts';
import { solveAcousticStructure, type FsiProblem } from '../src/coupled/fsi.ts';
import { solveElasticModes } from '../src/elastic/modal.ts';
import { solveAcousticModes } from '../src/acoustics/index.ts';
import type { Mesh } from '@amp/spec/types';

/** Rectangle mesh with cells below y = ySplit in domain 0 (dom:solid), the rest in domain 1 (dom:fluid). */
function layered(o: { x: [number, number]; y: [number, number]; nx: number; ny: number; ySplit: number; axisym?: boolean }): Mesh {
  const m = rectTriMesh({ x: o.x, y: o.y, nx: o.nx, ny: o.ny, order: 2, ...(o.axisym ? { axisym: true } : {}) });
  const k = 6, nc = nCells(m), dom = new Int32Array(nc);
  for (let c = 0; c < nc; c++) { let y = 0; for (let a = 0; a < 3; a++) y += m.nodes[2 * m.cells.conn[k * c + a]! + 1]! / 3; dom[c] = y < o.ySplit ? 0 : 1; }
  return makeMesh({ ...m, cells: { ...m.cells, domain: dom }, entities: { ...m.entities, domains: [{ id: 'dom:solid' }, { id: 'dom:fluid' }] } });
}

const fill = (n: number, v: number) => new Float64Array(n).fill(v);

function fsiProblem(m: Mesh, model: FsiProblem['model'], s: { E: number; nu: number; rho: number }, f: { c: number; rho: number }, bcs: FsiProblem['solidBcs'], nModes: number): FsiProblem {
  const nc = nCells(m), solid = new Uint8Array(nc), fluid = new Uint8Array(nc);
  for (let c = 0; c < nc; c++) { if (m.cells.domain[c] === 0) solid[c] = 1; else fluid[c] = 1; }
  const per = (mask: Uint8Array, v: number) => Float64Array.from(mask, (x) => (x ? v : NaN));
  return { mesh: m, model, solid, fluid, E: per(solid, s.E), nu: per(solid, s.nu), rhoS: per(solid, s.rho), c: per(fluid, f.c), rhoF: per(fluid, f.rho), solidBcs: bcs, nModes };
}

test('acoustic-structure decoupled limit: rho_fluid -> 1e-9 x reproduces the separate elastic and acoustics spectra', async () => {
  const m = layered({ x: [0, 1], y: [0, 1], nx: 8, ny: 10, ySplit: 0.3 });
  const sol = { E: 2e9, nu: 0.3, rho: 2000 }, fl = { c: 340, rho: 2000 * 1e-9 };
  const bcs = [{ type: 'fixed' as const, select: ['bnd:rect.bottom'] }];
  const p = fsiProblem(m, 'plane-strain', sol, fl, bcs, 8);
  const cpl = await solveAcousticStructure(p);
  const es = await solveElasticModes({ mesh: m, model: 'plane-strain', E: p.E, nu: p.nu, rho: p.rhoS, mask: p.solid, bcs, nModes: 8 });
  const ac = await solveAcousticModes({ mesh: m, c: p.c, rho: p.rhoF, mask: p.fluid, nModes: 8 });
  const sep = [...Array.from(es.steps!.values), ...Array.from(ac.steps!.values)].sort((a, b) => a - b).slice(0, 8);
  const got = Array.from(cpl.steps!.values);
  for (let i = 0; i < 8; i++) {
    const ref = sep[i]!, d = Math.abs(got[i]! - ref);
    assert.ok(ref === 0 ? d < 1e-6 : d / ref < 1e-6, `mode ${i}: coupled ${got[i]} separate ${ref}`);
  }
});

/** Roots of Z_s tan(w b / c_f) + Z_f tan(w a / c_s) = 0 (as sin / cos products, no poles), first n positive. */
function layerRoots(a: number, b: number, cs: number, Zs: number, cf: number, Zf: number, n: number): number[] {
  const g = (w: number) => Zs * Math.sin((w * b) / cf) * Math.cos((w * a) / cs) + Zf * Math.sin((w * a) / cs) * Math.cos((w * b) / cf);
  const out: number[] = [];
  const dw = 1e-3 * Math.min(cs / a, cf / b);
  for (let w = dw; out.length < n; w += dw) {
    if (Math.sign(g(w)) !== Math.sign(g(w + dw))) {
      let lo = w, hi = w + dw;
      for (let i = 0; i < 100; i++) { const mid = 0.5 * (lo + hi); if (Math.sign(g(mid)) === Math.sign(g(lo))) lo = mid; else hi = mid; }
      out.push(0.5 * (lo + hi) / (2 * Math.PI));
    }
  }
  return out;
}

test('acoustic-structure 1D layered column (elastic layer on a rigid base, fluid layer, rigid lid) vs the transmission-line roots', async () => {
  const a = 0.5, b = 1.0, w = 0.02;
  const s = { E: 1e9, nu: 0.25, rho: 1000 }, f = { c: 1500, rho: 1000 };
  const Ms = (s.E * (1 - s.nu)) / ((1 + s.nu) * (1 - 2 * s.nu)), cs = Math.sqrt(Ms / s.rho);
  const ref = layerRoots(a, b, cs, s.rho * cs, f.c, f.rho * f.c, 4);
  const m = layered({ x: [0, w], y: [0, a + b], nx: 1, ny: 60, ySplit: a });
  const bcs = [{ type: 'fixed' as const, select: ['bnd:rect.bottom'] },
    { type: 'displacement' as const, select: ['bnd:rect.left'], component: 0, value: 0 }, { type: 'displacement' as const, select: ['bnd:rect.right'], component: 0, value: 0 }];
  const r = await solveAcousticStructure(fsiProblem(m, 'plane-strain', s, f, bcs, 5));
  // the u-p form of a closed cavity has an f = 0 pair (uniform pressure with the static deformation it causes)
  assert.equal(r.steps!.values[0], 0);
  const got = Array.from(r.steps!.values).slice(1);
  for (let i = 0; i < 4; i++) assert.ok(Math.abs(got[i]! - ref[i]!) / ref[i]! < 1e-5, `mode ${i}: ${got[i]} vs ${ref[i]} (rel ${(got[i]! - ref[i]!) / ref[i]!})`);
  // pencil residual of the Ritz vectors (Arnoldi tol 1e-10 on the operator; the relative pencil measure scales with lambda_max / lambda)
  assert.ok(Array.from(r.detail.eigResidual as Float64Array).slice(1).every((x) => x < 1e-4), `residuals ${Array.from(r.detail.eigResidual as Float64Array)}`);
  // the coupled modes are neither solid-only nor fluid-only
  const share = (r.detail.solidEnergyShare as number[]).slice(1);
  assert.ok(share.every((x) => x > 0.01 && x < 0.99), `solid energy shares ${share}`);
});

test('acoustic-structure axisym: decoupled limit matches the separate solvers (weight r on the wet interface)', async () => {
  const m = layered({ x: [0, 0.5], y: [0, 1], nx: 6, ny: 10, ySplit: 0.2, axisym: true });
  const sol = { E: 2e9, nu: 0.3, rho: 2000 }, fl = { c: 340, rho: 2000 * 1e-9 };
  const bcs = [{ type: 'fixed' as const, select: ['bnd:rect.bottom'] }];
  const p = fsiProblem(m, 'axisym', sol, fl, bcs, 6);
  const cpl = await solveAcousticStructure(p);
  const es = await solveElasticModes({ mesh: m, model: 'axisym', E: p.E, nu: p.nu, rho: p.rhoS, mask: p.solid, bcs, nModes: 6 });
  const ac = await solveAcousticModes({ mesh: m, c: p.c, rho: p.rhoF, mask: p.fluid, nModes: 6 });
  const sep = [...Array.from(es.steps!.values), ...Array.from(ac.steps!.values)].sort((x, y) => x - y).slice(0, 6);
  const got = Array.from(cpl.steps!.values);
  for (let i = 0; i < 6; i++) { const d = Math.abs(got[i]! - sep[i]!); assert.ok(sep[i] === 0 ? d < 1e-6 : d / sep[i]! < 1e-6, `mode ${i}: ${got[i]} vs ${sep[i]}`); }
  assert.ok(Math.abs((cpl.detail.wetMeasure as number) - 0.5 ** 2 / 2) < 1e-12, `wet measure ${cpl.detail.wetMeasure} (int r dr over [0, 0.5])`);
});

test('acoustic-structure 3D tet10 layered column vs the transmission-line roots (tri6 wet faces)', async () => {
  const a = 0.5, b = 1.0, w = 0.02;
  const s = { E: 1e9, nu: 0.25, rho: 1000 }, f = { c: 1500, rho: 1000 };
  const Ms = (s.E * (1 - s.nu)) / ((1 + s.nu) * (1 - 2 * s.nu)), cs = Math.sqrt(Ms / s.rho);
  const ref = layerRoots(a, b, cs, s.rho * cs, f.c, f.rho * f.c, 3);
  const { boxMesh } = await import('../src/common/mesh.ts');
  const m0 = boxMesh({ x: [0, w], y: [0, w], z: [0, a + b], nx: 1, ny: 1, nz: 30, cell: 'tet10' });
  const nc = nCells(m0), dom = new Int32Array(nc);
  for (let c = 0; c < nc; c++) { let z = 0; for (let k = 0; k < 4; k++) z += m0.nodes[3 * m0.cells.conn[10 * c + k]! + 2]! / 4; dom[c] = z < a ? 0 : 1; }
  const m = makeMesh({ ...m0, cells: { ...m0.cells, domain: dom }, entities: { ...m0.entities, domains: [{ id: 'dom:solid' }, { id: 'dom:fluid' }] } });
  const lat = ['bnd:box.xmin', 'bnd:box.xmax', 'bnd:box.ymin', 'bnd:box.ymax'];
  const bcs = [{ type: 'fixed' as const, select: ['bnd:box.zmin'] }, ...lat.flatMap((sel) => [0, 1].map((c) => ({ type: 'displacement' as const, select: [sel], component: c, value: 0 })))];
  const r = await solveAcousticStructure(fsiProblem(m, '3d', s, f, bcs, 4));
  assert.equal(r.steps!.values[0], 0);
  const got = Array.from(r.steps!.values).slice(1);
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(got[i]! - ref[i]!) / ref[i]! < 1e-4, `mode ${i}: ${got[i]} vs ${ref[i]} (rel ${(got[i]! - ref[i]!) / ref[i]!})`);
  assert.ok(Math.abs((r.detail.wetMeasure as number) - w * w) < 1e-15, `wet area ${r.detail.wetMeasure}`);
});

/** Two closed air cavities on both sides of a free elastic layer (1D, rigid ends): roots of the 4 x 4 interface determinant. */
function twoCavityRoots(a: number, b1: number, b2: number, Ms: number, rs: number, cf: number, rf: number, n: number): number[] {
  const cs = Math.sqrt(Ms / rs);
  const det = (w: number) => {
    const ks = w / cs, kf = w / cf, w2 = w * w;
    // unknowns A, B (u = A cos ks y + B sin ks y), P1, P2; rows scaled to O(1)
    const M = [
      [0, Ms * ks, Math.cos(kf * b1), 0],
      [-w2, 0, (-kf * Math.sin(kf * b1)) / rf, 0],
      [-Ms * ks * Math.sin(ks * a), Ms * ks * Math.cos(ks * a), 0, Math.cos(kf * b2)],
      [-w2 * Math.cos(ks * a), -w2 * Math.sin(ks * a), 0, (kf * Math.sin(kf * b2)) / rf],
    ];
    const d3 = (m: number[][]) => m[0]![0]! * (m[1]![1]! * m[2]![2]! - m[1]![2]! * m[2]![1]!) - m[0]![1]! * (m[1]![0]! * m[2]![2]! - m[1]![2]! * m[2]![0]!) + m[0]![2]! * (m[1]![0]! * m[2]![1]! - m[1]![1]! * m[2]![0]!);
    let s = 0;
    for (let j = 0; j < 4; j++) { const minor = M.slice(1).map((r) => r.filter((_, c) => c !== j)); s += (j % 2 ? -1 : 1) * M[0]![j]! * d3(minor); }
    return s / (w2 * w2);
  };
  const out: number[] = [], dw = 1e-3 * Math.min(cs / a, cf / Math.max(b1, b2));
  for (let w = dw; out.length < n; w += dw) if (Math.sign(det(w)) !== Math.sign(det(w + dw))) {
    let lo = w, hi = w + dw;
    for (let i = 0; i < 100; i++) { const m = 0.5 * (lo + hi); if (Math.sign(det(m)) === Math.sign(det(lo))) lo = m; else hi = m; }
    out.push((0.5 * (lo + hi)) / (2 * Math.PI));
  }
  return out;
}

test('acoustic-structure, two closed cavities (fluid | free elastic layer | fluid): two f = 0 modes, then the 1D interface-determinant roots', async () => {
  const b1 = 0.4, a = 0.2, b2 = 0.6, w = 0.02;
  const s = { E: 1e9, nu: 0.25, rho: 1000 }, f = { c: 340, rho: 100 };   // test numbers (heavy "air" for strong coupling)
  const Ms = (s.E * (1 - s.nu)) / ((1 + s.nu) * (1 - 2 * s.nu));
  const ref = twoCavityRoots(a, b1, b2, Ms, s.rho, f.c, f.rho, 3);
  // layers along y: fluid [0, b1], solid [b1, b1 + a], fluid [b1 + a, b1 + a + b2]; domain 0 = solid
  const m0 = rectTriMesh({ x: [0, w], y: [0, b1 + a + b2], nx: 1, ny: 120, order: 2 });
  const nc = nCells(m0), dom = new Int32Array(nc);
  for (let c = 0; c < nc; c++) { let y = 0; for (let k = 0; k < 3; k++) y += m0.nodes[2 * m0.cells.conn[6 * c + k]! + 1]! / 3; dom[c] = y > b1 && y < b1 + a ? 0 : 1; }
  const m = makeMesh({ ...m0, cells: { ...m0.cells, domain: dom }, entities: { ...m0.entities, domains: [{ id: 'dom:solid' }, { id: 'dom:fluid' }] } });
  const bcs = [{ type: 'displacement' as const, select: ['bnd:rect.left'], component: 0, value: 0 }, { type: 'displacement' as const, select: ['bnd:rect.right'], component: 0, value: 0 }];
  const r = await solveAcousticStructure(fsiProblem(m, 'plane-strain', s, f, bcs, 5));
  const fz = Array.from(r.steps!.values);
  assert.equal(r.detail.closedRegions, 2);
  assert.deepEqual(fz.slice(0, 2), [0, 0], `zero modes ${fz}`);
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(fz[i + 2]! - ref[i]!) / ref[i]! < 1e-4, `mode ${i}: ${fz[i + 2]} vs ${ref[i]} (rel ${(fz[i + 2]! - ref[i]!) / ref[i]!})`);
  assert.match(((r as unknown as { notes?: string[] }).notes ?? []).join(' '), /2 closed fluid region/);
});
