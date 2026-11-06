// Generated from packages/rt/src/kernels/grayscott-common.ts by scripts/emit-browser.ts; do not edit.
// SPDX-License-Identifier: GPL-3.0-or-later
// Gray-Scott reaction-diffusion (The Well form): u_t = Du lap u - u v^2 + f (1 - u); v_t = Dv lap v + u v^2 - (f + k) v.
// Explicit Euler, 5-point Laplacian, periodic. DevLog-005 L6-6.
// The Well gray_scott_reaction_diffusion (README, verified 2026-11-06): domain [-1, 1]^2, 128^2, dt 1, Du 2e-5, Dv 1e-5.

                                        

export const GS_DEFAULTS                         = {
  f: 0.03,
  k: 0.062,
  Du: 2e-5,
  Dv: 1e-5,
  dt: 1,
  ic: 0, // 0 random Gaussian clusters, 1 centre square (Pearson-style), 2 uniform u = 1, v = 0
  seed: 1,
  blobs: 30,
  sigma: 0.04, // Gaussian blob width, model length units
};

/** The six The Well (f, k) sets (README "Set of coefficients", accessed 2026-11-06). */
export const WELL_FK                                   = {
  gliders: [0.014, 0.054],
  bubbles: [0.098, 0.057],
  maze: [0.029, 0.057],
  worms: [0.058, 0.065],
  spirals: [0.018, 0.051],
  spots: [0.03, 0.062],
};

export function gsParams(p                        )                         {
  const out                         = { ...GS_DEFAULTS };
  for (const [k, v] of Object.entries(p)) {
    if (!(k in GS_DEFAULTS)) throw new Error(`gray-scott: unknown parameter ${k}`);
    if (!Number.isFinite(v)) throw new Error(`gray-scott: parameter ${k} not finite`);
    out[k] = v;
  }
  return out;
}

/** Explicit-Euler diffusion number max(Du, Dv) dt / dx^2 (stable below 0.25). */
export function gsDiffusionNumber(p                        , grid      )         {
  return (Math.max(p.Du , p.Dv ) * p.dt ) / (grid.dx * grid.dx);
}

function mulberry32(a        )               {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Initial condition, SoA [u (N) | v (N)]. */
export function gsInitial(p                        , grid      )               {
  const { nx, ny, dx } = grid;
  const N = nx * ny;
  const uv = new Float64Array(2 * N);
  uv.fill(1, 0, N);
  if (p.ic === 2) return uv;
  if (p.ic === 1) {
    const r = Math.max(2, Math.round(Math.min(nx, ny) / 20));
    for (let j = (ny >> 1) - r; j <= (ny >> 1) + r; j++)
      for (let i = (nx >> 1) - r; i <= (nx >> 1) + r; i++) {
        const c = j * nx + i;
        uv[c] = 0.5;
        uv[N + c] = 0.25;
      }
    return uv;
  }
  const rnd = mulberry32(p.seed  | 0);
  const Lx = nx * dx;
  const Ly = ny * dx;
  const s2 = 2 * p.sigma  * p.sigma ;
  const centres                          = [];
  for (let b = 0; b < p.blobs ; b++) centres.push([rnd() * Lx, rnd() * Ly]);
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      let v = 0;
      for (const [cx, cy] of centres) {
        let ddx = Math.abs(i * dx - cx);
        let ddy = Math.abs(j * dx - cy);
        ddx = Math.min(ddx, Lx - ddx);
        ddy = Math.min(ddy, Ly - ddy);
        v += Math.exp(-(ddx * ddx + ddy * ddy) / s2);
      }
      v = Math.min(1, v);
      const c = j * nx + i;
      uv[c] = 1 - v;
      uv[N + c] = v;
    }
  return uv;
}
