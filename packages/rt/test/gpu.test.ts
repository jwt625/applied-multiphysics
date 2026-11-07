// SPDX-License-Identifier: GPL-3.0-or-later
// WGSL kernels through Dawn (`webgpu` npm). Without an adapter these tests FAIL, unless AMP_RT_ALLOW_NO_GPU=1
// states that skipping is intended (audit S2).
import { test } from "node:test";
import assert from "node:assert/strict";
import { nodeGpu, nodeGpuError } from "../src/node-gpu.ts";
import * as G from "../src/gates.ts";
import { RENDER_WGSL } from "../src/render.ts";
import { GrayScott } from "../src/kernels/grayscott.ts";
import { pipeline } from "../src/gpu.ts";

const gpu = await nodeGpu();
const allowNoGpu = process.env.AMP_RT_ALLOW_NO_GPU === "1";
const skip = gpu ? false : allowNoGpu ? `no WebGPU adapter (${nodeGpuError()}); AMP_RT_ALLOW_NO_GPU=1` : false;
const dev = gpu?.device as GPUDevice;

test("WebGPU adapter available (set AMP_RT_ALLOW_NO_GPU=1 to skip on purpose)", { skip: allowNoGpu && !gpu ? "allowed" : false }, () => {
  assert.ok(gpu, `nodeGpu() failed: ${nodeGpuError()}`);
});

test("LBM GPU vs CPU incl. Bouzidi force (DFG D 10, 200 steps)", { skip }, async () => {
  const r = await G.lbmGpuVsCpu(dev);
  assert.equal(r.pass, 1, JSON.stringify(r));
});

test("LBM Strouhal DFG 2D-2 at D = 20 cells in 0.295-0.305", { skip }, async () => {
  const r = await G.strouhal(dev, 20);
  assert.equal(r.pass, true, `St ${r.St}`);
});

test("FDTD GPU vs CPU and Yee dispersion (f32)", { skip }, async () => {
  const r = await G.fdtdGpuVsCpu(dev);
  assert.equal(r.pass, 1, `ez_rel ${r.ez_rel}`);
  for (const d of await G.dispersion(dev, 40, 600)) assert.ok(d.pass, `${d.m},${d.n}: ${d.relErrVsYee}`);
});

test("Gray-Scott GPU vs f32 CPU after 1000 steps below 1e-4", { skip }, async () => {
  const rows = await G.gsGpuVsCpu(dev, [1000]);
  assert.equal(rows[0]!.pass, 1, JSON.stringify(rows[0]));
});

test("errors surface: bad WGSL throws; use after dispose() throws", { skip }, async () => {
  await assert.rejects(pipeline(dev, "@compute @workgroup_size(1) fn main() { let x: i32 = 1.5; }", "bad"), /bad:/);
  const k = new GrayScott();
  await k.init(dev, {}, { nx: 16, ny: 16, dx: 2 / 16 });
  k.dispose();
  assert.throws(() => k.step(1), /after dispose/);
  await assert.rejects(k.readback("v"), /after dispose/);
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
