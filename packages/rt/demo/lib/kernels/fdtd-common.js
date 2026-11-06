// Generated from packages/rt/src/kernels/fdtd-common.ts by scripts/emit-browser.ts; do not edit.
// SPDX-License-Identifier: GPL-3.0-or-later
// 2D TMz FDTD (Ez, Hx, Hy) on a Yee grid: parameters, CPML profiles, materials, source waveform.
// Shared by the WGSL kernel (fdtd.ts) and the CPU reference (cpu/fdtd.ts). DevLog-005 L6-4, L6-5.
//
// Normalized form: H' = eta0 H, S = c0 dt / dx (dx = dy).
//   Hx'(i, j+1/2) -= S [ dEz_y / kappa_y + psi_hxy ]      psi_hxy = b_y psi_hxy + c_y dEz_y
//   Hy'(i+1/2, j) += S [ dEz_x / kappa_x + psi_hyx ]      psi_hyx = b_x psi_hyx + c_x dEz_x
//   Ez(i, j) = ca Ez + cb [ dHy_x / kappa_x + psi_ezx - dHx_y / kappa_y - psi_ezy ] + src w(t)
// with cb = S / eps_r (lossless). CPML: Roden and Gedney 2000; Taflove and Hagness, 3rd ed., ch. 7.
// Normalized conductivities: sigma_hat = sigma eta0 dx, alpha_hat = alpha eta0 dx, so b = exp(-S (sigma_hat / kappa + alpha_hat)).

                                        

/** Speed of light in vacuum, m/s (SI defined constant). */
export const C0 = 299792458;

export const FDTD_DEFAULTS                         = {
  S: 0.5, // Courant number c0 dt / dx (2D stability limit 1/sqrt(2))
  bcX: 1, // 0 PEC, 1 CPML (PEC-backed), 2 periodic
  bcY: 1,
  pml: 12, // CPML thickness, cells
  pmlM: 3, // polynomial grading order
  pmlSigma: 1, // sigma_max as a multiple of sigma_opt = 0.8 (m + 1) / (eta0 dx)
  pmlKappa: 1, // kappa_max
  pmlAlpha: 0, // alpha_hat_max (CFS), normalized
  freq: 10e9, // source frequency (CW) or Ricker peak frequency, Hz
  srcType: 0, // 0 CW (raised-cosine ramp), 1 Ricker wavelet
  srcAmp: 1,
  ramp: 3, // CW ramp, periods
  srcX: -1, // initial point source, cells; -1 none
  srcY: -1,
  srcLine: 0, // 1: line source along y at srcX (plane wave in x)
  probeX: -1, // probe cell for the Ez time series; -1 none
  probeY: -1,
};

export function fdtdParams(p                        )                         {
  const out                         = { ...FDTD_DEFAULTS };
  for (const [k, v] of Object.entries(p)) {
    if (!(k in FDTD_DEFAULTS)) throw new Error(`fdtd: unknown parameter ${k}`);
    if (!Number.isFinite(v)) throw new Error(`fdtd: parameter ${k} not finite`);
    out[k] = v;
  }
  if (out.S  <= 0 || out.S  > 1 / Math.SQRT2) throw new Error("fdtd: S must be in (0, 1/sqrt(2)]");
  return out;
}

export function fdtdDt(p                        , grid      )         {
  return (p.S  * grid.dx) / C0;
}

/** 1D CPML coefficient arrays for one axis with n nodes: [kE, bE, cE, kH, bH, cH], each length n. */
export function pmlProfile(n        , mode        , p                        )                 {
  const out = [0, 1, 2, 3, 4, 5].map(() => new Float64Array(n));
  const [kE, bE, cE, kH, bH, cH] = out                                                                                        ;
  kE.fill(1);
  kH.fill(1);
  bE.fill(1);
  bH.fill(1);
  const np = p.pml ;
  if (mode !== 1 || np <= 0) return out;
  const m = p.pmlM ;
  const sMax = p.pmlSigma  * 0.8 * (m + 1);
  const kMax = p.pmlKappa ;
  const aMax = p.pmlAlpha ;
  const S = p.S ;
  const depth = (pos        )         => {
    const d = Math.max(np - pos, pos - (n - 1 - np), 0) / np;
    return Math.min(1, d);
  };
  const coef = (d        )                           => {
    if (d <= 0) return [1, 1, 0];
    const sg = sMax * Math.pow(d, m);
    const ka = 1 + (kMax - 1) * Math.pow(d, m);
    const al = aMax * (1 - d);
    const b = Math.exp(-S * (sg / ka + al));
    const c = sg > 0 ? (sg / (sg * ka + ka * ka * al)) * (b - 1) : 0;
    return [ka, b, c];
  };
  for (let i = 0; i < n; i++) {
    [kE[i], bE[i], cE[i]] = coef(depth(i));
    [kH[i], bH[i], cH[i]] = coef(depth(i + 0.5));
  }
  return out;
}

                                
                   
                   
                    
                     
                                                                       
                   
                                                       
                   
                      
            
 

