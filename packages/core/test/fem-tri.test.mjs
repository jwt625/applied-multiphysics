// Ported from eo-modulator-atlas/engine/tests/perf-p2.test.mjs and electrostatics.test.mjs at 0546007
// (GPL-3.0-or-later). Changes: the FEM-level content of those tests is kept and run directly on fem/tri.mjs
// (PoissonSolver, p2Space, p2Grad) instead of through EO electrostatics.mjs (physics, lane L4) and the EO mesher
// (lane L3): structured triangle meshes from helpers/tri-grid.mjs, electrodes as Dirichlet node sets, energy form and
// terminal charge in the dimensionless units of fem.mjs (C' / eps0). Kept: parallel plates exact for P1 and P2 with
// energy = charge (perf-p2 test 1, electrostatics test 1 without the RF/Z0 post); P2 closer than P1 to a fine P2
// reference at a matched DOF count on the strip pair (perf-p2 test 2; matched within 10 %); P2 reproduces a uniform
// field at interior points (perf-p2 test 3, p2Grad instead of gradientAt). Dropped: weight normalisation, odd mirror
// symmetry and crystal rotation (EO electrostatics / materials).
// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { PoissonSolver, p2Space, p2Grad, triangleGeometry } from '../src/fem/tri.mjs';
import { lines, triGrid, inRect } from './helpers/tri-grid.mjs';

const relErr = (a, b) => Math.abs(a - b) / Math.abs(b);
const iso = (mesh, e) => { const c = new Float64Array(3 * mesh.nTris); for (let t = 0; t < mesh.nTris; t++) { c[3 * t] = e; c[3 * t + 2] = e; } return c; };

/** Dirichlet DOFs: P1 nodes, or P2 vertices + edge midpoints (space.dofX/dofY when present, else edge midpoints). */
function dofCoords(mesh, space) {
  if (!space) return { x: mesh.x, y: mesh.y, n: mesh.nNodes };
  const n = space.pat.n, x = new Float64Array(n), y = new Float64Array(n);
  for (let t = 0; t < mesh.nTris; t++) {
    const v = [0, 1, 2].map((a) => mesh.tri[3 * t + a]);
    for (let a = 0; a < 3; a++) { const d = space.elem[6 * t + a]; x[d] = mesh.x[v[a]]; y[d] = mesh.y[v[a]]; }
    const loc = [[0, 1], [1, 2], [2, 0]];
    for (let e = 0; e < 3; e++) { const d = space.elem[6 * t + 3 + e]; x[d] = 0.5 * (mesh.x[v[loc[e][0]]] + mesh.x[v[loc[e][1]]]); y[d] = 0.5 * (mesh.y[v[loc[e][0]]] + mesh.y[v[loc[e][1]]]); }
  }
  return { x, y, n };
}

/** Two-terminal capacitance form: energy phi^T K phi and the terminal charge of the V = 1 electrode. */
function twoTerminal(mesh, order, eps, isZero, isOne, isGround = () => false) {
  const space = order === 2 ? p2Space(mesh) : null;
  const { x, y, n } = dofCoords(mesh, space);
  const dir = new Uint8Array(n), phiD = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    if (isOne(x[i], y[i])) { dir[i] = 1; phiD[i] = 1; } else if (isZero(x[i], y[i]) || isGround(x[i], y[i])) dir[i] = 1;
  }
  const ps = new PoissonSolver(mesh, iso(mesh, eps), dir, null, null, { space });
  const { phi, residual } = ps.solve(phiD);
  let q = 0;
  for (let i = 0; i < n; i++) if (dir[i] && phiD[i] === 1) q += residual[i];
  return { energy: ps.energyForm(phi), charge: q, nDof: n, ps, phi, space };
}

