// SPDX-License-Identifier: GPL-3.0-or-later
// D2Q9 lattice Boltzmann: constants, parameter derivation, geometry setup.
// Shared by the WGSL kernel (lbm.ts) and the CPU reference (cpu/lbm.ts). DevLog-005 L6-1..L6-3.
//
// Numbering: 0 rest, 1 E, 2 N, 3 W, 4 S, 5 NE, 6 NW, 7 SW, 8 SE.
// Populations are stored as deviations g_i = f_i - w_i (rho0 = 1), SoA layout g[i * N + cell].

import type { Grid } from "../types.ts";

export const CX = [0, 1, 0, -1, 0, 1, -1, -1, 1] as const;
export const CY = [0, 0, 1, 0, -1, 1, 1, -1, -1] as const;
export const W = [4 / 9, 1 / 9, 1 / 9, 1 / 9, 1 / 9, 1 / 36, 1 / 36, 1 / 36, 1 / 36] as const;
export const OPP = [0, 3, 4, 1, 2, 7, 8, 5, 6] as const;

export const LBM_DEFAULTS: Record<string, number> = {
  Re: 100, // Reynolds number U_mean L / nu
  uMax: 0.1, // peak inlet velocity, lattice units (Mach = uMax * sqrt(3))
  L: 20, // characteristic length for Re, cells (cylinder diameter)
  tau: 0, // > 0 overrides Re
  collision: 1, // 1 TRT, 0 BGK
  lambda: 3 / 16, // TRT magic parameter
  forceX: 0, // body force, lattice units
  inlet: 1, // 1 Zou-He velocity inlet at x = 0 and non-equilibrium-extrapolation outlet at rho = 1 (x = nx-1); 0 periodic in x
  walls: 1, // 1 solid rows at y = 0 and y = ny-1 (halfway bounce-back walls at y = 0.5 and ny-1.5)
  cylX: -1, // cylinder centre, cells (node coordinates); cylR <= 0 for none
  cylY: -1,
  cylR: 0,
  Uref: 0, // physical mean inflow velocity, m/s, for display units; 0 = lattice units
  probeX: -1, // probe cell for the uy time series; -1 none
  probeY: -1,
};

export interface LbmDerived {
  tau: number;
  nu: number;
  omegaP: number;
  omegaM: number;
  uMean: number;
  H: number;
  /** m/s per lattice velocity unit (1 when Uref = 0) */
  velScale: number;
  /** physical time step, s (NaN when Uref = 0) */
  dt: number;
  mach: number;
}

export function lbmParams(p: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = { ...LBM_DEFAULTS };
  for (const [k, v] of Object.entries(p)) {
    if (!(k in LBM_DEFAULTS)) throw new Error(`lbm: unknown parameter ${k}`);
    out[k] = v;
  }
  return out;
}

const num = (p: Record<string, number>, k: string): number => {
  const v = p[k];
  if (v === undefined || !Number.isFinite(v)) throw new Error(`lbm: parameter ${k} missing or not finite`);
  return v;
};

export function lbmDerive(p: Record<string, number>, grid: Grid): LbmDerived {
  const uMax = num(p, "uMax");
  const uMean = (2 / 3) * uMax;
  const tauIn = num(p, "tau");
  const nu = tauIn > 0 ? (tauIn - 0.5) / 3 : (uMean * num(p, "L")) / num(p, "Re");
  const tau = 3 * nu + 0.5;
  const omegaP = 1 / tau;
  const omegaM = num(p, "collision") === 1 ? 1 / (0.5 + num(p, "lambda") / (tau - 0.5)) : omegaP;
  const H = num(p, "walls") === 1 ? grid.ny - 2 : grid.ny;
  const Uref = num(p, "Uref");
  const velScale = Uref > 0 ? Uref / uMean : 1;
  const dt = Uref > 0 ? (grid.dx * uMean) / Uref : NaN;
  return { tau, nu, omegaP, omegaM, uMean, H, velScale, dt, mach: uMax * Math.sqrt(3) };
}

/** Parabolic inlet profile at row j (walls at j = 0.5 and j = ny - 1.5). */
export function inletU(j: number, uMax: number, H: number): number {
  const y = j - 0.5;
  return (4 * uMax * y * (H - y)) / (H * H);
}

/** Initial solid mask: 0 fluid, 1 channel wall, 2 obstacle (force is integrated on obstacles only). */
export function lbmMask(p: Record<string, number>, grid: Grid): Uint32Array {
  const { nx, ny } = grid;
  const m = new Uint32Array(nx * ny);
  if (num(p, "walls") === 1) {
    for (let i = 0; i < nx; i++) {
      m[i] = 1;
      m[(ny - 1) * nx + i] = 1;
    }
  }
  const r = num(p, "cylR");
  if (r > 0) {
    const cx = num(p, "cylX");
    const cy = num(p, "cylY");
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const dx = i - cx;
        const dy = j - cy;
        if (dx * dx + dy * dy < r * r) m[j * nx + i] = 2;
      }
  }
  return m;
}

/** Equilibrium deviation g_eq_i = f_eq_i - w_i. */
export function geq(i: number, rho: number, ux: number, uy: number): number {
  const cu = CX[i]! * ux + CY[i]! * uy;
  const u2 = ux * ux + uy * uy;
  return W[i]! * (rho - 1 + rho * (3 * cu + 4.5 * cu * cu - 1.5 * u2));
}

/** Initial populations (deviation form): equilibrium at rho = 1 with the inlet profile (or rest). */
export function lbmInitial(p: Record<string, number>, grid: Grid, mask: Uint32Array): Float64Array {
  const { nx, ny } = grid;
  const N = nx * ny;
  const d = lbmDerive(p, grid);
  const g = new Float64Array(9 * N);
  const useInlet = num(p, "inlet") === 1 && num(p, "walls") === 1;
  for (let j = 0; j < ny; j++)
    for (let x = 0; x < nx; x++) {
      const c = j * nx + x;
      if (mask[c] !== 0) continue;
      const ux = useInlet ? inletU(j, num(p, "uMax"), d.H) : 0;
      for (let i = 0; i < 9; i++) g[i * N + c] = geq(i, 1, ux, 0);
    }
  return g;
}

/** DFG 2D-2 geometry (FEATFLOW): channel [0, 2.2] x [0, 0.41], cylinder centre (0.2, 0.2), D = 0.1. nD cells per D (multiple of 10). */
export function dfgGrid(nD: number): { grid: Grid; params: Record<string, number> } {
  if (nD % 10 !== 0) throw new Error("dfgGrid: nD must be a multiple of 10 so that H = 4.1 D is an integer");
  const h = 0.1 / nD; // m per cell
  const nx = 22 * nD + 1; // inlet node at x = 0, outlet node at x = 2.2
  const ny = (41 * nD) / 10 + 2; // fluid rows 1..ny-2, walls midway at y = 0 and y = 0.41
  return {
    grid: { nx, ny, dx: h },
    params: {
      L: nD,
      cylX: 2 * nD,
      cylY: 0.5 + 2 * nD,
      cylR: nD / 2,
      inlet: 1,
      walls: 1,
      Uref: 1.0, // DFG U_mean = 2/3 * 1.5 m/s
      probeX: 4 * nD,
      probeY: Math.round(0.5 + 2 * nD),
    },
  };
}