function reclass(m               , c        )       {
  m.cls[c] = m.cb[c] === 0 ? 1 : m.src[c] !== 0 ? 3 : m.epsr[c] !== 1 ? 2 : m.pmlCell[c] ? 4 : 0;
}

export function fdtdMaterials(p                        , grid      )                {
  const { nx, ny } = grid;
  const N = nx * ny;
  const m                = {
    ca: new Float64Array(N).fill(1),
    cb: new Float64Array(N).fill(p.S ),
    src: new Float64Array(N),
    epsr: new Float64Array(N).fill(1),
    cls: new Uint32Array(N),
    wall: new Uint8Array(N),
    pmlCell: new Uint8Array(N),
    S: p.S ,
  };
  const np = p.pml ;
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const c = j * nx + i;
      if ((p.bcX === 1 && (i < np || i > nx - 1 - np)) || (p.bcY === 1 && (j < np || j > ny - 1 - np))) m.pmlCell[c] = 1;
      const wallX = p.bcX !== 2 && (i === 0 || i === nx - 1);
      const wallY = p.bcY !== 2 && (j === 0 || j === ny - 1);
      if (wallX || wallY) {
        m.ca[c] = 0;
        m.cb[c] = 0;
        m.wall[c] = 1;
      }
      reclass(m, c);
    }
  const sx = Math.round(p.srcX );
  if (sx >= 0 && sx < nx) {
    if (p.srcLine === 1) {
      for (let j = 0; j < ny; j++) paintCell(m, j * nx + sx, "source", 1);
    } else {
      const sy = Math.round(p.srcY );
      if (sy >= 0 && sy < ny) paintCell(m, sy * nx + sx, "source", 1);
    }
  }
  return m;
}

/** Paint tools: pec, dielectric (value = eps_r), source (value = amplitude), erase. Boundary walls are skipped. */
export function paintCell(m               , c        , tool        , value        )       {
  if (m.wall[c]) return;
  if (tool === "pec") {
    m.ca[c] = 0;
    m.cb[c] = 0;
    m.src[c] = 0;
    m.epsr[c] = 1;
  } else if (tool === "dielectric") {
    if (!(value >= 1)) throw new Error("fdtd: dielectric eps_r must be >= 1");
    m.ca[c] = 1;
    m.cb[c] = m.S / value;
    m.epsr[c] = value;
  } else if (tool === "source") {
    if (m.cb[c] === 0) return; // never on PEC
    m.src[c] = value;
  } else if (tool === "erase") {
    m.ca[c] = 1;
    m.cb[c] = m.S;
    m.epsr[c] = 1;
    m.src[c] = 0;
  } else throw new Error(`fdtd: unknown paint tool ${tool}`);
  reclass(m, c);
}

/** Source waveform at time t (s). */
export function waveform(p                        , t        )         {
  const f = p.freq ;
  const A = p.srcAmp ;
  if (p.srcType === 1) {
    const t0 = 1.5 / f;
    const a = Math.PI * f * (t - t0);
    return A * (1 - 2 * a * a) * Math.exp(-a * a);
  }
  const Tr = p.ramp  / f;
  const r = t >= Tr || Tr <= 0 ? 1 : 0.5 * (1 - Math.cos((Math.PI * t) / Tr));
  return A * r * Math.sin(2 * Math.PI * f * t);
}

/** Analytic Yee dispersion: angular frequency for wave vector (kx, ky), rad/s. */
export function yeeOmega(kx        , ky        , dx        , S        )         {
  const dt = (S * dx) / C0;
  const s = S * Math.sqrt(Math.sin((kx * dx) / 2) ** 2 + Math.sin((ky * dx) / 2) ** 2);
  return (2 / dt) * Math.asin(Math.min(1, s));
}