test('P1 and P2 reproduce the parallel-plate capacitance exactly; energy = terminal charge', () => {
  // domain [0, 4] x [0, 1], electrodes x <= 1 (0 V) and x >= 3 (1 V), eps_r 5: C'/eps0 = 5 * 1 / 2
  const mesh = triGrid(lines([0, 1, 3, 4], 0.3), lines([0, 1], 0.3));
  for (const order of [1, 2]) {
    const r = twoTerminal(mesh, order, 5, (x) => x <= 1 + 1e-12, (x) => x >= 3 - 1e-12);
    assert.ok(relErr(r.energy, 2.5) < 1e-10, `order ${order}: ${r.energy}`);
    assert.ok(relErr(r.charge, r.energy) < 1e-10);
  }
});

test('P2 is more accurate than P1 at a matched DOF count on a non-uniform field (strip pair)', () => {
  // grounded box [-6, 6]^2, strips rect(-2, -0.5, -0.1, 0.1) at 0 V and rect(0.5, 2, -0.1, 0.1) at 1 V, eps_r 1
  const bx = [-6, -2, -0.5, 0.5, 2, 6], by = [-6, -0.1, 0.1, 6];
  const a = inRect(-2, -0.5, -0.1, 0.1), b = inRect(0.5, 2, -0.1, 0.1);
  const box = (x, y) => Math.abs(Math.abs(x) - 6) < 1e-12 || Math.abs(Math.abs(y) - 6) < 1e-12;
  const run = (h, order) => twoTerminal(triGrid(lines(bx, h), lines(by, h)), order, 1, a, b, box);
  const ref = run(0.05, 2).energy;
  const p1 = run(0.1, 1), p2 = run(0.2, 2);
  assert.ok(Math.abs(p2.nDof - p1.nDof) < 0.1 * p1.nDof, `${p2.nDof} vs ${p1.nDof}`);
  assert.ok(relErr(p2.energy, ref) < 0.5 * relErr(p1.energy, ref), `P2 ${relErr(p2.energy, ref)} vs P1 ${relErr(p1.energy, ref)}`);
});

test('gradient: P1 per-triangle gradient; P2 reproduces a uniform field at any interior point', () => {
  const mesh = triGrid(lines([0, 1, 3, 4], 0.3), lines([0, 1], 0.3));
  const p1 = twoTerminal(mesh, 1, 5, (x) => x <= 1 + 1e-12, (x) => x >= 3 - 1e-12);
  const g1 = p1.ps.gradient(p1.phi);
  let n1 = 0;
  for (let t = 0; t < mesh.nTris; t++) {
    const xv = [0, 1, 2].map((a) => mesh.x[mesh.tri[3 * t + a]]);
    if (Math.min(...xv) < 1 - 1e-12 || Math.max(...xv) > 3 + 1e-12) continue;
    assert.ok(Math.abs(g1.gx[t] - 0.5) < 1e-9 && Math.abs(g1.gy[t]) < 1e-9, `${g1.gx[t]} ${g1.gy[t]}`);
    n1++;
  }
  assert.ok(n1 > 5);
  const p2 = twoTerminal(mesh, 2, 5, (x) => x <= 1 + 1e-12, (x) => x >= 3 - 1e-12);
  const geo = triangleGeometry(mesh);
  const gxN = new Float64Array(6), gyN = new Float64Array(6);
  let checked = 0;
  for (let t = 0; t < mesh.nTris; t += 7) {
    const cx = (mesh.x[mesh.tri[3 * t]] + mesh.x[mesh.tri[3 * t + 1]] + mesh.x[mesh.tri[3 * t + 2]]) / 3;
    if (cx < 1 || cx > 3) continue;
    p2Grad(geo, t, [0.2, 0.3, 0.5], gxN, gyN);
    let gx = 0, gy = 0;
    for (let k = 0; k < 6; k++) { const v = p2.phi[p2.space.elem[6 * t + k]]; gx += gxN[k] * v; gy += gyN[k] * v; }
    assert.ok(Math.abs(gx - 0.5) < 1e-9 && Math.abs(gy) < 1e-9, `${gx} ${gy}`);
    checked++;
  }
  assert.ok(checked > 5);
});
