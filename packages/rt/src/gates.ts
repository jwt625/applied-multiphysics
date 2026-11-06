// SPDX-License-Identifier: GPL-3.0-or-later
// Eval gates for the real-time tier (DevLog-005 section 3). Device-agnostic: pass a GPUDevice (browser or Dawn)
// or null for the CPU reference. Gate definitions were fixed in DevLog-005 before the first run.

import { LbmCpu } from "./cpu/lbm.ts";
import { FdtdCpu } from "./cpu/fdtd.ts";
import { GrayScottCpu } from "./cpu/grayscott.ts";
import { LbmD2Q9, RECORD_CAP } from "./kernels/lbm.ts";
import { FdtdTMz, FDTD_RECORD_CAP } from "./kernels/fdtd.ts";
import { GrayScott } from "./kernels/grayscott.ts";
import { dfgGrid, lbmDerive, lbmParams } from "./kernels/lbm-common.ts";
import { C0, yeeOmega } from "./kernels/fdtd-common.ts";
import { WELL_FK } from "./kernels/grayscott-common.ts";
import { meanPeriod, patternClass, recurrenceTheta, spectralPeak, type PatternStats } from "./analysis.ts";

const maxAbsDiff = (a: ArrayLike<number>, b: ArrayLike<number>, off = 0): number => {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i]! - b[off + i]!));
  return m;
};
const maxAbs = (a: ArrayLike<number>): number => {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i]!));
  return m;
};

// ---------------------------------------------------------------- LBM

export interface PoiseuilleRow {
  backend: "cpu" | "gpu";
  collision: "BGK" | "TRT";
  H: number;
  tau: number;
  steps: number;
  L2: number;
  order?: number;
}

/** Gate 1: body-force Poiseuille, periodic x, halfway bounce-back walls. Steady state after 10 H^2 / nu steps. */
export async function poiseuille(device: GPUDevice | null, Hs = [8, 16, 32, 64], tau = 0.8): Promise<PoiseuilleRow[]> {
  const rows: PoiseuilleRow[] = [];
  for (const coll of [0, 1]) {
    for (const H of Hs) {
      const nx = 2;
      const ny = H + 2;
      const nu = (tau - 0.5) / 3;
      const umax = 0.01;
      const F = (8 * nu * umax) / (H * H);
      const params = { inlet: 0, walls: 1, tau, collision: coll, forceX: F };
      const grid = { nx, ny, dx: 1 };
      const steps = Math.ceil((10 * H * H) / nu);
      let ux: ArrayLike<number>;
      if (device) {
        const k = new LbmD2Q9();
        await k.init(device, params, grid);
        for (let s = 0; s < steps; s += 4096) k.step(Math.min(4096, steps - s));
        ux = await k.readback("ux");
        k.dispose();
      } else {
        const c = new LbmCpu(params, grid);
        c.step(steps);
        ux = c.ux;
      }
      let e2 = 0;
      let a2 = 0;
      for (let j = 1; j <= H; j++) {
        const y = j - 0.5;
        const ua = (F / (2 * nu)) * y * (H - y);
        e2 += (ux[j * nx]! - ua) ** 2;
        a2 += ua * ua;
      }
      rows.push({ backend: device ? "gpu" : "cpu", collision: coll ? "TRT" : "BGK", H, tau, steps, L2: Math.sqrt(e2 / a2) });
    }
  }
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1]!;
    const b = rows[i]!;
    if (a.collision === b.collision && b.H === 2 * a.H) b.order = Math.log2(a.L2 / b.L2);
  }
  return rows;
}

export interface ChannelResult {
  backend: "cpu" | "gpu";
  H: number;
  nx: number;
  tau: number;
  uMax: number;
  steps: number;
  station: number;
  /** L2 of u_x(y) vs the inlet parabola (includes the weak-compressibility amplitude change rho_in / rho) */
  L2: number;
  /** L2 of the shape: u_x / mean(u_x) vs parabola / mean(parabola) */
  L2shape: number;
  /** mean rho at the station minus mean rho at the inlet */
  dRho: number;
}

