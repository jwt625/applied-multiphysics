// SPDX-License-Identifier: GPL-3.0-or-later
// CPU reference for the Gray-Scott kernel: f64, or f32 with every operation rounded (Math.fround),
// in the same operation order as the WGSL in kernels/grayscott.ts.

import type { Grid, PaintOp } from "../types.ts";
import { rasterize } from "../paint.ts";
import { gsInitial, gsParams } from "../kernels/grayscott-common.ts";

export class GrayScottCpu {
  readonly grid: Grid;
  p: Record<string, number>;
  uv: Float64Array;
  private nx2: Float64Array;
  readonly f32: boolean;
  steps = 0;

  constructor(params: Record<string, number>, grid: Grid, opts: { f32?: boolean } = {}) {
    this.grid = grid;
    this.p = gsParams(params);
    this.f32 = opts.f32 === true;
    this.uv = gsInitial(this.p, grid);
    if (this.f32) for (let i = 0; i < this.uv.length; i++) this.uv[i] = Math.fround(this.uv[i]!);
    this.nx2 = new Float64Array(this.uv.length);
  }

  paint(op: PaintOp): void {
    const N = this.grid.nx * this.grid.ny;
    const [u, v] = op.tool === "erase" ? [1, 0] : [0.5, 0.25];
    rasterize(op, this.grid.nx, this.grid.ny, (c) => {
      this.uv[c] = u;
      this.uv[N + c] = v;
    });
  }

  step(n: number): void {
    for (let s = 0; s < n; s++) (this.f32 ? this.step32() : this.step64());
  }

  private step64(): void {
    const { nx, ny, dx } = this.grid;
    const N = nx * ny;
    const { f, k, Du, Dv, dt } = this.p as Record<"f" | "k" | "Du" | "Dv" | "dt", number>;
    const inv = 1 / (dx * dx);
    const a = this.uv;
    const b = this.nx2;
    for (let j = 0; j < ny; j++) {
      const jn = j + 1 < ny ? j + 1 : 0;
      const js = j > 0 ? j - 1 : ny - 1;
      for (let i = 0; i < nx; i++) {
        const ie = i + 1 < nx ? i + 1 : 0;
        const iw = i > 0 ? i - 1 : nx - 1;
        const c = j * nx + i;
        const u = a[c]!;
        const v = a[N + c]!;
        const lu = (a[j * nx + ie]! + a[j * nx + iw]! + a[jn * nx + i]! + a[js * nx + i]! - 4 * u) * inv;
        const lv = (a[N + j * nx + ie]! + a[N + j * nx + iw]! + a[N + jn * nx + i]! + a[N + js * nx + i]! - 4 * v) * inv;
        const uvv = u * v * v;
        b[c] = u + dt * (Du * lu - uvv + f * (1 - u));
        b[N + c] = v + dt * (Dv * lv + uvv - (f + k) * v);
      }
    }
    this.uv = b;
    this.nx2 = a;
    this.steps++;
  }

  private step32(): void {
    const r = Math.fround;
    const { nx, ny, dx } = this.grid;
    const N = nx * ny;
    const f = r(this.p.f!);
    const k = r(this.p.k!);
    const Du = r(this.p.Du!);
    const Dv = r(this.p.Dv!);
    const dt = r(this.p.dt!);
    const inv = r(1 / (dx * dx));
    const fk = r(f + k);
    const a = this.uv;
    const b = this.nx2;
    for (let j = 0; j < ny; j++) {
      const jn = j + 1 < ny ? j + 1 : 0;
      const js = j > 0 ? j - 1 : ny - 1;
      for (let i = 0; i < nx; i++) {
        const ie = i + 1 < nx ? i + 1 : 0;
        const iw = i > 0 ? i - 1 : nx - 1;
        const c = j * nx + i;
        const u = a[c]!;
        const v = a[N + c]!;
        const lu = r(r(r(r(r(r(a[j * nx + ie]! + a[j * nx + iw]!) + a[jn * nx + i]!) + a[js * nx + i]!) - r(4 * u))) * inv);
        const lv = r(
          r(r(r(r(r(a[N + j * nx + ie]! + a[N + j * nx + iw]!) + a[N + jn * nx + i]!) + a[N + js * nx + i]!) - r(4 * v))) * inv,
        );
        const uvv = r(r(u * v) * v);
        b[c] = r(u + r(dt * r(r(r(Du * lu) - uvv) + r(f * r(1 - u)))));
        b[N + c] = r(v + r(dt * r(r(r(Dv * lv) + uvv) - r(fk * v))));
      }
    }
    this.uv = b;
    this.nx2 = a;
    this.steps++;
  }
}
