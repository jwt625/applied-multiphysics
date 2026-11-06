// SPDX-License-Identifier: GPL-3.0-or-later
// D2Q9 lattice Boltzmann, WebGPU. TRT (or BGK) collision, fused pull-stream-collide, halfway bounce-back,
// Zou-He velocity inlet, non-equilibrium-extrapolation outlet at rho = 1, Guo forcing, momentum-exchange force. DevLog-005.
// WGSL is generated with the 9 directions unrolled; the arithmetic mirrors cpu/lbm.ts line by line.

import type { Grid, KernelInfo, KernelView, PaintOp, RealtimeKernelExt, ViewSpec } from "../types.ts";
import { BufferSet, groups, pipeline, readF32, write } from "../gpu.ts";
import { rasterize } from "../paint.ts";
import { CX, CY, OPP, W, lbmDerive, lbmInitial, lbmMask, lbmParams, type LbmDerived } from "./lbm-common.ts";

const f = (v: number): string => {
  const s = String(v);
  return s.includes(".") || s.includes("e") ? s : s + ".0";
};

export function stepWGSL(): string {
  const L: string[] = [];
  L.push(`
struct P { nx: u32, ny: u32, periodicX: u32, inlet: u32,
           omegaP: f32, omegaM: f32, uMax: f32, H: f32,
           fx: f32, fy: f32, a0: f32, a1: f32 }
@group(0) @binding(0) var<uniform> prm: P;
@group(0) @binding(1) var<storage, read> gin: array<f32>;
@group(0) @binding(2) var<storage, read_write> gout: array<f32>;
@group(0) @binding(3) var<storage, read> mask: array<u32>;
@group(0) @binding(4) var<storage, read_write> mac: array<f32>;

fn geq(w: f32, cu: f32, rho: f32, u2: f32) -> f32 {
  return w * (rho - 1.0 + rho * (3.0 * cu + 4.5 * cu * cu - 1.5 * u2));
}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= prm.nx || id.y >= prm.ny) { return; }
  let nx = i32(prm.nx);
  let ny = i32(prm.ny);
  let N = prm.nx * prm.ny;
  let x = i32(id.x);
  let y = i32(id.y);
  let c = id.y * prm.nx + id.x;
  if (mask[c] != 0u) {
${[0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => `    gout[${i}u * N + c] = 0.0;`).join("\n")}
    mac[c] = 1.0; mac[N + c] = 0.0; mac[2u * N + c] = 0.0;
    return;
  }
  var sx: i32; var sy: i32; var sc: u32;`);
  for (let i = 0; i < 9; i++) {
    L.push(`  var g${i}: f32;`);
    if (i === 0) {
      L.push(`  g0 = gin[c];`);
      continue;
    }
    L.push(`  sx = x - (${CX[i]}); sy = y - (${CY[i]});
  if (prm.periodicX == 1u) { sx = (sx + nx) % nx; } else { sx = clamp(sx, 0, nx - 1); }
  sy = (sy + ny) % ny;
  sc = u32(sy * nx + sx);
  if (mask[sc] != 0u) { g${i} = gin[${OPP[i]}u * N + c]; } else { g${i} = gin[${i}u * N + sc]; }`);
  }
  const sumRho = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => `g${i}`).join(" + ");
  const sumJx = [1, 5, 8].map((i) => `g${i}`).join(" + ") + " - (" + [3, 6, 7].map((i) => `g${i}`).join(" + ") + ")";
  const sumJy = [2, 5, 6].map((i) => `g${i}`).join(" + ") + " - (" + [4, 7, 8].map((i) => `g${i}`).join(" + ") + ")";
  // outlet unknowns 3, 6, 7 (see cpu/lbm.ts)
  const outlet: string[] = [];
  for (const i of [3, 6, 7]) {
    outlet.push(`    sy = (y - (${CY[i]}) + ny) % ny;
    sc = u32(sy * nx + x);
    if (mask[sc] == 0u) {
      var r = 1.0; var jx = 0.0; var jy = 0.0;
${[0, 1, 2, 3, 4, 5, 6, 7, 8].map((k) => `      { let v = gin[${k}u * N + sc]; r += v; jx += ${f(CX[k]!)} * v; jy += ${f(CY[k]!)} * v; }`).join("\n")}
      let vx = jx / r; let vy = jy / r; let vv = vx * vx + vy * vy;
      let cv = ${f(CX[i]!)} * vx + ${f(CY[i]!)} * vy;
      g${i} = geq(${f(W[i]!)}, cv, 1.0, vv) + gin[${i}u * N + sc] - geq(${f(W[i]!)}, cv, r, vv);
    }`);
  }
  L.push(`  if (prm.inlet == 1u && x == nx - 1) {
${outlet.join("\n")}
  }`);
  L.push(`
  var rho: f32; var ux: f32; var uy: f32;
  if (prm.inlet == 1u && x == 0) {
    let yy = f32(y) - 0.5;
    ux = 4.0 * prm.uMax * yy * (prm.H - yy) / (prm.H * prm.H);
    uy = 0.0;
    rho = (1.0 + g0 + g2 + g4 + 2.0 * (g3 + g6 + g7)) / (1.0 - ux);
    g1 = g3 + (2.0 / 3.0) * rho * ux;
    g5 = g7 - 0.5 * (g2 - g4) + (1.0 / 6.0) * rho * ux;
    g8 = g6 + 0.5 * (g2 - g4) + (1.0 / 6.0) * rho * ux;
  } else {
    rho = 1.0 + ${sumRho};
    let jx = ${sumJx};
    let jy = ${sumJy};
    ux = (jx + 0.5 * prm.fx) / rho;
    uy = (jy + 0.5 * prm.fy) / rho;
  }
  mac[c] = rho; mac[N + c] = ux; mac[2u * N + c] = uy;
  let u2 = ux * ux + uy * uy;
  let uf = ux * prm.fx + uy * prm.fy;
  let oP = prm.omegaP;
  let oM = prm.omegaM;`);
  for (let i = 0; i < 9; i++) {
    const o = OPP[i]!;
    const cu = (k: number): string => `(${f(CX[k]!)} * ux + ${f(CY[k]!)} * uy)`;
    L.push(`  {
    let eqi = geq(${f(W[i]!)}, ${cu(i)}, rho, u2);
    let eqo = geq(${f(W[o]!)}, ${cu(o)}, rho, u2);
    let gs = 0.5 * (g${i} + g${o});
    let ga = 0.5 * (g${i} - g${o});
    let es = 0.5 * (eqi + eqo);
    let ea = 0.5 * (eqi - eqo);
    let cu = ${cu(i)};
    let cf = ${f(CX[i]!)} * prm.fx + ${f(CY[i]!)} * prm.fy;
    let sE = ${f(W[i]!)} * (9.0 * cu * cf - 3.0 * uf);
    let sO = ${f(W[i]!)} * 3.0 * cf;
    gout[${i}u * N + c] = g${i} - oP * (gs - es) - oM * (ga - ea) + (1.0 - 0.5 * oP) * sE + (1.0 - 0.5 * oM) * sO;
  }`);
  }
  L.push(`}`);
  return L.join("\n");
}