/** Gate 1b: velocity inlet + rho = 1 outlet channel (the BCs of the cylinder case), profile at mid-length. */
export async function channelPoiseuille(device: GPUDevice | null, H = 32, nx = 8 * 32 + 1, tau = 0.8, uMax = 0.05): Promise<ChannelResult> {
  const grid = { nx, ny: H + 2, dx: 1 };
  const params = { inlet: 1, walls: 1, tau, uMax, collision: 1 };
  const nu = (tau - 0.5) / 3;
  const steps = Math.ceil((10 * H * H) / nu + (4 * nx) / uMax);
  let ux: ArrayLike<number>;
  let rho: ArrayLike<number>;
  if (device) {
    const k = new LbmD2Q9();
    await k.init(device, params, grid);
    for (let s = 0; s < steps; s += 4096) k.step(Math.min(4096, steps - s));
    ux = await k.readback("ux");
    rho = await k.readback("rho");
    k.dispose();
  } else {
    const c = new LbmCpu(params, grid);
    c.step(steps);
    ux = c.ux;
    rho = c.rho;
  }
  const x = (nx - 1) >> 1;
  let e2 = 0;
  let a2 = 0;
  let su = 0;
  let sa = 0;
  let r0 = 0;
  let rx = 0;
  const ua: number[] = [];
  for (let j = 1; j <= H; j++) {
    const y = j - 0.5;
    ua.push((4 * uMax * y * (H - y)) / (H * H));
    su += ux[j * nx + x]!;
    sa += ua[j - 1]!;
    r0 += rho[j * nx]! / H;
    rx += rho[j * nx + x]! / H;
  }
  let s2 = 0;
  let b2 = 0;
  for (let j = 1; j <= H; j++) {
    const u = ux[j * nx + x]!;
    const a = ua[j - 1]!;
    e2 += (u - a) ** 2;
    a2 += a * a;
    s2 += (u / su - a / sa) ** 2;
    b2 += (a / sa) ** 2;
  }
  return {
    backend: device ? "gpu" : "cpu", H, nx, tau, uMax, steps, station: x,
    L2: Math.sqrt(e2 / a2), L2shape: Math.sqrt(s2 / b2), dRho: rx - r0,
  };
}

export interface StrouhalResult {
  nD: number;
  nx: number;
  ny: number;
  uMax: number;
  mach: number;
  tau: number;
  collision: "BGK" | "TRT";
  tEnd_s: number;
  steps: number;
  St: number;
  StPrevWindow: number;
  cDmax: number;
  cLmax: number;
  pass: boolean;
  wall_s: number;
}

/** Gate 2: DFG 2D-2 at Re 100 (GPU only). St from upward zero crossings of c_L over the last 10 periods. */
export async function strouhal(device: GPUDevice, nD: number, opts: { uMax?: number; collision?: number; tEnd?: number } = {}): Promise<StrouhalResult> {
  const uMax = opts.uMax ?? 0.1;
  const collision = opts.collision ?? 1;
  const tEnd = opts.tEnd ?? 12;
  const { grid, params } = dfgGrid(nD);
  const p = { ...params, Re: 100, uMax, collision };
  const d = lbmDerive(lbmParams(p), grid);
  const k = new LbmD2Q9();
  await k.init(device, p, grid);
  const steps = Math.ceil(tEnd / d.dt);
  const cl = new Float64Array(steps);
  const cd = new Float64Array(steps);
  const norm = 0.5 * d.uMean * d.uMean * nD;
  const chunk = 8192;
  const t0 = performance.now();
  for (let s = 0; s < steps; s += chunk) {
    const n = Math.min(chunk, steps - s);
    for (let q = 0; q < n; q += 256) k.step(Math.min(256, n - q));
    const fh = await k.readback("force");
    for (let q = 0; q < n; q++) {
      const slot = (s + q) % RECORD_CAP;
      cd[s + q] = fh[2 * slot]! / norm;
      cl[s + q] = fh[2 * slot + 1]! / norm;
    }
    if (!Number.isFinite(cd[s + n - 1]!)) throw new Error(`lbm diverged at step ${s + n}`);
  }
  const wall = (performance.now() - t0) / 1000;
  k.dispose();
  const P = 10;
  const T = meanPeriod(cl, Math.floor(steps / 2), steps, P);
  const T2 = meanPeriod(cl, Math.floor(steps / 3), Math.floor(steps - P * T), P);
  const St = nD / T / d.uMean;
  let cDmax = -Infinity;
  let cLmax = -Infinity;
  for (let i = Math.floor(steps - P * T); i < steps; i++) {
    cDmax = Math.max(cDmax, cd[i]!);
    cLmax = Math.max(cLmax, cl[i]!);
  }
  return {
    nD, nx: grid.nx, ny: grid.ny, uMax, mach: d.mach, tau: d.tau, collision: collision ? "TRT" : "BGK",
    tEnd_s: tEnd, steps, St, StPrevWindow: nD / T2 / d.uMean, cDmax, cLmax,
    pass: St >= 0.295 && St <= 0.305, wall_s: wall,
  };
}

