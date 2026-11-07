// Generated from packages/rt/src/kernels/grayscott.ts by scripts/emit-browser.ts; do not edit.
// SPDX-License-Identifier: GPL-3.0-or-later
// Gray-Scott reaction-diffusion, WebGPU. Explicit Euler, 5-point Laplacian, periodic, ping-pong buffers [u | v].
// Arithmetic order mirrors cpu/grayscott.ts. DevLog-005.

                                                                                                      
import { BufferSet, checkDevice, groups, guardDevice, pipeline, readF32, scoped, write } from "../gpu.js";
import { gsInitial, gsParams } from "./grayscott-common.js";

export const GS_WGSL = `
struct P { nx: u32, ny: u32, a0: u32, a1: u32, f: f32, k: f32, Du: f32, Dv: f32, dt: f32, inv: f32, fk: f32, a2: f32 }
@group(0) @binding(0) var<uniform> prm: P;
@group(0) @binding(1) var<storage, read> a: array<f32>;
@group(0) @binding(2) var<storage, read_write> b: array<f32>;
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let nx = prm.nx; let ny = prm.ny;
  if (id.x >= nx || id.y >= ny) { return; }
  let N = nx * ny;
  let i = id.x; let j = id.y;
  let jn = select(0u, j + 1u, j + 1u < ny);
  let js = select(ny - 1u, j - 1u, j > 0u);
  let ie = select(0u, i + 1u, i + 1u < nx);
  let iw = select(nx - 1u, i - 1u, i > 0u);
  let c = j * nx + i;
  let u = a[c];
  let v = a[N + c];
  let lu = ((((a[j * nx + ie] + a[j * nx + iw]) + a[jn * nx + i]) + a[js * nx + i]) - 4.0 * u) * prm.inv;
  let lv = ((((a[N + j * nx + ie] + a[N + j * nx + iw]) + a[N + jn * nx + i]) + a[N + js * nx + i]) - 4.0 * v) * prm.inv;
  let uvv = (u * v) * v;
  b[c] = u + prm.dt * (((prm.Du * lu) - uvv) + prm.f * (1.0 - u));
  b[N + c] = v + prm.dt * (((prm.Dv * lv) + uvv) - prm.fk * v);
}`;

export const GS_PAINT_WGSL = `
struct Q { nx: u32, ny: u32, a0: u32, a1: u32, cx: f32, cy: f32, r: f32, u: f32, v: f32, a2: f32, a3: f32, a4: f32 }
@group(0) @binding(0) var<uniform> q: Q;
@group(0) @binding(1) var<storage, read_write> b: array<f32>;
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= q.nx || id.y >= q.ny) { return; }
  let dx = f32(id.x) - q.cx; let dy = f32(id.y) - q.cy;
  if (dx * dx + dy * dy > q.r * q.r + 1e-6) { return; }
  let N = q.nx * q.ny;
  let c = id.y * q.nx + id.x;
  b[c] = q.u; b[N + c] = q.v;
}`;

const VIEWS             = [
  { id: "v", label: "v", unit: "1", map: "viridis" },
  { id: "u", label: "u", unit: "1", map: "viridis" },
];

export class GrayScott                              {
           id = "gray-scott";
           fidelity = "realtime"         ;
  grid       = { nx: 0, ny: 0, dx: 1, lengthUnit: "model" };
  p                         = {};
  steps = 0;
          disposed = true;
          device            ;
          bufs            ;
          uv              = [];
          prm            ;
          qprm            ;
          viewBuf            ;
          zeroOverlay            ;
          pipe                     ;
          ppipe                     ;
          bg                 = [];
          pbg                 = [];
          cur = 0;
          viewMode = 0;

