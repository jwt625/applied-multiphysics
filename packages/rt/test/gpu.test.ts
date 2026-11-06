// SPDX-License-Identifier: GPL-3.0-or-later
// WGSL kernels through Dawn (`webgpu` npm). Skipped when no adapter is available.
import { test } from "node:test";
import assert from "node:assert/strict";
import { nodeGpu } from "../src/node-gpu.ts";
import * as G from "../src/gates.ts";
import { RENDER_WGSL } from "../src/render.ts";

const gpu = await nodeGpu();
const skip = gpu ? false : "no WebGPU adapter (Dawn)";
const dev = gpu?.device as GPUDevice;

test("LBM GPU vs CPU (DFG D 10, 200 steps)", { skip }, async () => {
  const r = await G.lbmGpuVsCpu(dev);
  for (const k of ["ux_rel", "uy_rel", "rho_rel"]) assert.ok(r[k]! < 1e-4, `${k} ${r[k]}`);
});

test("LBM Strouhal DFG 2D-2 at D = 10 cells in 0.295-0.305", { skip }, async () => {
  const r = await G.strouhal(dev, 10);
  assert.ok(r.pass, `St ${r.St}`);
});

test("FDTD GPU vs CPU and Yee dispersion (f32)", { skip }, async () => {
  const r = await G.fdtdGpuVsCpu(dev);
  assert.ok(r.ez_rel! < 1e-5, `ez_rel ${r.ez_rel}`);
  for (const d of await G.dispersion(dev, 40, 600)) assert.ok(Math.abs(d.relErrVsYee) < 1e-4, `${d.m},${d.n}: ${d.relErrVsYee}`);
});

test("Gray-Scott GPU vs f32 CPU after 1000 steps below 1e-4", { skip }, async () => {
  const rows = await G.gsGpuVsCpu(dev, [1000]);
  assert.ok(rows[0]!.u_vs_f32! < 1e-4 && rows[0]!.v_vs_f32! < 1e-4, JSON.stringify(rows[0]));
});

test("render shader compiles", { skip }, async () => {
  dev.pushErrorScope("validation");
  const module = dev.createShaderModule({ code: RENDER_WGSL });
  dev.createRenderPipeline({
    layout: "auto",
    vertex: { module, entryPoint: "vs" },
    fragment: { module, entryPoint: "fs", targets: [{ format: "bgra8unorm" }] },
  });
  const err = await dev.popErrorScope();
  assert.equal(err, null, err?.message);
});