export const FORCE_WGSL = `
struct FP { nLinks: u32, N: u32, a0: u32, a1: u32 }
@group(0) @binding(0) var<uniform> fp: FP;
@group(0) @binding(1) var<storage, read> g: array<f32>;
@group(0) @binding(2) var<storage, read> links: array<u32>;   // (cell << 4) | k
@group(0) @binding(3) var<storage, read_write> force: array<f32>;
var<workgroup> sx: array<f32, 256>;
var<workgroup> sy: array<f32, 256>;
const CX = array<f32, 9>(0.0, 1.0, 0.0, -1.0, 0.0, 1.0, -1.0, -1.0, 1.0);
const CY = array<f32, 9>(0.0, 0.0, 1.0, 0.0, -1.0, 1.0, 1.0, -1.0, -1.0);
const W = array<f32, 9>(${W.map(f).join(", ")});
@compute @workgroup_size(256)
fn main(@builtin(local_invocation_index) t: u32) {
  var ax = 0.0; var ay = 0.0;
  for (var l = t; l < fp.nLinks; l += 256u) {
    let e = links[l];
    let cell = e >> 4u;
    let k = e & 15u;
    let fk = g[k * fp.N + cell] + W[k];
    ax += 2.0 * fk * CX[k];
    ay += 2.0 * fk * CY[k];
  }
  sx[t] = ax; sy[t] = ay;
  workgroupBarrier();
  for (var s = 128u; s > 0u; s >>= 1u) {
    if (t < s) { sx[t] += sx[t + s]; sy[t] += sy[t + s]; }
    workgroupBarrier();
  }
  if (t == 0u) { force[0] = sx[0]; force[1] = sy[0]; }
}`;

