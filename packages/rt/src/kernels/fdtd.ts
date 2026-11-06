// SPDX-License-Identifier: GPL-3.0-or-later
// 2D TMz FDTD with CPML, WebGPU. Two dispatches per step (H then E). Arithmetic mirrors cpu/fdtd.ts. DevLog-005.

import type { Grid, KernelInfo, KernelView, PaintOp, RealtimeKernelExt, ViewSpec } from "../types.ts";
import { BufferSet, groups, pipeline, readF32, write } from "../gpu.ts";
import { rasterize } from "../paint.ts";
import { fdtdDt, fdtdMaterials, fdtdParams, paintCell, pmlProfile, waveform, type FdtdMaterials } from "./fdtd-common.ts";

const COMMON = `
struct P { nx: u32, ny: u32, perX: u32, perY: u32, S: f32, a0: f32, a1: f32, a2: f32 }
struct SU { w: f32, a0: f32, a1: f32, a2: f32 }
@group(0) @binding(0) var<uniform> prm: P;
@group(0) @binding(1) var<uniform> su: SU;
@group(0) @binding(2) var<storage, read_write> F: array<f32>;    // ez | hx | hy
@group(0) @binding(3) var<storage, read_write> psi: array<f32>;  // ezx | ezy | hxy | hyx
@group(0) @binding(4) var<storage, read> mat: array<f32>;        // ca | cb | src
@group(0) @binding(5) var<storage, read> co: array<f32>;         // x: kE bE cE kH bH cH (nx each), then y (ny each)
fn cx(k: u32, i: u32) -> f32 { return co[k * prm.nx + i]; }
fn cy(k: u32, j: u32) -> f32 { return co[6u * prm.nx + k * prm.ny + j]; }
`;

export const FDTD_WGSL =
  COMMON +
  `
@compute @workgroup_size(16, 16)
fn hstep(@builtin(global_invocation_id) id: vec3u) {
  let nx = prm.nx; let ny = prm.ny;
  if (id.x >= nx || id.y >= ny) { return; }
  let N = nx * ny;
  let i = id.x; let j = id.y;
  let c = j * nx + i;
  var ezN = 0.0;
  if (j + 1u < ny) { ezN = F[c + nx]; } else if (prm.perY == 1u) { ezN = F[i]; }
  var ezE = 0.0;
  if (i + 1u < nx) { ezE = F[c + 1u]; } else if (prm.perX == 1u) { ezE = F[j * nx]; }
  let e = F[c];
  let dEy = ezN - e;
  let dEx = ezE - e;
  let a = cy(4u, j) * psi[2u * N + c] + cy(5u, j) * dEy;
  psi[2u * N + c] = a;
  F[N + c] = F[N + c] - prm.S * (dEy / cy(3u, j) + a);
  let b = cx(4u, i) * psi[3u * N + c] + cx(5u, i) * dEx;
  psi[3u * N + c] = b;
  F[2u * N + c] = F[2u * N + c] + prm.S * (dEx / cx(3u, i) + b);
}

@compute @workgroup_size(16, 16)
fn estep(@builtin(global_invocation_id) id: vec3u) {
  let nx = prm.nx; let ny = prm.ny;
  if (id.x >= nx || id.y >= ny) { return; }
  let N = nx * ny;
  let i = id.x; let j = id.y;
  let c = j * nx + i;
  var hyW = 0.0;
  if (i > 0u) { hyW = F[2u * N + c - 1u]; } else if (prm.perX == 1u) { hyW = F[2u * N + j * nx + nx - 1u]; }
  var hxS = 0.0;
  if (j > 0u) { hxS = F[N + c - nx]; } else if (prm.perY == 1u) { hxS = F[N + (ny - 1u) * nx + i]; }
  let dHy = F[2u * N + c] - hyW;
  let dHx = F[N + c] - hxS;
  let a = cx(1u, i) * psi[c] + cx(2u, i) * dHy;
  psi[c] = a;
  let b = cy(1u, j) * psi[N + c] + cy(2u, j) * dHx;
  psi[N + c] = b;
  F[c] = mat[c] * F[c] + mat[N + c] * (dHy / cx(0u, i) + a - dHx / cy(0u, j) - b) + mat[2u * N + c] * su.w;
}
`;

