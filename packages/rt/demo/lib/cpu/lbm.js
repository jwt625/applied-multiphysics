// Generated from packages/rt/src/cpu/lbm.ts by scripts/emit-browser.ts; do not edit.
// SPDX-License-Identifier: GPL-3.0-or-later
// CPU reference for the D2Q9 kernel (f64). Same algorithm, same order of operations as the WGSL in kernels/lbm.ts.

                                                 
import { rasterize } from "../paint.js";
import { CX, CY, NO_LINK, OPP, W, geq, inletU, lbmBoundary, lbmDerive, lbmInitial, lbmMask, lbmParams,                                   } from "../kernels/lbm-common.js";

export class LbmCpu {
           grid      ;
  p                        ;
  d            ;
  mask             ;
  g              ; // post-collision populations (deviation form), time n
          gn              ;
  rho              ;
  ux              ;
  uy              ;
  bnd             ;
  /** momentum-exchange force per boundary cell from the last step (Fx, Fy interleaved) */
          fcell              ;
  steps = 0;

  constructor(params                        , grid      ) {
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
    this.bnd = lbmBoundary(this.p, grid, this.mask);
    this.fcell = new Float64Array(2 * this.bnd.count);
  }

  setParams(p                        )       {
    this.p = lbmParams({ ...this.p, ...p });
    this.d = lbmDerive(this.p, this.grid);
  }

  paint(op         )       {
    const v = op.tool === "erase" ? 0 : 2;
    rasterize(op, this.grid.nx, this.grid.ny, (c) => {
      if (this.p.walls === 1 && (c < this.grid.nx || c >= (this.grid.ny - 1) * this.grid.nx)) return;
      this.mask[c] = v;
    });
    this.bnd = lbmBoundary(this.p, this.grid, this.mask);
    this.fcell = new Float64Array(2 * this.bnd.count);
  }

  step(n        )       {
    for (let s = 0; s < n; s++) this.step1();
  }

          step1()       {
    const { nx, ny } = this.grid;
    const N = nx * ny;
    const { omegaP, omegaM, H } = this.d;
    const p = this.p;
    const periodicX = p.inlet !== 1;
    const inlet = p.inlet === 1;
    const uMax = p.uMax ;
    const fx = p.forceX ;
    const fy = 0;
    const g = this.g;
    const gn = this.gn;
    const mask = this.mask;
    const gi = new Float64Array(9);
    const lidx = this.bnd.lidx;
    const qtab = this.bnd.q;
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
        // pull streaming: halfway bounce-back on walls, Bouzidi linear interpolation on obstacle links
        const b = lidx[c] ;
        let fxa = 0;
        let fya = 0;
        for (let i = 0; i < 9; i++) {
          let sx = x - CX[i] ;
          let sy = y - CY[i] ;
          if (periodicX) sx = (sx + nx) % nx;
          else sx = Math.min(nx - 1, Math.max(0, sx));
          sy = (sy + ny) % ny;
          const sc = sy * nx + sx;
          if (mask[sc] === 0) {
            gi[i] = g[i * N + sc] ;
            continue;
          }
          const o = OPP[i] ;
          const go = g[o * N + c] ;
          if (mask[sc] !== 2 || b === NO_LINK) {
            gi[i] = go;
            continue;
          }
          const q = qtab[b * 8 + i - 1] ;
          let v        ;
          if (q < 0.5) {
            let fx2 = x + CX[i] ;
            const fy2 = (y + CY[i]  + ny) % ny;
            if (periodicX) fx2 = (fx2 + nx) % nx;
            const ok = fx2 >= 0 && fx2 < nx && mask[fy2 * nx + fx2] === 0;
            v = ok ? 2 * q * go + (1 - 2 * q) * g[o * N + fy2 * nx + fx2]  : go;
          } else {
            v = go / (2 * q) + ((2 * q - 1) / (2 * q)) * g[i * N + c] ;
          }
          gi[i] = v;
          // momentum given to the obstacle: c_o (f*_o + f_i) with c_o = -c_i (full populations f = g + w)
          fxa -= CX[i]  * (go + v + 2 * W[i] );
          fya -= CY[i]  * (go + v + 2 * W[i] );
        }
        if (b !== NO_LINK) {
          this.fcell[2 * b] = fxa;
          this.fcell[2 * b + 1] = fya;
        }
        if (inlet && x === nx - 1) {
          // outlet: unknowns 3, 6, 7 from the post-collision state of the source cell (nx-1, y - c_y) with its
          // equilibrium part replaced by the rho = 1 equilibrium (non-equilibrium extrapolation, pressure fixed)
          for (const i of [3, 6, 7]) {
            const sy = (y - CY[i]  + ny) % ny;
            const sc = sy * nx + x;
            if (mask[sc] !== 0) continue; // bounce-back value already pulled
            let r = 1;
            let jx = 0;
            let jy = 0;
            for (let k = 0; k < 9; k++) {
              const v = g[k * N + sc] ;
              r += v;
              jx += CX[k]  * v;
              jy += CY[k]  * v;
            }
            const vx = jx / r;
            const vy = jy / r;
            gi[i] = geq(i, 1, vx, vy) + g[i * N + sc]  - geq(i, r, vx, vy);
          }
        }
        let rho        ;
        let ux        ;
        let uy        ;
        if (inlet && x === 0) {
          // Zou-He velocity inlet, u = (u_in(y), 0); unknowns 1, 5, 8
          ux = inletU(y, uMax, H);
          uy = 0;
          rho = (1 + gi[0]  + gi[2]  + gi[4]  + 2 * (gi[3]  + gi[6]  + gi[7] )) / (1 - ux);
          gi[1] = gi[3]  + (2 / 3) * rho * ux;
          gi[5] = gi[7]  - 0.5 * (gi[2]  - gi[4] ) + (1 / 6) * rho * ux;
          gi[8] = gi[6]  + 0.5 * (gi[2]  - gi[4] ) + (1 / 6) * rho * ux;
        } else {
          rho = 1;
          let jx = 0;
          let jy = 0;
          for (let i = 0; i < 9; i++) {
            rho += gi[i] ;
            jx += CX[i]  * gi[i] ;
            jy += CY[i]  * gi[i] ;
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
          const o = OPP[i] ;
          const eqi = geq(i, rho, ux, uy);
          const eqo = geq(o, rho, ux, uy);
          const gs = 0.5 * (gi[i]  + gi[o] );
          const ga = 0.5 * (gi[i]  - gi[o] );
          const es = 0.5 * (eqi + eqo);
          const ea = 0.5 * (eqi - eqo);
          const cu = CX[i]  * ux + CY[i]  * uy;
          const cf = CX[i]  * fx + CY[i]  * fy;
          const sEven = W[i]  * (9 * cu * cf - 3 * uf);
          const sOdd = W[i]  * 3 * cf;
          gn[i * N + c] =
            gi[i]  - omegaP * (gs - es) - omegaM * (ga - ea) + (1 - 0.5 * omegaP) * sEven + (1 - 0.5 * omegaM) * sOdd;
        }
      }
    this.g = gn;
    this.gn = g;
    this.steps++;
  }

  /** Momentum-exchange force on obstacles (mask 2) during the last step, lattice units. */
  force()                   {
    let Fx = 0;
    let Fy = 0;
    for (let b = 0; b < this.bnd.count; b++) {
      Fx += this.fcell[2 * b] ;
      Fy += this.fcell[2 * b + 1] ;
    }
    return [Fx, Fy];
  }
}