export const VIEW_WGSL = `
struct VP { nx: u32, ny: u32, mode: u32, periodicX: u32, velScale: f32, vortScale: f32, a0: f32, a1: f32 }
@group(0) @binding(0) var<uniform> vp: VP;
@group(0) @binding(1) var<storage, read> mac: array<f32>;
@group(0) @binding(2) var<storage, read> mask: array<u32>;
@group(0) @binding(3) var<storage, read_write> outv: array<f32>;
fn idx(x: i32, y: i32) -> u32 {
  let nx = i32(vp.nx); let ny = i32(vp.ny);
  var xx = x; var yy = (y + ny) % ny;
  if (vp.periodicX == 1u) { xx = (x + nx) % nx; } else { xx = clamp(x, 0, nx - 1); }
  return u32(yy * nx + xx);
}
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= vp.nx || id.y >= vp.ny) { return; }
  let N = vp.nx * vp.ny;
  let x = i32(id.x); let y = i32(id.y);
  let c = id.y * vp.nx + id.x;
  var v = 0.0;
  if (mask[c] == 0u) {
    let ux = mac[N + c]; let uy = mac[2u * N + c];
    if (vp.mode == 0u) { v = sqrt(ux * ux + uy * uy) * vp.velScale; }
    else if (vp.mode == 1u) {
      let dvy = mac[2u * N + idx(x + 1, y)] - mac[2u * N + idx(x - 1, y)];
      let dux = mac[N + idx(x, y + 1)] - mac[N + idx(x, y - 1)];
      v = 0.5 * (dvy - dux) * vp.vortScale;
    }
    else if (vp.mode == 2u) { v = ux * vp.velScale; }
    else { v = uy * vp.velScale; }
  }
  outv[c] = v;
}`;

const VIEWS: ViewSpec[] = [
  { id: "speed", label: "|u|", unit: "m/s", map: "viridis" },
  { id: "vorticity", label: "vorticity", unit: "1/s", map: "balance" },
  { id: "ux", label: "u_x", unit: "m/s", map: "balance" },
  { id: "uy", label: "u_y", unit: "m/s", map: "balance" },
];

export const RECORD_CAP = 1 << 16;

export class LbmD2Q9 implements RealtimeKernelExt {
  readonly id = "lbm-d2q9";
  readonly fidelity = "realtime" as const;
  grid: Grid = { nx: 0, ny: 0, dx: 1 };
  p: Record<string, number> = {};
  d!: LbmDerived;
  steps = 0;
  private device!: GPUDevice;
  private bufs!: BufferSet;
  private g: GPUBuffer[] = [];
  private mask!: GPUBuffer;
  private mac!: GPUBuffer;
  private prm!: GPUBuffer;
  private vprm!: GPUBuffer;
  private viewBuf!: GPUBuffer;
  private links!: GPUBuffer;
  private fprm!: GPUBuffer;
  private forceBuf!: GPUBuffer;
  private probeHist!: GPUBuffer;
  private forceHist!: GPUBuffer;
  private maskHost!: Uint32Array;
  private pipe!: GPUComputePipeline;
  private vpipe!: GPUComputePipeline;
  private fpipe!: GPUComputePipeline;
  private bg: GPUBindGroup[] = [];
  private fbg: GPUBindGroup[] = [];
  private vbg!: GPUBindGroup;
  private cur = 0;
  private viewMode = 0;
  private record = false;
  private nLinks = 0;
  private probeCell = -1;