export const FDTD_VIEW_WGSL = `
struct VP { nx: u32, ny: u32, mode: u32, a0: u32 }
@group(0) @binding(0) var<uniform> vp: VP;
@group(0) @binding(1) var<storage, read> F: array<f32>;
@group(0) @binding(2) var<storage, read_write> outv: array<f32>;
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= vp.nx || id.y >= vp.ny) { return; }
  let N = vp.nx * vp.ny;
  let c = id.y * vp.nx + id.x;
  var v = F[c];
  if (vp.mode == 1u) {
    // |H| at the Ez node: average of the two neighbouring Hx and Hy samples (eta0 H, so the same scale as Ez)
    var hxs = F[N + c]; var hys = F[2u * N + c];
    if (id.y > 0u) { hxs = 0.5 * (hxs + F[N + c - vp.nx]); }
    if (id.x > 0u) { hys = 0.5 * (hys + F[2u * N + c - 1u]); }
    v = sqrt(hxs * hxs + hys * hys);
  } else if (vp.mode == 2u) { v = v * v; }
  outv[c] = v;
}`;

const VIEWS: ViewSpec[] = [
  { id: "ez", label: "E_z", unit: "a.u.", map: "balance" },
  { id: "h", label: "eta0 |H|", unit: "a.u.", map: "viridis" },
  { id: "ez2", label: "E_z^2", unit: "a.u.", map: "viridis" },
];

export const FDTD_RECORD_CAP = 1 << 16;
const BATCH = 256; // steps per submit (dynamic-offset uniform slots)
const SLOT = 256; // minUniformBufferOffsetAlignment upper bound

export class FdtdTMz implements RealtimeKernelExt {
  readonly id = "fdtd-tmz";
  readonly fidelity = "realtime" as const;
  grid: Grid = { nx: 0, ny: 0, dx: 1 };
  p: Record<string, number> = {};
  dt = 0;
  steps = 0;
  mat!: FdtdMaterials;
  private device!: GPUDevice;
  private bufs!: BufferSet;
  private F!: GPUBuffer;
  private psi!: GPUBuffer;
  private matBuf!: GPUBuffer;
  private co!: GPUBuffer;
  private prm!: GPUBuffer;
  private su!: GPUBuffer;
  private cls!: GPUBuffer;
  private viewBuf!: GPUBuffer;
  private vprm!: GPUBuffer;
  private hist!: GPUBuffer;
  private hpipe!: GPUComputePipeline;
  private epipe!: GPUComputePipeline;
  private vpipe!: GPUComputePipeline;
  private bg!: GPUBindGroup;
  private vbg!: GPUBindGroup;
  private viewMode = 0;
  private probeCell = -1;

