// SPDX-License-Identifier: GPL-3.0-or-later
// Test helper (not exported by @amp/core): scalar conduction operator on an APA grid snapshot (fixtures/apa-grids.json)
// with the ported Q1 assembly (src/fem/q1-grid.mjs), standing in for APA grid/ + thermal/index.mjs solveThermal in the
// ported tests la-mg and la-wasm. Supported inputs are exactly those of the two fixtures: volumetric sources on part
// globs, one HTC selection `bottom:<part>` (k = 0 faces) or `top:<part>` (k = nz - 1 faces), no fixed temperatures.
// Unknown theta = T - T_inf (the single HTC ambient), so the Robin load is zero. activeNodes is ported from
// advanced-packaging-atlas/engine/src/grid/index.mjs at fe39985 (verbatim).
import { createStencil, padded } from '../../src/la/stencil.mjs';
import { assembleConduction, addRobinFace, addCellSources, applyConstraints } from '../../src/fem/q1-grid.mjs';

export function gridOf(fx) {
  const g = fx.grid;
  const cellPart = new Int32Array(g.nx * g.ny * g.nz);
  for (let q = 0, o = 0; q < g.cellPartRLE.length; q += 2) { cellPart.fill(g.cellPartRLE[q], o, o + g.cellPartRLE[q + 1]); o += g.cellPartRLE[q + 1]; }
  return { nx: g.nx, ny: g.ny, nz: g.nz, xs: Float64Array.from(g.xs), ys: Float64Array.from(g.ys), zs: Float64Array.from(g.zs), cellPart, parts: g.parts };
}

export function activeNodes(grid) {
  const { nx, ny, nz, cellPart } = grid;
  const NX = nx + 1, NY = ny + 1;
  const act = new Uint8Array(NX * NY * (nz + 1));
  for (let k = 0, c = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++, c++) {
        if (cellPart[c] < 0) continue;
        const n = i + NX * (j + NY * k);
        act[n] = act[n + 1] = act[n + NX] = act[n + NX + 1] = 1;
        const m = n + NX * NY;
        act[m] = act[m + 1] = act[m + NX] = act[m + NX + 1] = 1;
      }
  return act;
}

const globRe = (glob) => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);

/** {op, b, x, grid, T_inf_C}: padded right-hand side and zero initial guess. */
export function conductionSystem(fx) {
  const grid = gridOf(fx);
  const { nx, ny, nz, xs, ys, zs, cellPart, parts } = grid;
  const nc = nx * ny * nz;
  const kc = new Float64Array(3 * nc);
  for (let c = 0; c < nc; c++) if (cellPart[c] >= 0) kc.set(fx.K[parts[cellPart[c]].material], 3 * c);
  const op = createStencil(nx + 1, ny + 1, nz + 1);
  assembleConduction(grid, kc, op);
  const F = new Float64Array(op.N);
  const q = new Float64Array(nc);
  for (const s of fx.thermal.sources) {
    const re = globRe(s.parts);
    let V = 0;
    const cells = [];
    for (let c = 0; c < nc; c++) if (cellPart[c] >= 0 && re.test(parts[cellPart[c]].id)) {
      const i = c % nx, j = Math.floor(c / nx) % ny, k = Math.floor(c / (nx * ny));
      V += (xs[i + 1] - xs[i]) * (ys[j + 1] - ys[j]) * (zs[k + 1] - zs[k]);
      cells.push(c);
    }
    for (const c of cells) q[c] += s.power_W / V;
  }
  addCellSources(grid, F, q);
  if (fx.thermal.bcs.length !== 1 || fx.thermal.bcs[0].type !== 'htc') throw new Error('helper supports one htc selection');
  const bc = fx.thermal.bcs[0];
  const [side, pid] = bc.selection.split(':');
  const k = side === 'bottom' ? 0 : nz - 1, d = side === 'bottom' ? 4 : 5;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const c = i + nx * (j + ny * k);
    if (cellPart[c] >= 0 && parts[cellPart[c]].id === pid) addRobinFace(grid, op, F, c, d, bc.h_W_m2K, 0);
  }
  applyConstraints(op, F, new Float64Array(op.N).fill(NaN), activeNodes(grid));
  const b = padded(op), x = padded(op);
  b.set(F, op.pad);
  return { op, b, x, grid, T_inf_C: bc.T_inf_C };
}