/** Gate 8 (LBM): GPU vs CPU on DFG nD = 10 after n steps; max abs difference / max |field|. */
export async function lbmGpuVsCpu(device: GPUDevice, n = 200): Promise<Record<string, number>> {
  const { grid, params } = dfgGrid(10);
  const k = new LbmD2Q9();
  await k.init(device, params, grid);
  const c = new LbmCpu(params, grid);
  k.step(n);
  c.step(n);
  const out: Record<string, number> = { steps: n, cells: grid.nx * grid.ny };
  for (const name of ["ux", "uy", "rho"] as const) {
    const g = await k.readback(name);
    out[`${name}_maxAbsDiff`] = maxAbsDiff(g, c[name]);
    out[`${name}_rel`] = out[`${name}_maxAbsDiff`]! / maxAbs(c[name]);
  }
  k.dispose();
  return out;
}

// ---------------------------------------------------------------- FDTD

export interface DispersionRow {
  backend: "cpu" | "gpu";
  m: number;
  n: number;
  angle_deg: number;
  ppw: number;
  relErrVsYee: number;
  yeeVsContinuum: number;
}

/** Gate 3: periodic standing-wave eigenmode; temporal frequency vs the analytic Yee dispersion relation. */
export async function dispersion(device: GPUDevice | null, N = 80, steps = 2000, S = 0.5): Promise<DispersionRow[]> {
  const dx = 1e-3;
  const modes: Array<[number, number]> = [
    [2, 0], [4, 0], [8, 0], [16, 0],
    [1, 1], [3, 3], [6, 6], [11, 11],
    [2, 1], [4, 2], [8, 4],
  ];
  const rows: DispersionRow[] = [];
  for (const [m, n] of modes) {
    const kx = (2 * Math.PI * m) / (N * dx);
    const ky = (2 * Math.PI * n) / (N * dx);
    const ez = new Float64Array(N * N);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) ez[j * N + i] = Math.cos(kx * i * dx + ky * j * dx);
    const params = { bcX: 2, bcY: 2, S, probeX: 0, probeY: 0 };
    const grid = { nx: N, ny: N, dx };
    let series: ArrayLike<number>;
    let dt: number;
    if (device) {
      const k = new FdtdTMz();
      await k.init(device, params, grid);
      k.setField("ez", ez);
      k.step(steps);
      series = (await k.readback("probe")).subarray(0, steps);
      dt = k.dt;
      k.dispose();
    } else {
      const c = new FdtdCpu(params, grid);
      c.ez.set(ez);
      c.step(steps);
      series = c.probe;
      dt = c.dt;
    }
    const w = recurrenceTheta(series) / dt;
    const wy = yeeOmega(kx, ky, dx, S);
    const wc = C0 * Math.hypot(kx, ky);
    rows.push({
      backend: device ? "gpu" : "cpu", m, n, angle_deg: (Math.atan2(n, m) * 180) / Math.PI,
      ppw: N / Math.hypot(m, n), relErrVsYee: (w - wy) / wy, yeeVsContinuum: (wy - wc) / wc,
    });
  }
  return rows;
}