  async init(device: GPUDevice, params: Record<string, number>, grid: Grid): Promise<void> {
    if (this.bufs) this.dispose();
    this.device = device;
    this.grid = { ...grid };
    this.p = fdtdParams(params);
    this.dt = fdtdDt(this.p, grid);
    this.steps = 0;
    const { nx, ny } = grid;
    const N = nx * ny;
    const b = (this.bufs = new BufferSet(device));
    this.F = b.storage(3 * N * 4, "fdtd.F");
    this.psi = b.storage(4 * N * 4, "fdtd.psi");
    this.matBuf = b.storage(3 * N * 4, "fdtd.mat");
    this.co = b.storage(6 * (nx + ny) * 4, "fdtd.coef");
    this.cls = b.storage(N * 4, "fdtd.cls");
    this.viewBuf = b.storage(N * 4, "fdtd.view");
    this.prm = b.uniform(32, "fdtd.params");
    this.su = b.uniform(BATCH * SLOT, "fdtd.stepU");
    this.vprm = b.uniform(16, "fdtd.vparams");
    this.hist = b.storage(FDTD_RECORD_CAP * 4, "fdtd.probeHist");
    this.mat = fdtdMaterials(this.p, grid);
    this.uploadMaterials(0, ny - 1);
    const px = pmlProfile(nx, this.p.bcX!, this.p);
    const py = pmlProfile(ny, this.p.bcY!, this.p);
    const co = new Float32Array(6 * (nx + ny));
    for (let k = 0; k < 6; k++) {
      co.set(px[k]!, k * nx);
      co.set(py[k]!, 6 * nx + k * ny);
    }
    write(device, this.co, co);
    this.uploadParams();

    const bgl = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform", hasDynamicOffset: true, minBindingSize: 16 } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      ],
    });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl] });
    this.hpipe = await pipeline(device, FDTD_WGSL, "fdtd.h", "hstep", layout);
    this.epipe = await pipeline(device, FDTD_WGSL, "fdtd.e", "estep", layout);
    this.vpipe = await pipeline(device, FDTD_VIEW_WGSL, "fdtd.view");
    this.bg = device.createBindGroup({
      layout: bgl,
      entries: [
        { binding: 0, resource: { buffer: this.prm } },
        { binding: 1, resource: { buffer: this.su, size: 16 } },
        { binding: 2, resource: { buffer: this.F } },
        { binding: 3, resource: { buffer: this.psi } },
        { binding: 4, resource: { buffer: this.matBuf } },
        { binding: 5, resource: { buffer: this.co } },
      ],
    });
    this.vbg = device.createBindGroup({
      layout: this.vpipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.vprm } },
        { binding: 1, resource: { buffer: this.F } },
        { binding: 2, resource: { buffer: this.viewBuf } },
      ],
    });
  }

  private uploadParams(): void {
    const u = new ArrayBuffer(32);
    const ui = new Uint32Array(u);
    const uf = new Float32Array(u);
    ui[0] = this.grid.nx;
    ui[1] = this.grid.ny;
    ui[2] = this.p.bcX === 2 ? 1 : 0;
    ui[3] = this.p.bcY === 2 ? 1 : 0;
    uf[4] = this.p.S!;
    write(this.device, this.prm, ui);
    this.probeCell =
      this.p.probeX! >= 0 ? Math.round(this.p.probeY!) * this.grid.nx + Math.round(this.p.probeX!) : -1;
  }

  private uploadMaterials(j0: number, j1: number): void {
    const { nx, ny } = this.grid;
    const N = nx * ny;
    const a = j0 * nx;
    const e = (j1 + 1) * nx;
    write(this.device, this.matBuf, Float32Array.from(this.mat.ca.subarray(a, e)), a * 4);
    write(this.device, this.matBuf, Float32Array.from(this.mat.cb.subarray(a, e)), (N + a) * 4);
    write(this.device, this.matBuf, Float32Array.from(this.mat.src.subarray(a, e)), (2 * N + a) * 4);
    write(this.device, this.cls, this.mat.cls.subarray(a, e), a * 4);
  }

  /** Source and probe parameters can change live; grid, BCs and CPML need init(). */
  setParams(p: Record<string, number>): void {
    const live = ["freq", "srcType", "srcAmp", "ramp", "probeX", "probeY"];
    for (const k of Object.keys(p)) if (!live.includes(k)) throw new Error(`fdtd: ${k} needs init()`);
    this.p = fdtdParams({ ...this.p, ...p });
    this.uploadParams();
  }

  views(): ViewSpec[] {
    return VIEWS;
  }

  setView(id: string): void {
    const k = VIEWS.findIndex((v) => v.id === id);
    if (k < 0) throw new Error(`fdtd: unknown view ${id}`);
    this.viewMode = k;
  }

  /** Overwrites a field (names ez, hx, hy) from host data, e.g. eigenmode initial conditions in the gates. */
  setField(name: "ez" | "hx" | "hy", data: ArrayLike<number>): void {
    const N = this.grid.nx * this.grid.ny;
    const off = { ez: 0, hx: N, hy: 2 * N }[name];
    write(this.device, this.F, Float32Array.from(data), off * 4);
  }

  step(n: number): void {
    const dev = this.device;
    const { nx, ny } = this.grid;
    let done = 0;
    while (done < n) {
      const m = Math.min(BATCH, n - done);
      const su = new Float32Array((m * SLOT) / 4);
      for (let s = 0; s < m; s++) su[(s * SLOT) / 4] = waveform(this.p, (this.steps + done + s) * this.dt);
      write(dev, this.su, su);
      const enc = dev.createCommandEncoder();
      const rec = this.probeCell >= 0;
      let pass = enc.beginComputePass();
      for (let s = 0; s < m; s++) {
        pass.setBindGroup(0, this.bg, [s * SLOT]);
        pass.setPipeline(this.hpipe);
        pass.dispatchWorkgroups(groups(nx), groups(ny));
        pass.setPipeline(this.epipe);
        pass.dispatchWorkgroups(groups(nx), groups(ny));
        if (rec) {
          pass.end();
          const slot = (this.steps + done + s) % FDTD_RECORD_CAP;
          enc.copyBufferToBuffer(this.F, this.probeCell * 4, this.hist, slot * 4, 4);
          pass = enc.beginComputePass();
        }
      }
      pass.end();
      dev.queue.submit([enc.finish()]);
      done += m;
    }
    this.steps += n;
  }

  view(): KernelView {
    const { nx, ny } = this.grid;
    write(this.device, this.vprm, new Uint32Array([nx, ny, this.viewMode, 0]));
    const enc = this.device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(this.vpipe);
    pass.setBindGroup(0, this.vbg);
    pass.dispatchWorkgroups(groups(nx), groups(ny));
    pass.end();
    this.device.queue.submit([enc.finish()]);
    const A = Math.abs(this.p.srcAmp!) || 1;
    const range: [number, number] = this.viewMode === 0 ? [-A, A] : [0, this.viewMode === 1 ? A : A * A];
    return { buffer: this.viewBuf, unit: VIEWS[this.viewMode]!.unit, range };
  }

  overlay(): GPUBuffer {
    return this.cls;
  }

  paint(op: PaintOp): void {
    const rows = rasterize(op, this.grid.nx, this.grid.ny, (c) => paintCell(this.mat, c, op.tool, op.value ?? 1));
    if (rows) this.uploadMaterials(rows[0], rows[1]);
  }

  /** Names: ez, hx, hy, view, probe (Ez history ring), cls. */
  async readback(name: string): Promise<Float32Array> {
    const N = this.grid.nx * this.grid.ny;
    await this.device.queue.onSubmittedWorkDone();
    switch (name) {
      case "ez":
        return readF32(this.device, this.F, 0, N * 4);
      case "hx":
        return readF32(this.device, this.F, N * 4, N * 4);
      case "hy":
        return readF32(this.device, this.F, 2 * N * 4, N * 4);
      case "view":
        return readF32(this.device, this.viewBuf, 0, N * 4);
      case "probe":
        return readF32(this.device, this.hist, 0, FDTD_RECORD_CAP * 4);
      case "cls":
        return Float32Array.from(this.mat.cls);
      default:
        throw new Error(`fdtd: unknown readback ${name}`);
    }
  }

  info(): KernelInfo {
    return { gpuBytes: this.bufs?.bytes ?? 0, cellsPerStep: this.grid.nx * this.grid.ny, steps: this.steps };
  }

  dispose(): void {
    this.bufs?.destroy();
  }
}
