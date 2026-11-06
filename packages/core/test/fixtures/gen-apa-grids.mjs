// SPDX-License-Identifier: GPL-3.0-or-later
// Generator of test/fixtures/apa-grids.json: rectilinear grid snapshots (xs, ys, zs, cellPart) built by the
// advanced-packaging-atlas grid module (read only) for the parts of APA tests la-mg.test.mjs and la-wasm.test.mjs at
// fe39985, plus APA's own solveThermal results on them (reference numbers for the ported tests). The grid and thermal
// modules are not part of @amp/core, so the tests read this snapshot instead.
// Usage: node test/fixtures/gen-apa-grids.mjs --apa <path to advanced-packaging-atlas/engine>   (or env AMP_APA_ATLAS)
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const i = process.argv.indexOf('--apa');
const APA = i > 0 ? process.argv[i + 1] : process.env.AMP_APA_ATLAS;
if (!APA) throw new Error('give --apa <advanced-packaging-atlas/engine> or AMP_APA_ATLAS');
const { buildGrid } = await import(`${APA}/src/grid/index.mjs`);
const { solveThermal } = await import(`${APA}/src/thermal/index.mjs`);

const rle = (a) => { const out = []; for (let q = 0; q < a.length; ) { let r = q; while (r < a.length && a[r] === a[q]) r++; out.push(a[q], r - q); q = r; } return out; };

const cases = {};
{ // la-mg.test.mjs (Cu strips); conductivities synthetic in that test (0.3 / 390 W/m K)
  const parts = [{ id: 'base', kind: 'layer', material: 'pol', x_mm: 0, y_mm: 0, w_mm: 10, d_mm: 10, z_um: 0, h_um: 500 }];
  for (let s = 0; s < 40; s++) parts.push({ id: `cu_${s}`, kind: 'trace', material: 'cu', x_mm: -4 + s * 0.2, y_mm: 0, w_mm: 0.005, d_mm: 9, z_um: 500, h_um: 10 });
  parts.push({ id: 'top', kind: 'layer', material: 'pol', x_mm: 0, y_mm: 0, w_mm: 10, d_mm: 10, z_um: 500, h_um: 10, priority: -1 });
  const K = { pol: [0.3, 0.3, 0.3], cu: [390, 390, 390] };
  const g = buildGrid(parts, { max_xy_mm: 2, grading: 1.3, min_cells_per_layer: 2 });
  const th = { sources: [{ parts: 'cu_*', power_W: 5 }], bcs: [{ selection: 'bottom:base', type: 'htc', h_W_m2K: 1e4, T_inf_C: 25 }] };
  const m = solveThermal(g, th, (k) => ({ k_W_mK: K[k] }), { solver: 'pcg_mg', rtol: 1e-12 });
  cases.cuStrips = { test: 'la-mg.test.mjs', K, thermal: th, mgOptions: { coarseMax: 6000, ordering: 'nd' }, rtol: 1e-12,
    grid: { nx: g.nx, ny: g.ny, nz: g.nz, xs: [...g.xs], ys: [...g.ys], zs: [...g.zs], cellPartRLE: rle(g.cellPart), parts: g.parts.map((p) => ({ id: p.id, material: p.material })) },
    apa: { iterations: m.timing.iterations, mg: { levels: m.timing.mg.levels, coarsened: m.timing.mg.coarsened }, Tmax_C: m.derived.Tmax_C.value } };
}
{ // la-wasm.test.mjs (substrate, die, lid)
  const parts = [
    { id: 'substrate', kind: 'substrate', material: 'sub', x_mm: 0, y_mm: 0, w_mm: 40, d_mm: 30, z_um: 0, h_um: 1200 },
    { id: 'die', kind: 'die', material: 'si', x_mm: 0, y_mm: 0, w_mm: 16, d_mm: 12, z_um: 1200, h_um: 775 },
    { id: 'lid', kind: 'lid', material: 'cu', x_mm: 0, y_mm: 0, w_mm: 30, d_mm: 24, z_um: 1975, h_um: 1500 },
  ];
  const K = { sub: [30, 30, 0.6], si: [148, 148, 148], cu: [390, 390, 390] };
  const g = buildGrid(parts, { max_xy_mm: 1, min_cells_per_layer: 2, max_z_mm: 0.3 });
  const th = { sources: [{ parts: 'die', power_W: 100 }], bcs: [{ selection: 'top:lid', type: 'htc', h_W_m2K: 1e4, T_inf_C: 25 }] };
  const m = solveThermal(g, th, (k) => ({ k_W_mK: K[k] }), { solver: 'pcg_mg', rtol: 1e-12, coarseMax: 500 });
  cases.dieLid = { test: 'la-wasm.test.mjs', K, thermal: th, mgOptions: { coarseMax: 500, ordering: 'nd' }, rtol: 1e-12,
    grid: { nx: g.nx, ny: g.ny, nz: g.nz, xs: [...g.xs], ys: [...g.ys], zs: [...g.zs], cellPartRLE: rle(g.cellPart), parts: g.parts.map((p) => ({ id: p.id, material: p.material })) },
    apa: { iterations: m.timing.iterations, mg: { levels: m.timing.mg.levels, coarsened: m.timing.mg.coarsened }, Tmax_C: m.derived.Tmax_C.value } };
}
const out = { generator: 'packages/core/test/fixtures/gen-apa-grids.mjs', source: 'advanced-packaging-atlas engine/src/grid + thermal at fe39985 (read only)', node: process.version, generated: new Date().toISOString(), cases };
writeFileSync(fileURLToPath(new URL('./apa-grids.json', import.meta.url)), JSON.stringify(out) + '\n');
for (const [k, c] of Object.entries(cases)) console.log(k, c.grid.nx, c.grid.ny, c.grid.nz, JSON.stringify(c.apa));
