// Generated from packages/rt/src/render.ts by scripts/emit-browser.ts; do not edit.
// SPDX-License-Identifier: GPL-3.0-or-later
// Field renderer for the real-time kernels (browser). Reads the kernel's view buffer (f32 per cell) in the
// fragment shader, interpolates bilinearly between cell centres, maps through a 256-entry perceptual LUT,
// and composites the material overlay (u32 class per cell). y increases upwards on screen.

import { colormapRGBA,                   } from "./colormaps.js";

                                                   

export const RENDER_WGSL = `
struct R { nx: u32, ny: u32, style: u32, interp: u32, lo: f32, hi: f32, a0: f32, a1: f32 }
@group(0) @binding(0) var<uniform> r: R;
@group(0) @binding(1) var<storage, read> field: array<f32>;
@group(0) @binding(2) var<storage, read> ov: array<u32>;
@group(0) @binding(3) var<storage, read> lut: array<vec4f, 256>;

struct VO { @builtin(position) pos: vec4f, @location(0) uv: vec2f }
@vertex fn vs(@builtin(vertex_index) i: u32) -> VO {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var o: VO;
  o.pos = vec4f(p[i], 0.0, 1.0);
  o.uv = 0.5 * (p[i] + vec2f(1.0, 1.0));
  return o;
}
fn at(x: i32, y: i32) -> f32 {
  let xx = clamp(x, 0, i32(r.nx) - 1);
  let yy = clamp(y, 0, i32(r.ny) - 1);
  return field[u32(yy) * r.nx + u32(xx)];
}
fn color(v: f32) -> vec3f {
  let s = clamp((v - r.lo) / max(r.hi - r.lo, 1e-30), 0.0, 1.0);
  return lut[u32(round(s * 255.0))].rgb;
}
@fragment fn fs(i: VO) -> @location(0) vec4f {
  let gx = i.uv.x * f32(r.nx) - 0.5;
  let gy = i.uv.y * f32(r.ny) - 0.5;
  var v: f32;
  if (r.interp == 1u) {
    let x0 = i32(floor(gx)); let y0 = i32(floor(gy));
    let fx = gx - floor(gx); let fy = gy - floor(gy);
    v = mix(mix(at(x0, y0), at(x0 + 1, y0), fx), mix(at(x0, y0 + 1), at(x0 + 1, y0 + 1), fx), fy);
  } else {
    v = at(i32(round(gx)), i32(round(gy)));
  }
  var c = color(v);
  let cx = clamp(i32(round(gx)), 0, i32(r.nx) - 1);
  let cy = clamp(i32(round(gy)), 0, i32(r.ny) - 1);
  let k = ov[u32(cy) * r.nx + u32(cx)];
  if (r.style == 1u) {
    if (k == 1u) { c = vec3f(0.30, 0.31, 0.33); }          // channel wall
    else if (k == 2u) { c = vec3f(0.55, 0.56, 0.58); }     // obstacle
  } else if (r.style == 2u) {
    if (k == 1u) { c = vec3f(0.16, 0.17, 0.19); }          // PEC
    else if (k == 2u) { c = mix(c, vec3f(0.95, 0.80, 0.35), 0.28); }  // dielectric
    else if (k == 3u) { c = vec3f(0.98, 0.85, 0.20); }     // source
    else if (k == 4u) { c = mix(c, vec3f(0.05, 0.06, 0.07), 0.18); }  // CPML
  }
  return vec4f(c, 1.0);
}`;

export class FieldRenderer {
          device           ;
          ctx                  ;
          pipe                    ;
          ubuf           ;
          lut           ;
          bg                      = null;
          nx = 1;
          ny = 1;
          style = 0;
  smooth = true;
  lo = 0;
  hi = 1;

  constructor(device           , canvas                   ) {
    this.device = device;
    const ctx = canvas.getContext("webgpu");
    if (!ctx) throw new Error("canvas.getContext('webgpu') returned null");
    this.ctx = ctx;
    const format = navigator.gpu.getPreferredCanvasFormat();
    ctx.configure({ device, format, alphaMode: "opaque" });
    const module = device.createShaderModule({ code: RENDER_WGSL, label: "rt.render" });
    this.pipe = device.createRenderPipeline({
      layout: "auto",
      vertex: { module, entryPoint: "vs" },
      fragment: { module, entryPoint: "fs", targets: [{ format }] },
      primitive: { topology: "triangle-list" },
    });
    this.ubuf = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.lut = device.createBuffer({ size: 256 * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.setColormap("viridis");
  }

  setColormap(name              )       {
    const d = colormapRGBA(name);
    this.device.queue.writeBuffer(this.lut, 0, d.buffer, d.byteOffset, d.byteLength);
  }

  bind(field           , overlay           , nx        , ny        , style              )       {
    this.nx = nx;
    this.ny = ny;
    this.style = style === "lbm" ? 1 : style === "fdtd" ? 2 : 0;
    this.bg = this.device.createBindGroup({
      layout: this.pipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.ubuf } },
        { binding: 1, resource: { buffer: field } },
        { binding: 2, resource: { buffer: overlay } },
        { binding: 3, resource: { buffer: this.lut } },
      ],
    });
  }

  draw()       {
    if (!this.bg) return;
    const u = new ArrayBuffer(32);
    const ui = new Uint32Array(u);
    const uf = new Float32Array(u);
    ui[0] = this.nx;
    ui[1] = this.ny;
    ui[2] = this.style;
    ui[3] = this.smooth ? 1 : 0;
    uf[4] = this.lo;
    uf[5] = this.hi;
    this.device.queue.writeBuffer(this.ubuf, 0, u);
    const enc = this.device.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: this.ctx.getCurrentTexture().createView(), loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
    });
    pass.setPipeline(this.pipe);
    pass.setBindGroup(0, this.bg);
    pass.draw(3);
    pass.end();
    this.device.queue.submit([enc.finish()]);
  }
}