  async init(device: GPUDevice, params: Record<string, number>, grid: Grid): Promise<void> {
    if (this.bufs) this.dispose();
    this.device = device;
    this.grid = { ...grid };
    this.p = lbmParams(params);
    this.d = lbmDerive(this.p, grid);
    const { nx, ny } = grid;
    const N = nx * ny;
    this.steps = 0;
    this.cur = 0;
    const b = (this.bufs = new BufferSet(device));
    this.g = [b.storage(9 * N * 4, "lbm.gA"), b.storage(9 * N * 4, "lbm.gB")];
    this.mask = b.storage(N * 4, "lbm.mask");
    this.mac = b.storage(3 * N * 4, "lbm.macro");
    this.viewBuf = b.storage(N * 4, "lbm.view");
    this.prm = b.uniform(48, "lbm.params");
    this.vprm = b.uniform(32, "lbm.vparams");
    this.fprm = b.uniform(16, "lbm.fparams");
    this.forceBuf = b.storage(16, "lbm.force");
    this.probeHist = b.storage(RECORD_CAP * 4, "lbm.probeHist");
    this.forceHist = b.storage(RECORD_CAP * 8, "lbm.forceHist");
    this.maskHost = lbmMask(this.p, grid);
    this.links = b.storage(Math.max(16, 4 * nx * ny), "lbm.links");
    write(device, this.mask, this.maskHost);
    write(device, this.g[0]!, Float32Array.from(lbmInitial(this.p, grid, this.maskHost)));
    const mac0 = new Float32Array(3 * N);
    mac0.fill(1, 0, N);
    write(device, this.mac, mac0);
    this.uploadParams();
    this.rebuildLinks();

    this.pipe = await pipeline(device, stepWGSL(), "lbm.step");
    this.vpipe = await pipeline(device, VIEW_WGSL, "lbm.view");
    this.fpipe = await pipeline(device, FORCE_WGSL, "lbm.force");
    const l0 = this.pipe.getBindGroupLayout(0);
    this.bg = [0, 1].map((k) =>
      device.createBindGroup({
        layout: l0,
        entries: [
          { binding: 0, resource: { buffer: this.prm } },
          { binding: 1, resource: { buffer: this.g[k]! } },
          { binding: 2, resource: { buffer: this.g[1 - k]! } },
          { binding: 3, resource: { buffer: this.mask } },
          { binding: 4, resource: { buffer: this.mac } },
        ],
      }),
    );
    const lf = this.fpipe.getBindGroupLayout(0);
    this.fbg = [0, 1].map((k) =>
      device.createBindGroup({
        layout: lf,
        entries: [
          { binding: 0, resource: { buffer: this.fprm } },
          { binding: 1, resource: { buffer: this.g[k]! } },
          { binding: 2, resource: { buffer: this.links } },
          { binding: 3, resource: { buffer: this.forceBuf } },
        ],
      }),
    );
    this.vbg = device.createBindGroup({
      layout: this.vpipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.vprm } },
        { binding: 1, resource: { buffer: this.mac } },
        { binding: 2, resource: { buffer: this.mask } },
        { binding: 3, resource: { buffer: this.viewBuf } },
      ],
    });
  }

  private uploadParams(): void {
    const u = new ArrayBuffer(48);
    const ui = new Uint32Array(u);
    const uf = new Float32Array(u);
    ui[0] = this.grid.nx;
    ui[1] = this.grid.ny;
    ui[2] = this.p.inlet === 1 ? 0 : 1;
    ui[3] = this.p.inlet === 1 ? 1 : 0;
    uf[4] = this.d.omegaP;
    uf[5] = this.d.omegaM;
    uf[6] = this.p.uMax!;
    uf[7] = this.d.H;
    uf[8] = this.p.forceX!;
    uf[9] = 0;
    write(this.device, this.prm, ui);
    this.record = this.p.probeX! >= 0 && this.p.probeY! >= 0;
    this.probeCell = this.record ? Math.round(this.p.probeY!) * this.grid.nx + Math.round(this.p.probeX!) : -1;
  }

  private rebuildLinks(): void {
    const { nx, ny } = this.grid;
    const m = this.maskHost;
    const out: number[] = [];
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++) {
        const c = y * nx + x;
        if (m[c] !== 0) continue;
        for (let k = 1; k < 9; k++) {
          const tx = x + CX[k]!;
          const ty = (y + CY[k]! + ny) % ny;
          if (tx < 0 || tx >= nx) continue;
          if (m[ty * nx + tx] === 2) out.push(c * 16 + k);
        }
      }
    const cap = this.links.size / 4;
    if (out.length > cap) out.length = cap; // pathological painted geometry: force integral truncated
    this.nLinks = out.length;
    if (out.length > 0) write(this.device, this.links, Uint32Array.from(out));
    write(this.device, this.fprm, new Uint32Array([this.nLinks, nx * ny, 0, 0]));
  }

  setParams(p: Record<string, number>): void {
    this.p = lbmParams({ ...this.p, ...p });
    this.d = lbmDerive(this.p, this.grid);
    this.uploadParams();
  }

  views(): ViewSpec[] {
    return VIEWS.map((v) => (this.p.Uref! > 0 ? v : { ...v, unit: v.id === "vorticity" ? "1/step" : "lattice" }));
  }

  setView(id: string): void {
    const k = VIEWS.findIndex((v) => v.id === id);
    if (k < 0) throw new Error(`lbm: unknown view ${id}`);
    this.viewMode = k;
  }

  step(n: number): void {
    const dev = this.device;
    const { nx, ny } = this.grid;
    const enc = dev.createCommandEncoder();
    if (!this.record) {
      const pass = enc.beginComputePass();
      pass.setPipeline(this.pipe);
      for (let s = 0; s < n; s++) {
        pass.setBindGroup(0, this.bg[this.cur]!);
        pass.dispatchWorkgroups(groups(nx), groups(ny));
        this.cur ^= 1;
      }
      pass.end();
    } else {
      const N = nx * ny;
      for (let s = 0; s < n; s++) {
        const pass = enc.beginComputePass();
        pass.setPipeline(this.pipe);
        pass.setBindGroup(0, this.bg[this.cur]!);
        pass.dispatchWorkgroups(groups(nx), groups(ny));
        this.cur ^= 1;
        pass.setPipeline(this.fpipe);
        pass.setBindGroup(0, this.fbg[this.cur]!);
        pass.dispatchWorkgroups(1);
        pass.end();
        const slot = (this.steps + s) % RECORD_CAP;
        enc.copyBufferToBuffer(this.mac, (2 * N + this.probeCell) * 4, this.probeHist, slot * 4, 4);
        enc.copyBufferToBuffer(this.forceBuf, 0, this.forceHist, slot * 8, 8);
      }
    }
    dev.queue.submit([enc.finish()]);
    this.steps += n;
  }

  view(): KernelView {
    const { nx, ny } = this.grid;
    const u = new ArrayBuffer(32);
    const ui = new Uint32Array(u);
    const uf = new Float32Array(u);
    ui[0] = nx;
    ui[1] = ny;
    ui[2] = this.viewMode;
    ui[3] = this.p.inlet === 1 ? 0 : 1;
    uf[4] = this.d.velScale;
    uf[5] = this.p.Uref! > 0 ? this.d.velScale / this.grid.dx : 1;
    write(this.device, this.vprm, ui);
    const enc = this.device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(this.vpipe);
    pass.setBindGroup(0, this.vbg);
    pass.dispatchWorkgroups(groups(nx), groups(ny));
    pass.end();
    this.device.queue.submit([enc.finish()]);
    const spec = this.views()[this.viewMode]!;
    const U = this.p.uMax! * this.d.velScale;
    const vort = (10 * this.d.uMean * (this.p.Uref! > 0 ? this.d.velScale / this.grid.dx : 1)) / this.p.L!;
    const range: [number, number] =
      this.viewMode === 0 ? [0, 1.5 * U] : this.viewMode === 1 ? [-vort, vort] : [-1.5 * U, 1.5 * U];
    return { buffer: this.viewBuf, unit: spec.unit, range };
  }

  overlay(): GPUBuffer {
    return this.mask;
  }

  paint(op: PaintOp): void {
    const v = op.tool === "erase" ? 0 : 2;
    const { nx, ny } = this.grid;
    const rows = rasterize(op, nx, ny, (c, _i, j) => {
      if (this.p.walls === 1 && (j === 0 || j === ny - 1)) return;
      this.maskHost[c] = v;
    });
    if (!rows) return;
    const a = rows[0] * nx;
    const bnd = (rows[1] + 1) * nx;
    write(this.device, this.mask, this.maskHost.subarray(a, bnd), a * 4);
    this.rebuildLinks();
  }

  /** Names: g (current populations, deviation form), rho, ux, uy, view, mask, probe (uy history), force (Fx, Fy history). */
  async readback(name: string): Promise<Float32Array> {
    const N = this.grid.nx * this.grid.ny;
    await this.device.queue.onSubmittedWorkDone();
    switch (name) {
      case "g":
        return readF32(this.device, this.g[this.cur]!, 0, 9 * N * 4);
      case "rho":
        return readF32(this.device, this.mac, 0, N * 4);
      case "ux":
        return readF32(this.device, this.mac, N * 4, N * 4);
      case "uy":
        return readF32(this.device, this.mac, 2 * N * 4, N * 4);
      case "view":
        return readF32(this.device, this.viewBuf, 0, N * 4);
      case "mask":
        return Float32Array.from(this.maskHost);
      case "probe":
        return readF32(this.device, this.probeHist, 0, RECORD_CAP * 4);
      case "force":
        return readF32(this.device, this.forceHist, 0, RECORD_CAP * 8);
      default:
        throw new Error(`lbm: unknown readback ${name}`);
    }
  }

  info(): KernelInfo {
    return { gpuBytes: this.bufs?.bytes ?? 0, cellsPerStep: this.grid.nx * this.grid.ny, steps: this.steps };
  }

  dispose(): void {
    this.bufs?.destroy();
  }
}
