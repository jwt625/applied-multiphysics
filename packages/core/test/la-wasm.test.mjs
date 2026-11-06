// Ported from advanced-packaging-atlas/engine/tests/la-wasm.test.mjs at fe39985 (GPL-3.0-or-later). Changes: the
// scalar thermal test uses the grid snapshot fixtures/apa-grids.json (dieLid, from APA buildGrid with the same parts)
// and helpers/grid-thermal.mjs instead of APA buildGrid + solveThermal; the JS / WASM paths are those of APA thermal
// makeSolver (buildMG, accelerateMG, mgPrecond, pcg with ref 'b'); assertions kept (accel kind, iterations within 1,
// relative T difference < 1e-12 on T in kelvin) and the JS iteration count is checked against APA's recorded value.
// Encoder and block tests: verbatim; import ../src/thermal/assemble.mjs -> ../src/fem/q1-grid.mjs.
// SPDX-License-Identifier: GPL-3.0-or-later
// Gate G1 (lane L1 wave 3): WASM kernels (in-repo encoder, no toolchain) give the same PCG iterations and the same
// answers (<= 1e-12 relative) as the JS path, scalar thermal and 3 x 3 block; JS fallback when unavailable.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { simdSupported, buildModule, Fn, F64, uleb, sleb } from '../src/la/wasm/encoder.mjs';
import { createStencil, padded } from '../src/la/stencil.mjs';
import { createBlockStencil, constrainBlock, paddedBlock, buildBlockMG, blockMGPrecond } from '../src/la/block.mjs';
import { accelerateBlockMG, accelerateMG } from '../src/la/wasm/accel.mjs';
import { buildMG, mgPrecond } from '../src/la/mg.mjs';
import { pcg } from '../src/la/pcg.mjs';
import { assembleConduction } from '../src/fem/q1-grid.mjs';
import { conductionSystem } from './helpers/grid-thermal.mjs';

const FX = JSON.parse(readFileSync(new URL('./fixtures/apa-grids.json', import.meta.url), 'utf8')).cases;

test('encoder: LEB128 and a valid module', () => {
  assert.deepEqual(uleb(624485), [0xe5, 0x8e, 0x26]);
  assert.deepEqual(sleb(-123456), [0xc0, 0xbb, 0x78]);
  const f = new Fn('two', [], [F64]);
  f.f64const(2);
  const inst = new WebAssembly.Instance(new WebAssembly.Module(buildModule([f])), { env: { memory: new WebAssembly.Memory({ initial: 1 }) } });
  assert.equal(inst.exports.two(), 2);
});

test('scalar thermal: accel wasm equals js (iterations, temperatures)', { skip: !simdSupported() && 'no WebAssembly SIMD' }, () => {
  const fx = FX.dieLid;
  const run = (wasm) => {
    const { op, b, x, grid, T_inf_C } = conductionSystem(fx);
    const mg = buildMG(op, grid.xs, grid.ys, { coarseMax: 500, ordering: 'nd' });
    if (wasm) accelerateMG(mg);
    const r = pcg(op, (rr, z) => mgPrecond(mg, rr, z), b, x, { rtol: 1e-12, maxIter: 1000, ref: 'b' });
    const T = new Float64Array(op.N).fill(NaN);
    for (let n = 0; n < op.N; n++) if (!op.fixed[n]) T[n] = x[op.pad + n] + T_inf_C + 273.15;
    return { T, iterations: r.iterations, accel: mg.accel?.kind ?? 'js' };
  };
  const a = run(false), b = run(true);
  assert.equal(b.accel, 'wasm_simd');
  assert.ok(Math.abs(a.iterations - b.iterations) <= 1);
  assert.equal(a.iterations, fx.apa.iterations);
  let e = 0;
  for (let n = 0; n < a.T.length; n++) if (!Number.isNaN(a.T[n])) e = Math.max(e, Math.abs(a.T[n] - b.T[n]) / a.T[n]);
  assert.ok(e < 1e-12, `${e}`);
});

test('block (3 DOF) MG: accel wasm equals js on a coupled vector operator', () => {
  const xs = Float64Array.from({ length: 13 }, (_, i) => 0.012 * (i / 12) ** 1.2), ys = Float64Array.from({ length: 11 }, (_, j) => 0.01 * j / 10);
  const zs = Float64Array.from([0, 2e-4, 4e-4, 4.5e-4, 5e-4, 7e-4, 9e-4]);
  const NX = 13, NY = 11, NZ = 7, N = NX * NY * NZ;
  const grid = { nx: 12, ny: 10, nz: 6, xs, ys, zs, cellPart: new Int32Array(12 * 10 * 6) };
  const kc = new Float64Array(3 * 720);
  for (let c = 0; c < 720; c++) kc.set(Math.floor(c / 120) === 2 ? [0.5, 0.5, 0.5] : [50, 50, 20], 3 * c);
  const sop = createStencil(NX, NY, NZ);
  assembleConduction(grid, kc, sop);
  const build = () => {
    const op = createBlockStencil(NX, NY, NZ);
    // block = scalar stencil x [[2, 0.5, 0], [0.5, 2, 0.5], [0, 0.5, 2]] (SPD coupling of the components)
    const B = [2, 0.5, 0, 0.5, 2, 0.5, 0, 0.5, 2];
    for (let n = 0; n < N; n++) for (let s = 0; s < 27; s++) for (let e = 0; e < 9; e++) op.A[(27 * n + s) * 9 + e] = sop.A[27 * n + s] * B[e];
    const F = new Float64Array(3 * N), g = new Float64Array(3 * N).fill(NaN);
    for (let n = 0; n < N; n++) { F[3 * n] = Math.sin(n); F[3 * n + 2] = Math.cos(0.3 * n); if (Math.floor(n / (NX * NY)) === 0) g[3 * n] = g[3 * n + 1] = g[3 * n + 2] = 0; }
    constrainBlock(op, F, g);
    const b = paddedBlock(op);
    b.set(F, 3 * op.pad);
    return { op, b };
  };
  const out = [];
  for (const acc of [false, true]) {
    const { op, b } = build();
    const mg = buildBlockMG(op, xs, ys, zs, { coarseMax: 200 });
    if (acc) assert.ok(accelerateBlockMG(mg));
    const x = paddedBlock(op);
    const r = pcg(op, (rr, zz) => blockMGPrecond(mg, rr, zz), b, x, { rtol: 1e-12 });
    out.push({ x, it: r.iterations });
  }
  assert.ok(Math.abs(out[0].it - out[1].it) <= 1, `${out[0].it} vs ${out[1].it}`);
  let e = 0, m = 0;
  for (let i = 0; i < out[0].x.length; i++) { e = Math.max(e, Math.abs(out[0].x[i] - out[1].x[i])); m = Math.max(m, Math.abs(out[0].x[i])); }
  assert.ok(e / m < 1e-12, `${e / m}`);
});
