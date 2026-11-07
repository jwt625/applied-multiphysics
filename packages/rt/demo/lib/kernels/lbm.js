// Generated from packages/rt/src/kernels/lbm.ts by scripts/emit-browser.ts; do not edit.
// SPDX-License-Identifier: GPL-3.0-or-later
// D2Q9 lattice Boltzmann, WebGPU. TRT (or BGK) collision, fused pull-stream-collide, halfway bounce-back on walls,
// Bouzidi linear interpolated bounce-back on obstacle links, Zou-He velocity inlet, non-equilibrium-extrapolation
// outlet at rho = 1, Guo forcing, momentum-exchange force computed in the step. DevLog-005.
// WGSL is generated with the 9 directions unrolled; the arithmetic mirrors cpu/lbm.ts line by line.

                                                                                                      
import { BufferSet, checkDevice, groups, guardDevice, pipeline, readF32, scoped, write } from "../gpu.js";
import { rasterize } from "../paint.js";
import { CX, CY, NO_LINK, OPP, W, lbmBoundary, lbmDerive, lbmInitial, lbmMask, lbmParams,                 } from "./lbm-common.js";

const f = (v        )         => {
  const s = String(v);
  return s.includes(".") || s.includes("e") ? s : s + ".0";
};

export function stepWGSL()         {
  const L           = [];
  L.push(`
struct P { nx: u32, ny: u32, periodicX: u32, inlet: u32,
           omegaP: f32, omegaM: f32, uMax: f32, H: f32,
           fx: f32, fy: f32, a0: f32, a1: f32 }
@group(0) @binding(0) var<uniform> prm: P;
@group(0) @binding(1) var<storage, read> gin: array<f32>;
@group(0) @binding(2) var<storage, read_write> gout: array<f32>;
@group(0) @binding(3) var<storage, read> mask: array<u32>;
@group(0) @binding(4) var<storage, read_write> mac: array<f32>;
@group(0) @binding(5) var<storage, read> lidx: array<u32>;
@group(0) @binding(6) var<storage, read> qb: array<f32>;
@group(0) @binding(7) var<storage, read_write> fcell: array<f32>;

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
  var sx: i32; var sy: i32; var sc: u32;
  var b = ${NO_LINK}u;
  var fxa = 0.0; var fya = 0.0;`);
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
  {
    let m = mask[sc];
    if (m == 0u) { g${i} = gin[${i}u * N + sc]; }
    else {
      let go = gin[${OPP[i]}u * N + c];
      if (m == 2u && lidx[c] != ${NO_LINK}u) {
        b = lidx[c];
        let q = qb[b * 8u + ${i - 1}u];
        var v = go;
        if (q < 0.5) {
          var fx2 = x + (${CX[i]});
          let fy2 = (y + (${CY[i]}) + ny) % ny;
          if (prm.periodicX == 1u) { fx2 = (fx2 + nx) % nx; }
          if (fx2 >= 0 && fx2 < nx) {
            let fc = u32(fy2 * nx + fx2);
            if (mask[fc] == 0u) { v = 2.0 * q * go + (1.0 - 2.0 * q) * gin[${OPP[i]}u * N + fc]; }
          }
        } else {
          v = go / (2.0 * q) + ((2.0 * q - 1.0) / (2.0 * q)) * gin[${i}u * N + c];
        }
        g${i} = v;
        fxa -= ${f(CX[i] )} * (go + v + ${f(2 * W[i] )});
        fya -= ${f(CY[i] )} * (go + v + ${f(2 * W[i] )});
      } else { g${i} = go; }
    }
  }`);
  }
  const sumRho = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => `g${i}`).join(" + ");
  const sumJx = [1, 5, 8].map((i) => `g${i}`).join(" + ") + " - (" + [3, 6, 7].map((i) => `g${i}`).join(" + ") + ")";
  const sumJy = [2, 5, 6].map((i) => `g${i}`).join(" + ") + " - (" + [4, 7, 8].map((i) => `g${i}`).join(" + ") + ")";
  // outlet unknowns 3, 6, 7 (see cpu/lbm.ts)
  const outlet           = [];
  for (const i of [3, 6, 7]) {
    outlet.push(`    sy = (y - (${CY[i]}) + ny) % ny;
    sc = u32(sy * nx + x);
    if (mask[sc] == 0u) {
      var r = 1.0; var jx = 0.0; var jy = 0.0;
${[0, 1, 2, 3, 4, 5, 6, 7, 8].map((k) => `      { let v = gin[${k}u * N + sc]; r += v; jx += ${f(CX[k] )} * v; jy += ${f(CY[k] )} * v; }`).join("\n")}
      let vx = jx / r; let vy = jy / r; let vv = vx * vx + vy * vy;
      let cv = ${f(CX[i] )} * vx + ${f(CY[i] )} * vy;
      g${i} = geq(${f(W[i] )}, cv, 1.0, vv) + gin[${i}u * N + sc] - geq(${f(W[i] )}, cv, r, vv);
    }`);
  }
  L.push(`  if (b != ${NO_LINK}u) { fcell[2u * b] = fxa; fcell[2u * b + 1u] = fya; }`);
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
    const o = OPP[i] ;
    const cu = (k        )         => `(${f(CX[k] )} * ux + ${f(CY[k] )} * uy)`;
    L.push(`  {
    let eqi = geq(${f(W[i] )}, ${cu(i)}, rho, u2);
    let eqo = geq(${f(W[o] )}, ${cu(o)}, rho, u2);
    let gs = 0.5 * (g${i} + g${o});
    let ga = 0.5 * (g${i} - g${o});
    let es = 0.5 * (eqi + eqo);
    let ea = 0.5 * (eqi - eqo);
    let cu = ${cu(i)};
    let cf = ${f(CX[i] )} * prm.fx + ${f(CY[i] )} * prm.fy;
    let sE = ${f(W[i] )} * (9.0 * cu * cf - 3.0 * uf);
    let sO = ${f(W[i] )} * 3.0 * cf;
    gout[${i}u * N + c] = g${i} - oP * (gs - es) - oM * (ga - ea) + (1.0 - 0.5 * oP) * sE + (1.0 - 0.5 * oM) * sO;
  }`);
  }
  L.push(`}`);
  return L.join("\n");
}

export const FORCE_WGSL = `
struct FP { nb: u32, a0: u32, a1: u32, a2: u32 }
@group(0) @binding(0) var<uniform> fp: FP;
@group(0) @binding(1) var<storage, read> fcell: array<f32>;
@group(0) @binding(2) var<storage, read_write> force: array<f32>;
var<workgroup> sx: array<f32, 256>;
var<workgroup> sy: array<f32, 256>;
@compute @workgroup_size(256)
fn main(@builtin(local_invocation_index) t: u32) {
  var ax = 0.0; var ay = 0.0;
  for (var l = t; l < fp.nb; l += 256u) {
    ax += fcell[2u * l];
    ay += fcell[2u * l + 1u];
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

const VIEWS             = [
  { id: "speed", label: "|u|", unit: "m/s", map: "viridis" },
  { id: "vorticity", label: "vorticity", unit: "1/s", map: "balance" },
  { id: "ux", label: "u_x", unit: "m/s", map: "balance" },
  { id: "uy", label: "u_y", unit: "m/s", map: "balance" },
];

export const RECORD_CAP = 1 << 16;

export class LbmD2Q9                              {
           id = "lbm-d2q9";
           fidelity = "realtime"         ;
  grid       = { nx: 0, ny: 0, dx: 1, lengthUnit: "m" };
  p                         = {};
  d             ;
  steps = 0;
          device            ;
          bufs            ;
          g              = [];
          mask            ;
          mac            ;
          prm            ;
          vprm            ;
          viewBuf            ;
          lidx            ;
          qb            ;
          fcell            ;
          bcap = 0;
          fprm            ;
          forceBuf            ;
          probeHist            ;
          forceHist            ;
          maskHost              ;
          pipe                     ;
          vpipe                     ;
          fpipe                     ;
          bg                 = [];
          fbg               ;
          vbg               ;
          cur = 0;
          viewMode = 0;
          record = false;
          nb = 0;
          probeCell = -1;
          disposed = true;

  async init(device           , params                        , grid      )                {
    if (this.bufs) this.dispose();
    this.device = device;
    guardDevice(device);
    this.grid = { lengthUnit: "m", ...grid };
    this.p = lbmParams(params);
    this.d = lbmDerive(this.p, grid);
    const { nx, ny } = grid;
    const N = nx * ny;
    this.steps = 0;
    this.cur = 0;
    await scoped(device, "lbm.init", () => {
      const b = (this.bufs = new BufferSet(device));
      this.g = [b.storage(9 * N * 4, "lbm.gA"), b.storage(9 * N * 4, "lbm.gB")];
      this.mask = b.storage(N * 4, "lbm.mask");
      this.mac = b.storage(3 * N * 4, "lbm.macro");
      this.viewBuf = b.storage(N * 4, "lbm.view");
      this.lidx = b.storage(N * 4, "lbm.lidx");
      this.prm = b.uniform(48, "lbm.params");
      this.vprm = b.uniform(32, "lbm.vparams");
      this.fprm = b.uniform(16, "lbm.fparams");
      this.forceBuf = b.storage(16, "lbm.force");
      this.probeHist = b.storage(RECORD_CAP * 4, "lbm.probeHist");
      this.forceHist = b.storage(RECORD_CAP * 8, "lbm.forceHist");
      this.maskHost = lbmMask(this.p, grid);
      write(device, this.mask, this.maskHost);
      write(device, this.g[0] , Float32Array.from(lbmInitial(this.p, grid, this.maskHost)));
      const mac0 = new Float32Array(3 * N);
      mac0.fill(1, 0, N);
      write(device, this.mac, mac0);
    });
    this.pipe = await pipeline(device, stepWGSL(), "lbm.step");
    this.vpipe = await pipeline(device, VIEW_WGSL, "lbm.view");
    this.fpipe = await pipeline(device, FORCE_WGSL, "lbm.force");
    this.disposed = false;
    this.uploadParams();
    await scoped(device, "lbm.boundary", () => this.uploadBoundary());
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

          live(where        )       {
    if (this.disposed) throw new Error(`lbm-d2q9.${where}: kernel not initialized or used after dispose()`);
    checkDevice(this.device, `lbm-d2q9.${where}`);
  }

          uploadParams()       {
    const u = new ArrayBuffer(48);
    const ui = new Uint32Array(u);
    const uf = new Float32Array(u);
    ui[0] = this.grid.nx;
    ui[1] = this.grid.ny;
    ui[2] = this.p.inlet === 1 ? 0 : 1;
    ui[3] = this.p.inlet === 1 ? 1 : 0;
    uf[4] = this.d.omegaP;
    uf[5] = this.d.omegaM;
    uf[6] = this.p.uMax ;
    uf[7] = this.d.H;
    uf[8] = this.p.forceX ;
    uf[9] = 0;
    write(this.device, this.prm, ui);
    this.record = this.p.probeX  >= 0 && this.p.probeY  >= 0;
    this.probeCell = this.record ? Math.round(this.p.probeY ) * this.grid.nx + Math.round(this.p.probeX ) : -1;
  }

  /** Rebuilds the obstacle boundary table (Bouzidi q per link); grows the GPU tables when needed (no truncation). */
          uploadBoundary()       {
    const bt = lbmBoundary(this.p, this.grid, this.maskHost);
    this.nb = bt.count;
    if (bt.count > this.bcap || !this.qb) {
      const cap = Math.max(1024, 2 * bt.count);
      if (this.qb) this.bufs.free(this.qb);
      if (this.fcell) this.bufs.free(this.fcell);
      this.qb = this.bufs.storage(cap * 8 * 4, "lbm.q");
      this.fcell = this.bufs.storage(cap * 2 * 4, "lbm.fcell");
      this.bcap = cap;
      this.makeBindGroups();
    }
    write(this.device, this.lidx, bt.lidx);
    if (bt.count > 0) write(this.device, this.qb, Float32Array.from(bt.q));
    write(this.device, this.fprm, new Uint32Array([bt.count, 0, 0, 0]));
  }

          makeBindGroups()       {
    const l0 = this.pipe.getBindGroupLayout(0);
    this.bg = [0, 1].map((k) =>
      this.device.createBindGroup({
        layout: l0,
        entries: [
          { binding: 0, resource: { buffer: this.prm } },
          { binding: 1, resource: { buffer: this.g[k]  } },
          { binding: 2, resource: { buffer: this.g[1 - k]  } },
          { binding: 3, resource: { buffer: this.mask } },
          { binding: 4, resource: { buffer: this.mac } },
          { binding: 5, resource: { buffer: this.lidx } },
          { binding: 6, resource: { buffer: this.qb } },
          { binding: 7, resource: { buffer: this.fcell } },
        ],
      }),
    );
    this.fbg = this.device.createBindGroup({
      layout: this.fpipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.fprm } },
        { binding: 1, resource: { buffer: this.fcell } },
        { binding: 2, resource: { buffer: this.forceBuf } },
      ],
    });
  }

  setParams(p                        )       {
    this.live("setParams");
    const next = lbmParams({ ...this.p, ...p });
    const geom = ["cylX", "cylY", "cylR", "walls", "inlet", "bouzidi"].filter((k) => k in p && p[k] !== this.p[k]);
    if (geom.length > 0) throw new Error(`lbm: ${geom.join(", ")} need init()`);
    this.p = next;
    this.d = lbmDerive(this.p, this.grid);
    this.uploadParams();
  }

  views()             {
    return VIEWS.map((v) => (this.p.Uref  > 0 ? v : { ...v, unit: v.id === "vorticity" ? "1/step" : "lattice" }));
  }

  setView(id        )       {
    const k = VIEWS.findIndex((v) => v.id === id);
    if (k < 0) throw new Error(`lbm: unknown view ${id}`);
    this.viewMode = k;
  }

  step(n        )       {
    this.live("step");
    const dev = this.device;
    const { nx, ny } = this.grid;
    const enc = dev.createCommandEncoder();
    if (!this.record) {
      const pass = enc.beginComputePass();
      pass.setPipeline(this.pipe);
      for (let s = 0; s < n; s++) {
        pass.setBindGroup(0, this.bg[this.cur] );
        pass.dispatchWorkgroups(groups(nx), groups(ny));
        this.cur ^= 1;
      }
      pass.end();
    } else {
      const N = nx * ny;
      for (let s = 0; s < n; s++) {
        const pass = enc.beginComputePass();
        pass.setPipeline(this.pipe);
        pass.setBindGroup(0, this.bg[this.cur] );
        pass.dispatchWorkgroups(groups(nx), groups(ny));
        this.cur ^= 1;
        pass.setPipeline(this.fpipe);
        pass.setBindGroup(0, this.fbg);
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

  view()             {
    this.live("view");
    const { nx, ny } = this.grid;
    const u = new ArrayBuffer(32);
    const ui = new Uint32Array(u);
    const uf = new Float32Array(u);
    ui[0] = nx;
    ui[1] = ny;
    ui[2] = this.viewMode;
    ui[3] = this.p.inlet === 1 ? 0 : 1;
    uf[4] = this.d.velScale;
    uf[5] = this.p.Uref  > 0 ? this.d.velScale / this.grid.dx : 1;
    write(this.device, this.vprm, ui);
    const enc = this.device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(this.vpipe);
    pass.setBindGroup(0, this.vbg);
    pass.dispatchWorkgroups(groups(nx), groups(ny));
    pass.end();
    this.device.queue.submit([enc.finish()]);
    const spec = this.views()[this.viewMode] ;
    const U = this.p.uMax  * this.d.velScale;
    const vort = (10 * this.d.uMean * (this.p.Uref  > 0 ? this.d.velScale / this.grid.dx : 1)) / this.p.L ;
    const range                   =
      this.viewMode === 0 ? [0, 1.5 * U] : this.viewMode === 1 ? [-vort, vort] : [-1.5 * U, 1.5 * U];
    return { buffer: this.viewBuf, unit: spec.unit, range };
  }

  overlay()            {
    this.live("overlay");
    return this.mask;
  }

  paint(op         )       {
    this.live("paint");
    const v = op.tool === "erase" ? 0 : 2;
    const { nx, ny } = this.grid;
    const rows = rasterize(op, nx, ny, (c, _i, j) => {
      if (this.p.walls === 1 && (j === 0 || j === ny - 1)) return;
      this.maskHost[c] = v;
    });
    if (!rows) return;
    const a = rows[0] * nx;
    const e = (rows[1] + 1) * nx;
    write(this.device, this.mask, this.maskHost.subarray(a, e), a * 4);
    this.uploadBoundary();
  }

  /** Names: g (current populations, deviation form), rho, ux, uy, view, mask, probe (uy history), force (Fx, Fy history). */
  async readback(name        )                        {
    this.live("readback");
    const N = this.grid.nx * this.grid.ny;
    await this.device.queue.onSubmittedWorkDone();
    let out              ;
    switch (name) {
      case "g":
        out = await readF32(this.device, this.g[this.cur] , 0, 9 * N * 4);
        break;
      case "rho":
        out = await readF32(this.device, this.mac, 0, N * 4);
        break;
      case "ux":
        out = await readF32(this.device, this.mac, N * 4, N * 4);
        break;
      case "uy":
        out = await readF32(this.device, this.mac, 2 * N * 4, N * 4);
        break;
      case "view":
        out = await readF32(this.device, this.viewBuf, 0, N * 4);
        break;
      case "mask":
        out = Float32Array.from(this.maskHost);
        break;
      case "probe":
        out = await readF32(this.device, this.probeHist, 0, RECORD_CAP * 4);
        break;
      case "force":
        out = await readF32(this.device, this.forceHist, 0, RECORD_CAP * 8);
        break;
      default:
        throw new Error(`lbm: unknown readback ${name}`);
    }
    this.live("readback");
    return out;
  }

  info()             {
    return { gpuBytes: this.bufs?.bytes ?? 0, cellsPerStep: this.grid.nx * this.grid.ny, steps: this.steps, boundaryCells: this.nb };
  }

  dispose()       {
    this.disposed = true;
    this.bufs?.destroy();
    this.qb = undefined                        ;
    this.fcell = undefined                        ;
    this.bcap = 0;
  }
}
