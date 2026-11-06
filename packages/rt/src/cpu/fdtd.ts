// SPDX-License-Identifier: GPL-3.0-or-later
// CPU reference for the 2D TMz FDTD kernel (f64). Same update order and arithmetic as kernels/fdtd.ts.

import type { Grid, PaintOp } from "../types.ts";
import { rasterize } from "../paint.ts";
import { fdtdDt, fdtdMaterials, fdtdParams, paintCell, pmlProfile, waveform, type FdtdMaterials } from "../kernels/fdtd-common.ts";

export class FdtdCpu {
  readonly grid: Grid;
  readonly p: Record<string, number>;
  readonly dt: number;
  mat: FdtdMaterials;
  ez: Float64Array;
  hx: Float64Array;
  hy: Float64Array;
  private pezx: Float64Array;
  private pezy: Float64Array;
  private phxy: Float64Array;
  private phyx: Float64Array;
  private cx: Float64Array[];
  private cy: Float64Array[];
  steps = 0;
  /** Ez at the probe cell after each step (when probeX >= 0) */
  probe: number[] = [];

  constructor(params: Record<string, number>, grid: Grid) {
    this.grid = grid;
    this.p = fdtdParams(params);
    this.dt = fdtdDt(this.p, grid);
    this.mat = fdtdMaterials(this.p, grid);
    const N = grid.nx * grid.ny;
    this.ez = new Float64Array(N);
    this.hx = new Float64Array(N);
    this.hy = new Float64Array(N);
    this.pezx = new Float64Array(N);
    this.pezy = new Float64Array(N);
    this.phxy = new Float64Array(N);
    this.phyx = new Float64Array(N);
    this.cx = pmlProfile(grid.nx, this.p.bcX!, this.p);
    this.cy = pmlProfile(grid.ny, this.p.bcY!, this.p);
  }

  paint(op: PaintOp): void {
    rasterize(op, this.grid.nx, this.grid.ny, (c) => paintCell(this.mat, c, op.tool, op.value ?? 1));
  }

  step(n: number): void {
    for (let s = 0; s < n; s++) this.step1();
  }

  private step1(): void {
    const { nx, ny } = this.grid;
    const S = this.p.S!;
    const perX = this.p.bcX === 2;
    const perY = this.p.bcY === 2;
    const { ez, hx, hy } = this;
    const [kxE, bxE, cxE, kxH, bxH, cxH] = this.cx as [Float64Array, Float64Array, Float64Array, Float64Array, Float64Array, Float64Array];
    const [kyE, byE, cyE, kyH, byH, cyH] = this.cy as [Float64Array, Float64Array, Float64Array, Float64Array, Float64Array, Float64Array];
    // H update
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const c = j * nx + i;
        const ezN = j + 1 < ny ? ez[c + nx]! : perY ? ez[i]! : 0;
        const ezE = i + 1 < nx ? ez[c + 1]! : perX ? ez[j * nx]! : 0;
        const dEy = ezN - ez[c]!;
        const dEx = ezE - ez[c]!;
        const a = byH[j]! * this.phxy[c]! + cyH[j]! * dEy;
        this.phxy[c] = a;
        hx[c] = hx[c]! - S * (dEy / kyH[j]! + a);
        const b = bxH[i]! * this.phyx[c]! + cxH[i]! * dEx;
        this.phyx[c] = b;
        hy[c] = hy[c]! + S * (dEx / kxH[i]! + b);
      }
    // E update
    const w = waveform(this.p, this.steps * this.dt);
    const { ca, cb, src } = this.mat;
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const c = j * nx + i;
        const hyW = i > 0 ? hy[c - 1]! : perX ? hy[j * nx + nx - 1]! : 0;
        const hxS = j > 0 ? hx[c - nx]! : perY ? hx[(ny - 1) * nx + i]! : 0;
        const dHy = hy[c]! - hyW;
        const dHx = hx[c]! - hxS;
        const a = bxE[i]! * this.pezx[c]! + cxE[i]! * dHy;
        this.pezx[c] = a;
        const b = byE[j]! * this.pezy[c]! + cyE[j]! * dHx;
        this.pezy[c] = b;
        ez[c] = ca[c]! * ez[c]! + cb[c]! * (dHy / kxE[i]! + a - dHx / kyE[j]! - b) + src[c]! * w;
      }
    this.steps++;
    if (this.p.probeX! >= 0) this.probe.push(ez[Math.round(this.p.probeY!) * nx + Math.round(this.p.probeX!)]!);
  }
}
