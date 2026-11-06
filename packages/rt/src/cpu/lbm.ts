// SPDX-License-Identifier: GPL-3.0-or-later
// CPU reference for the D2Q9 kernel (f64). Same algorithm, same order of operations as the WGSL in kernels/lbm.ts.

import type { Grid, PaintOp } from "../types.ts";
import { rasterize } from "../paint.ts";
import { CX, CY, OPP, W, geq, inletU, lbmDerive, lbmInitial, lbmMask, lbmParams, type LbmDerived } from "../kernels/lbm-common.ts";

export class LbmCpu {
  readonly grid: Grid;
  p: Record<string, number>;
  d: LbmDerived;
  mask: Uint32Array;
  g: Float64Array; // post-collision populations (deviation form), time n
  private gn: Float64Array;
  rho: Float64Array;
  ux: Float64Array;
  uy: Float64Array;
  steps = 0;

  constructor(params: Record<string, number>, grid: Grid) {
    this.grid = grid;
    this.p = lbmParams(params);
    this.d = lbmDerive(this.p, grid);
    this.mask = lbmMask(this.p, grid);
    this.g = lbmInitial(this.p, grid, this.mask);
    this.gn = new Float64Array(this.g.length);
    const N = grid.nx * grid.ny;
    this.rho = new Float64Array(N).fill(1);
    this.ux = new Float64Array(N);
    this.uy = new Float64Array(N);
  }

  setParams(p: Record<string, number>): void {
    this.p = lbmParams({ ...this.p, ...p });
    this.d = lbmDerive(this.p, this.grid);
  }

  paint(op: PaintOp): void {
    const v = op.tool === "erase" ? 0 : 2;
    rasterize(op, this.grid.nx, this.grid.ny, (c) => {
      this.mask[c] = v;
    });
  }

  step(n: number): void {
    for (let s = 0; s < n; s++) this.step1();
  }

  private step1(): void {
    const { nx, ny } = this.grid;
    const N = nx * ny;
    const { omegaP, omegaM, H } = this.d;
    const p = this.p;
    const periodicX = p.inlet !== 1;
    const inlet = p.inlet === 1;
    const uMax = p.uMax!;
    const fx = p.forceX!;
    const fy = 0;
    const g = this.g;
    const gn = this.gn;
    const mask = this.mask;
    const gi = new Float64Array(9);
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++) {
        const c = y * nx + x;
        if (mask[c] !== 0) {
          for (let i = 0; i < 9; i++) gn[i * N + c] = 0;
          this.rho[c] = 1;
          this.ux[c] = 0;
          this.uy[c] = 0;
          continue;
        }
        // pull streaming with halfway bounce-back
        for (let i = 0; i < 9; i++) {
          let sx = x - CX[i]!;
          let sy = y - CY[i]!;
          if (periodicX) sx = (sx + nx) % nx;
          else sx = Math.min(nx - 1, Math.max(0, sx));
          sy = (sy + ny) % ny;
          const sc = sy * nx + sx;
          gi[i] = mask[sc] !== 0 ? g[OPP[i]! * N + c]! : g[i * N + sc]!;
        }
        if (inlet && x === nx - 1) {
          // outlet: unknowns 3, 6, 7 from the post-collision state of the source cell (nx-1, y - c_y) with its
          // equilibrium part replaced by the rho = 1 equilibrium (non-equilibrium extrapolation, pressure fixed)
          for (const i of [3, 6, 7]) {
            const sy = (y - CY[i]! + ny) % ny;
            const sc = sy * nx + x;
            if (mask[sc] !== 0) continue; // bounce-back value already pulled
            let r = 1;
            let jx = 0;
            let jy = 0;
            for (let k = 0; k < 9; k++) {
              const v = g[k * N + sc]!;
              r += v;
              jx += CX[k]! * v;
              jy += CY[k]! * v;
            }
            const vx = jx / r;
            const vy = jy / r;
            gi[i] = geq(i, 1, vx, vy) + g[i * N + sc]! - geq(i, r, vx, vy);
          }
        }
        let rho: number;
        let ux: number;
        let uy: number;
        if (inlet && x === 0) {
          // Zou-He velocity inlet, u = (u_in(y), 0); unknowns 1, 5, 8
          ux = inletU(y, uMax, H);
          uy = 0;
          rho = (1 + gi[0]! + gi[2]! + gi[4]! + 2 * (gi[3]! + gi[6]! + gi[7]!)) / (1 - ux);
          gi[1] = gi[3]! + (2 / 3) * rho * ux;
          gi[5] = gi[7]! - 0.5 * (gi[2]! - gi[4]!) + (1 / 6) * rho * ux;
          gi[8] = gi[6]! + 0.5 * (gi[2]! - gi[4]!) + (1 / 6) * rho * ux;
        } else {
          rho = 1;
          let jx = 0;
          let jy = 0;
          for (let i = 0; i < 9; i++) {
            rho += gi[i]!;
            jx += CX[i]! * gi[i]!;
            jy += CY[i]! * gi[i]!;
          }
          ux = (jx + 0.5 * fx) / rho;
          uy = (jy + 0.5 * fy) / rho;
        }
        this.rho[c] = rho;
        this.ux[c] = ux;
        this.uy[c] = uy;
        // TRT collision with Guo forcing split into even / odd parts
        const uf = ux * fx + uy * fy;
        for (let i = 0; i < 9; i++) {
          const o = OPP[i]!;
          const eqi = geq(i, rho, ux, uy);
          const eqo = geq(o, rho, ux, uy);
          const gs = 0.5 * (gi[i]! + gi[o]!);
          const ga = 0.5 * (gi[i]! - gi[o]!);
          const es = 0.5 * (eqi + eqo);
          const ea = 0.5 * (eqi - eqo);
          const cu = CX[i]! * ux + CY[i]! * uy;
          const cf = CX[i]! * fx + CY[i]! * fy;
          const sEven = W[i]! * (9 * cu * cf - 3 * uf);
          const sOdd = W[i]! * 3 * cf;
          gn[i * N + c] =
            gi[i]! - omegaP * (gs - es) - omegaM * (ga - ea) + (1 - 0.5 * omegaP) * sEven + (1 - 0.5 * omegaM) * sOdd;
        }
      }
    this.g = gn;
    this.gn = g;
    this.steps++;
  }

  /** Momentum-exchange force on obstacle cells (mask 2), lattice units, from the post-collision state. */
  force(): [number, number] {
    const { nx, ny } = this.grid;
    const N = nx * ny;
    let Fx = 0;
    let Fy = 0;
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++) {
        const c = y * nx + x;
        if (this.mask[c] !== 0) continue;
        for (let k = 1; k < 9; k++) {
          const tx = x + CX[k]!;
          const ty = (y + CY[k]! + ny) % ny;
          if (tx < 0 || tx >= nx) continue;
          if (this.mask[ty * nx + tx] !== 2) continue;
          const f = this.g[k * N + c]! + W[k]!;
          Fx += 2 * f * CX[k]!;
          Fy += 2 * f * CY[k]!;
        }
      }
    return [Fx, Fy];
  }
}
