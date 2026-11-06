// SPDX-License-Identifier: GPL-3.0-or-later
// CPU-reference gates on small grids (no GPU needed). Thresholds from DevLog-005 section 3.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as G from "../src/gates.ts";
import { rasterize } from "../src/paint.ts";
import { lbmParams } from "../src/kernels/lbm-common.ts";
import { fdtdParams } from "../src/kernels/fdtd-common.ts";
import { patternClass } from "../src/analysis.ts";

test("LBM Poiseuille: BGK second order, TRT (Lambda 3/16) exact in f64", async () => {
  const rows = await G.poiseuille(null, [8, 16]);
  const bgk = rows.filter((r) => r.collision === "BGK");
  const trt = rows.filter((r) => r.collision === "TRT");
  assert.ok(Math.abs(bgk[1]!.order! - 2) < 0.05, `BGK order ${bgk[1]!.order}`);
  for (const r of trt) assert.ok(r.L2 < 1e-12, `TRT L2 ${r.L2}`);
});

test("FDTD dispersion (CPU f64) matches the Yee relation", async () => {
  const rows = await G.dispersion(null, 40, 600);
  for (const r of rows) assert.ok(Math.abs(r.relErrVsYee) < 1e-9, `${r.m},${r.n}: ${r.relErrVsYee}`);
});

test("FDTD CPML normal-incidence reflection below -40 dB (10 cells)", async () => {
  const r = await G.cpmlReflection(null, 10);
  assert.ok(r.dB < -40, `${r.dB} dB`);
});

test("FDTD PEC cavity TM11 within 1 % at N = 16", async () => {
  const [r] = await G.cavity(null, [16], 60);
  assert.ok(Math.abs(r!.relErrVsAnalytic) < 0.01, String(r!.relErrVsAnalytic));
});

test("Gray-Scott pattern class (CPU, 64^2 at The Well spacing, 3000 steps)", async () => {
  const rows = await G.gsPattern(null, ["spots", "maze"], 3000, 64);
  for (const r of rows) assert.equal(r.cls, r.expected, `${r.set}: ${JSON.stringify(r)}`);
});

test("pattern classifier on synthetic fields", () => {
  const n = 64;
  const spots = new Float64Array(n * n);
  const stripes = new Float64Array(n * n);
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      spots[j * n + i] = (i % 8) - 4 < 2 && (i % 8) - 4 >= -2 && (j % 8) - 4 < 2 && (j % 8) - 4 >= -2 ? 1 : 0;
      stripes[j * n + i] = i % 8 < 4 ? 1 : 0;
    }
  assert.equal(patternClass(spots, n, n).cls, "spots");
  assert.equal(patternClass(stripes, n, n).cls, "stripes/maze");
});

test("rasterize and parameter validation", () => {
  let n = 0;
  rasterize({ tool: "x", shape: "disc", x0: 10, y0: 10, r: 2 }, 32, 32, () => n++);
  assert.equal(n, 13);
  assert.throws(() => lbmParams({ nope: 1 }));
  assert.throws(() => fdtdParams({ S: 0.8 }));
});