export interface CpmlResult {
  backend: "cpu" | "gpu";
  pml: number;
  m: number;
  reflection: number;
  dB: number;
  steps: number;
  ppwAtPeak: number;
}

/** Gate 4: normal-incidence CPML reflection with a Ricker plane wave (periodic y), test vs extended-domain reference. */
export async function cpmlReflection(device: GPUDevice | null, pml: number, m = 3, steps = 3000): Promise<CpmlResult> {
  const dx = 1e-3;
  const freq = 10e9; // Ricker peak, 30 cells per wavelength at dx = 1 mm
  const iS = pml + 20;
  const iP = iS + 40;
  const nx = iP + 11 + pml;
  const nxRef = nx + 2000;
  const ny = 4;
  const run = async (n: number): Promise<ArrayLike<number>> => {
    const params = { bcX: 1, bcY: 2, pml, pmlM: m, srcType: 1, freq, srcX: iS, srcLine: 1, probeX: iP, probeY: 1 };
    const grid = { nx: n, ny, dx };
    if (device) {
      const k = new FdtdTMz();
      await k.init(device, params, grid);
      k.step(steps);
      const r = (await k.readback("probe")).slice(0, steps);
      k.dispose();
      return r;
    }
    const c = new FdtdCpu(params, grid);
    c.step(steps);
    return c.probe;
  };
  const a = await run(nx);
  const b = await run(nxRef);
  let d = 0;
  let ref = 0;
  for (let t = 0; t < steps; t++) {
    d = Math.max(d, Math.abs(a[t]! - b[t]!));
    ref = Math.max(ref, Math.abs(b[t]!));
  }
  const R = d / ref;
  return { backend: device ? "gpu" : "cpu", pml, m, reflection: R, dB: 20 * Math.log10(R), steps, ppwAtPeak: C0 / freq / dx };
}

export interface CavityRow {
  backend: "cpu" | "gpu";
  N: number;
  f_num_Hz: number;
  f_analytic_Hz: number;
  f_yee_Hz: number;
  relErrVsAnalytic: number;
  relErrVsYee: number;
  steps: number;
  order?: number;
}

/** Gate 5: PEC square cavity, side a = N dx; TM11 from the Hann-windowed spectrum of a Ricker-excited ringdown. */
export async function cavity(device: GPUDevice | null, Ns = [16, 32, 64], periods = 150): Promise<CavityRow[]> {
  const a = 0.1; // m
  const rows: CavityRow[] = [];
  const S = 0.5;
  const fA = C0 / (Math.SQRT2 * a);
  for (const N of Ns) {
    const dx = a / N;
    const dt = (S * dx) / C0;
    const steps = Math.min(FDTD_RECORD_CAP, Math.ceil(periods / (fA * dt)));
    const params = {
      bcX: 0, bcY: 0, S, srcType: 1, freq: fA,
      srcX: Math.round(0.3 * N), srcY: Math.round(0.2 * N), probeX: Math.round(0.7 * N), probeY: Math.round(0.6 * N),
    };
    const grid = { nx: N + 1, ny: N + 1, dx };
    let series: ArrayLike<number>;
    if (device) {
      const k = new FdtdTMz();
      await k.init(device, params, grid);
      k.step(steps);
      series = (await k.readback("probe")).slice(0, steps);
      k.dispose();
    } else {
      const c = new FdtdCpu(params, grid);
      c.step(steps);
      series = c.probe;
    }
    const nuA = fA * dt;
    const nu = spectralPeak(series, 0.8 * nuA, 1.2 * nuA, 200);
    const f = nu / dt;
    const fY = ((2 / dt) * Math.asin(S * Math.SQRT2 * Math.sin(Math.PI / (2 * N)))) / (2 * Math.PI);
    rows.push({
      backend: device ? "gpu" : "cpu", N, f_num_Hz: f, f_analytic_Hz: fA, f_yee_Hz: fY,
      relErrVsAnalytic: (f - fA) / fA, relErrVsYee: (f - fY) / fY, steps,
    });
  }
  for (let i = 1; i < rows.length; i++) {
    const p = rows[i - 1]!;
    const q = rows[i]!;
    if (q.N === 2 * p.N) q.order = Math.log2(Math.abs(p.relErrVsAnalytic) / Math.abs(q.relErrVsAnalytic));
  }
  return rows;
}