  async init(device           , params                        , grid      )                {
    if (this.bufs) this.dispose();
    this.device = device;
    guardDevice(device);
    this.grid = { lengthUnit: "model", ...grid };
    this.p = gsParams(params);
    this.steps = 0;
    this.cur = 0;
    const N = grid.nx * grid.ny;
    await scoped(device, "gs.init", () => {
      const b = (this.bufs = new BufferSet(device));
      this.uv = [b.storage(2 * N * 4, "gs.A"), b.storage(2 * N * 4, "gs.B")];
      this.viewBuf = b.storage(N * 4, "gs.view");
      this.zeroOverlay = b.storage(N * 4, "gs.overlay");
      this.prm = b.uniform(48, "gs.params");
      this.qprm = b.uniform(48, "gs.paint");
      write(device, this.uv[0] , Float32Array.from(gsInitial(this.p, grid)));
      this.uploadParams();
    });
    this.pipe = await pipeline(device, GS_WGSL, "gs.step");
    this.ppipe = await pipeline(device, GS_PAINT_WGSL, "gs.paint");
    this.disposed = false;
    this.bg = [0, 1].map((k) =>
      device.createBindGroup({
        layout: this.pipe.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.prm } },
          { binding: 1, resource: { buffer: this.uv[k]  } },
          { binding: 2, resource: { buffer: this.uv[1 - k]  } },
        ],
      }),
    );
    this.pbg = [0, 1].map((k) =>
      device.createBindGroup({
        layout: this.ppipe.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.qprm } },
          { binding: 1, resource: { buffer: this.uv[k]  } },
        ],
      }),
    );
  }

          live(where        )       {
    if (this.disposed) throw new Error(`gray-scott.${where}: kernel not initialized or used after dispose()`);
    checkDevice(this.device, `gray-scott.${where}`);
  }

          uploadParams()       {
    const u = new ArrayBuffer(48);
    const ui = new Uint32Array(u);
    const uf = new Float32Array(u);
    ui[0] = this.grid.nx;
    ui[1] = this.grid.ny;
    uf[4] = this.p.f ;
    uf[5] = this.p.k ;
    uf[6] = this.p.Du ;
    uf[7] = this.p.Dv ;
    uf[8] = this.p.dt ;
    uf[9] = 1 / (this.grid.dx * this.grid.dx);
    uf[10] = Math.fround(Math.fround(this.p.f ) + Math.fround(this.p.k ));
    write(this.device, this.prm, ui);
  }

  setParams(p                        )       {
    this.live("setParams");
    this.p = gsParams({ ...this.p, ...p });
    this.uploadParams();
  }

  views()             {
    return VIEWS;
  }

  setView(id        )       {
    const k = VIEWS.findIndex((v) => v.id === id);
    if (k < 0) throw new Error(`gray-scott: unknown view ${id}`);
    this.viewMode = k;
  }

  step(n        )       {
    this.live("step");
    const enc = this.device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(this.pipe);
    for (let s = 0; s < n; s++) {
      pass.setBindGroup(0, this.bg[this.cur] );
      pass.dispatchWorkgroups(groups(this.grid.nx), groups(this.grid.ny));
      this.cur ^= 1;
    }
    pass.end();
    this.device.queue.submit([enc.finish()]);
    this.steps += n;
  }

  view()             {
    this.live("view");
    const N = this.grid.nx * this.grid.ny;
    const enc = this.device.createCommandEncoder();
    enc.copyBufferToBuffer(this.uv[this.cur] , this.viewMode === 0 ? N * 4 : 0, this.viewBuf, 0, N * 4);
    this.device.queue.submit([enc.finish()]);
    return { buffer: this.viewBuf, unit: "1", range: this.viewMode === 0 ? [0, 0.5] : [0, 1] };
  }

  overlay()            {
    this.live("overlay");
    return this.zeroOverlay;
  }

  /** Tools: seed (u 0.5, v 0.25) and erase (u 1, v 0); disc shape only. */
  paint(op         )       {
    this.live("paint");
    const [u, v] = op.tool === "erase" ? [1, 0] : [0.5, 0.25];
    const buf = new ArrayBuffer(48);
    const ui = new Uint32Array(buf);
    const uf = new Float32Array(buf);
    ui[0] = this.grid.nx;
    ui[1] = this.grid.ny;
    uf[4] = op.x0;
    uf[5] = op.y0;
    uf[6] = Math.max(0.5, op.r ?? 1);
    uf[7] = u;
    uf[8] = v;
    write(this.device, this.qprm, ui);
    const enc = this.device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(this.ppipe);
    pass.setBindGroup(0, this.pbg[this.cur] );
    pass.dispatchWorkgroups(groups(this.grid.nx), groups(this.grid.ny));
    pass.end();
    this.device.queue.submit([enc.finish()]);
  }

  /** Names: u, v, view. */
  async readback(name        )                        {
    this.live("readback");
    const N = this.grid.nx * this.grid.ny;
    await this.device.queue.onSubmittedWorkDone();
    let out              ;
    if (name === "u") out = await readF32(this.device, this.uv[this.cur] , 0, N * 4);
    else if (name === "v") out = await readF32(this.device, this.uv[this.cur] , N * 4, N * 4);
    else if (name === "view") out = await readF32(this.device, this.viewBuf, 0, N * 4);
    else throw new Error(`gray-scott: unknown readback ${name}`);
    this.live("readback");
    return out;
  }

  info()             {
    return { gpuBytes: this.bufs?.bytes ?? 0, cellsPerStep: this.grid.nx * this.grid.ny, steps: this.steps };
  }

  dispose()       {
    this.disposed = true;
    this.bufs?.destroy();
  }
}