/** Gate 8 (FDTD): GPU vs CPU with CPML, PEC block, dielectric disc, CW point source. */
export async function fdtdGpuVsCpu(device: GPUDevice, n = 300): Promise<Record<string, number>> {
  const grid = { nx: 96, ny: 64, dx: 1e-3 };
  const p = { srcX: 30, srcY: 25, freq: 10e9 };
  const k = new FdtdTMz();
  await k.init(device, p, grid);
  const c = new FdtdCpu(p, grid);
  for (const o of [
    { tool: "pec", shape: "rect" as const, x0: 50, y0: 10, x1: 55, y1: 30 },
    { tool: "dielectric", shape: "disc" as const, x0: 70, y0: 45, r: 8, value: 4 },
  ]) {
    k.paint(o);
    c.paint(o);
  }
  k.step(n);
  c.step(n);
  const ez = await k.readback("ez");
  k.dispose();
  const d = maxAbsDiff(ez, c.ez);
  return { steps: n, cells: grid.nx * grid.ny, ez_maxAbsDiff: d, ez_rel: d / maxAbs(c.ez) };
}

// ---------------------------------------------------------------- Gray-Scott

/** Gate 6: GPU vs CPU (f64 and f32-rounded) after N steps on 64^2. */
export async function gsGpuVsCpu(device: GPUDevice, Ns = [100, 1000]): Promise<Array<Record<string, number>>> {
  const grid = { nx: 64, ny: 64, dx: 2 / 64 };
  const out: Array<Record<string, number>> = [];
  const M = grid.nx * grid.ny;
  for (const N of Ns) {
    const k = new GrayScott();
    await k.init(device, {}, grid);
    const c64 = new GrayScottCpu({}, grid);
    const c32 = new GrayScottCpu({}, grid, { f32: true });
    k.step(N);
    c64.step(N);
    c32.step(N);
    const u = await k.readback("u");
    const v = await k.readback("v");
    k.dispose();
    out.push({
      steps: N,
      u_vs_f64: maxAbsDiff(u, c64.uv), v_vs_f64: maxAbsDiff(v, c64.uv, M),
      u_vs_f32: maxAbsDiff(u, c32.uv), v_vs_f32: maxAbsDiff(v, c32.uv, M),
    });
  }
  return out;
}

export interface PatternResult extends PatternStats {
  backend: "cpu" | "gpu";
  set: string;
  f: number;
  k: number;
  steps: number;
  expected: string;
  pass: boolean;
}

/** Gate 7: pattern class at t = 10000 on The Well grid (128^2, dt 1) for two (f, k) sets. */
export async function gsPattern(device: GPUDevice | null, sets = ["spots", "maze"], steps = 10000, n = 128): Promise<PatternResult[]> {
  const expected: Record<string, string> = { spots: "spots", maze: "stripes/maze" };
  const out: PatternResult[] = [];
  const grid = { nx: n, ny: n, dx: 2 / n };
  for (const set of sets) {
    const [f, k] = WELL_FK[set]!;
    let v: ArrayLike<number>;
    if (device) {
      const g = new GrayScott();
      await g.init(device, { f, k }, grid);
      for (let s = 0; s < steps; s += 1000) g.step(Math.min(1000, steps - s));
      v = await g.readback("v");
      g.dispose();
    } else {
      const c = new GrayScottCpu({ f, k }, grid);
      c.step(steps);
      v = c.uv.subarray(n * n);
    }
    const st = patternClass(v, n, n);
    out.push({ backend: device ? "gpu" : "cpu", set, f, k, steps, ...st, expected: expected[set] ?? "?", pass: st.cls === expected[set] });
  }
  return out;
}
