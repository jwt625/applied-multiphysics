// SPDX-License-Identifier: GPL-3.0-or-later
// TS port of the eight exact-field closed forms of validation/a/fields.py (lane L7a; Python is the reference,
// cross-checked by packages/eval/bench/fields-crosscheck.ts). Formula sources as cited in the Python generators:
// Kirsch 1898 / Barber sec. 8.4 (gen_solid.kirsch_field), Kovasznay 1948 and planar Poiseuille (gen_misc),
// Smythe / Jackson loop field with complete elliptic integrals (gen_em.loop_field), rigid-sphere partial-wave
// series (gen_misc.ac03_pressure), Danckwerts axial-dispersion reactor (gen_misc.danckwerts_profile),
// Debye-Hueckel + Stokes electro-osmotic slit (gen_misc.eof_profile), Bohren-Huffman Mie near field, eqs. 4.37-4.52
// (gen_optics.mie_field). Same algorithms and term counts as the Python code.

import {
  abs, add, c, ccos, cexp, csin, div, ellipKE, EPS0, ipow, K_B, legendre, mul, MU0, N_A, pyRound, Q_E, scale,
  sphDeriv, sphJ, sphY, sub, type C,
} from './special.ts';

// ---------------------------------------------------------------- SM-01 Kirsch
export function kirsch(x: number, y: number, a: number, sInf: number, E: number, nu: number, plane: 'stress' | 'strain' = 'stress') {
  const r = Math.hypot(x, y), th = Math.atan2(y, x);
  const q = (a / r) ** 2;
  const c2 = Math.cos(2 * th), s2 = Math.sin(2 * th);
  const h = sInf / 2;
  const srr = h * (1 - q) + h * (1 - 4 * q + 3 * q * q) * c2;
  const stt = h * (1 + q) - h * (1 + 3 * q * q) * c2;
  const srt = -h * (1 + 2 * q - 3 * q * q) * s2;
  const mu = E / (2 * (1 + nu));
  const kap = plane === 'stress' ? (3 - nu) / (1 + nu) : 3 - 4 * nu;
  const ur = (sInf / (4 * mu)) * (r * ((kap - 1) / 2 + c2) + ((a * a) / r) * (1 + (1 + kap) * c2) - (a ** 4 / r ** 3) * c2);
  const ut = (sInf / (4 * mu)) * (((1 - kap) * a * a) / r - r - a ** 4 / r ** 3) * s2;
  const cs = Math.cos(th), sn = Math.sin(th);
  return {
    sxx: srr * cs * cs + stt * sn * sn - 2 * srt * sn * cs,
    syy: srr * sn * sn + stt * cs * cs + 2 * srt * sn * cs,
    sxy: (srr - stt) * sn * cs + srt * (cs * cs - sn * sn),
    ux: ur * cs - ut * sn,
    uy: ur * sn + ut * cs,
  };
}

// ---------------------------------------------------------------- FL-01 Kovasznay, planar Poiseuille
export function kovasznay(x: number, y: number, Re: number, domain: [[number, number], [number, number]]) {
  const lam = Re / 2 - Math.sqrt((Re * Re) / 4 + 4 * Math.PI ** 2);
  const e = Math.exp(lam * x);
  const [x0, x1] = domain[0];
  const meanE2 = (Math.exp(2 * lam * x1) - Math.exp(2 * lam * x0)) / (2 * lam * (x1 - x0));
  return { u: 1 - e * Math.cos(2 * Math.PI * y), v: (lam / (2 * Math.PI)) * e * Math.sin(2 * Math.PI * y), p: 0.5 * (1 - e * e) - 0.5 * (1 - meanE2) };
}

export function poiseuille(x: number, y: number, mu: number) {
  return { u: 4 * y * (1 - y), v: 0 * y, p: 8 * mu * (1 - x) };
}

// ---------------------------------------------------------------- EM-04 Helmholtz pair
export function loopField(rho: number, z: number, R: number, z0: number, I: number): { Br: number; Bz: number } {
  const dz = z - z0;
  const s = (R + rho) ** 2 + dz * dz;
  const m = (4 * R * rho) / s;
  const { K, E, KmE } = ellipKE(m);
  const d = (R - rho) ** 2 + dz * dz;
  const pref = (MU0 * I) / (2 * Math.PI * Math.sqrt(s));
  const Bz = pref * (K + ((R * R - rho * rho - dz * dz) / d) * E);
  // -K + (R^2 + rho^2 + dz^2)/d E = -(K - E) + (2 R rho / d) E: same expression as gen_em.loop_field, rewritten to
  // avoid the K - E cancellation near the axis
  const Br = rho > 0 ? ((pref * dz) / rho) * (-KmE + ((2 * R * rho) / d) * E) : 0;
  return { Br, Bz };
}

export function helmholtz(rho: number, z: number, R: number, I: number, N: number): { B_rho: number; B_z: number } {
  const a = loopField(rho, z, R, -R / 2, I * N), b = loopField(rho, z, R, R / 2, I * N);
  return { B_rho: a.Br + b.Br, B_z: a.Bz + b.Bz };
}

// ---------------------------------------------------------------- AC-03 rigid sphere, total pressure
export function ac03Nmax(ka: number): number { return Math.ceil(ka + 4 * ka ** (1 / 3) + 10); }

function rigidCoeffs(ka: number, nmax: number): C[] {
  const z = c(ka);
  const J = sphJ(nmax + 1, z);
  const Y = sphY(nmax + 1, ka).map((v) => c(v));
  const out: C[] = [];
  for (let n = 0; n <= nmax; n++) {
    const jp = sphDeriv(J, z, n);
    const yp = sphDeriv(Y, z, n);
    out.push(div(jp, add(jp, mul(c(0, 1), yp))));
  }
  return out;
}

export function ac03Pressure(r: number, theta: number, ka: number, a: number, p0: number, nmaxIn?: number): C {
  const nmax = nmaxIn ?? ac03Nmax(ka) + 10;
  const k = ka / a;
  const A = rigidCoeffs(ka, nmax);
  const kr = k * r;
  const J = sphJ(nmax, c(kr)), Y = sphY(nmax, kr);
  const P = legendre(nmax, Math.cos(theta));
  let p = c(0);
  for (let n = 0; n <= nmax; n++) {
    const hn = add(J[n]!, c(0, Y[n]!));
    const term = scale(mul(ipow(n), sub(J[n]!, mul(A[n]!, hn))), p0 * (2 * n + 1) * P[n]!);
    p = add(p, term);
  }
  return p;
}

// ---------------------------------------------------------------- TR-01 Danckwerts reactor
export function danckwerts(x: number, L: number, u: number, D: number, k: number, C0 = 1): number {
  // Python solves the same 2x2 system in mpmath (40 digits); here in double precision.
  const s = Math.sqrt(u * u + 4 * k * D);
  const r1 = (u + s) / (2 * D), r2 = (u - s) / (2 * D);
  const m00 = (u - D * r1) * Math.exp(-r1 * L), m01 = u - D * r2, m10 = r1, m11 = r2 * Math.exp(r2 * L);
  const det = m00 * m11 - m01 * m10;
  const A = (u * C0 * m11) / det, B = (-m10 * u * C0) / det;
  return A * Math.exp(r1 * (x - L)) + B * Math.exp(r2 * x);
}

// ---------------------------------------------------------------- CP-05 electro-osmotic slit
export interface EofParams { eps_r: number; zeta_V: number; E_V_m: number; eta_Pa_s: number; c0_mol_m3: number; T_K: number; h_m: number }
export function debyeLength(epsR: number, c0: number, T: number, zv = 1): number {
  return Math.sqrt((epsR * EPS0 * K_B * T) / (2 * N_A * c0 * (zv * Q_E) ** 2));
}
export function eofProfile(y: number, p: EofParams): number {
  const lD = debyeLength(p.eps_r, p.c0_mol_m3, p.T_K);
  const uhs = (-p.eps_r * EPS0 * p.zeta_V * p.E_V_m) / p.eta_Pa_s;
  return uhs * (1 - Math.cosh(y / lD) / Math.cosh(p.h_m / lD));
}

// ---------------------------------------------------------------- WO-03 Mie near field
function mieAB(m: C, x: number, nmax: number): { a: C[]; b: C[] } {
  const mx = scale(m, x);
  const nmx = pyRound(Math.max(nmax, abs(mx)) + 16);
  const D: C[] = new Array(nmx + 1).fill(c(0));
  for (let n = nmx; n >= 1; n--) {
    const nmxr = div(c(n), mx);
    D[n - 1] = sub(nmxr, div(c(1), add(D[n]!, nmxr)));
  }
  const J = sphJ(nmax, c(x)).map((v) => v.re), Y = sphY(nmax, x);
  const psi = J.map((j) => x * j), chi = Y.map((y) => -x * y);
  const xi = psi.map((p, i) => c(p, -chi[i]!));
  const a: C[] = [], b: C[] = [];
  for (let n = 1; n <= nmax; n++) {
    const Dn = D[n]!;
    const ta = add(div(Dn, m), c(n / x));
    a.push(div(sub(scale(ta, psi[n]!), c(psi[n - 1]!)), sub(mul(ta, xi[n]!), xi[n - 1]!)));
    const tb = add(mul(m, Dn), c(n / x));
    b.push(div(sub(scale(tb, psi[n]!), c(psi[n - 1]!)), sub(mul(tb, xi[n]!), xi[n - 1]!)));
  }
  return { a, b };
}

/** z_n and [rho z_n]'/rho = z_n / z + z_n' for j (complex z) or h^(1) (real z). */
function sphPair(nmax: number, z: C, kind: 'j' | 'h'): { zn: C[]; dz: C[] } {
  const J = sphJ(nmax + 1, z);
  let F = J;
  if (kind === 'h') {
    const Y = sphY(nmax + 1, z.re);
    F = J.map((j, i) => add(j, c(0, Y[i]!)));
  }
  const zn: C[] = [], dz: C[] = [];
  for (let n = 0; n <= nmax; n++) {
    zn.push(F[n]!);
    dz.push(add(div(F[n]!, z), sphDeriv(F, z, n)));
  }
  return { zn, dz };
}

function mieCD(m: C, x: number, nmax: number): { cc: C[]; d: C[] } {
  const jx = sphPair(nmax, c(x), 'j'), hx = sphPair(nmax, c(x), 'h'), jm = sphPair(nmax, scale(m, x), 'j');
  const cc: C[] = [], d: C[] = [];
  const mx = scale(m, x);
  for (let n = 1; n <= nmax; n++) {
    const xjxp = scale(jx.dz[n]!, x), xhxp = scale(hx.dz[n]!, x), mxjmp = mul(mx, jm.dz[n]!);
    const J = jx.zn[n]!, H = hx.zn[n]!, Jm = jm.zn[n]!;
    cc.push(div(sub(mul(J, xhxp), mul(H, xjxp)), sub(mul(Jm, xhxp), mul(H, mxjmp))));
    d.push(div(sub(mul(m, mul(J, xhxp)), mul(m, mul(H, xjxp))), sub(mul(mul(m, m), mul(Jm, xhxp)), mul(H, mxjmp))));
  }
  return { cc, d };
}

/** Total complex E (units of E0) at one Cartesian point; x-polarized plane wave along +z; sphere at the origin. */
export function mieFieldPoint(pt: [number, number, number], ctx: MieContext): [C, C, C] {
  const { k, radius, m, nmax, a, b, cc, d } = ctx;
  const [X, Y, Z] = pt;
  let r = Math.sqrt(X * X + Y * Y + Z * Z);
  if (r === 0) r = 1e-30 * radius;
  const th = Math.acos(Math.min(1, Math.max(-1, Z / r)));
  const ph = Math.atan2(Y, X);
  const mu = Math.cos(th);
  const pi = new Array(nmax + 1).fill(0), tau = new Array(nmax + 1).fill(0);
  pi[1] = 1;
  if (nmax >= 2) pi[2] = 3 * mu;
  for (let n = 3; n <= nmax; n++) pi[n] = ((2 * n - 1) / (n - 1)) * mu * pi[n - 1] - (n / (n - 1)) * pi[n - 2];
  for (let n = 1; n <= nmax; n++) tau[n] = n * mu * pi[n] - (n + 1) * pi[n - 1];
  const inside = r < radius;
  const cp = Math.cos(ph), sp = Math.sin(ph), st = Math.sin(th);
  let Er = c(0), Et = c(0), Ep = c(0);
  const rho = inside ? scale(m, k * r) : c(k * r);
  const rad = sphPair(nmax, rho, inside ? 'j' : 'h');
  for (let n = 1; n <= nmax; n++) {
    const En = scale(ipow(n), (2 * n + 1) / (n * (n + 1)));
    const zn = rad.zn[n]!, dzn = rad.dz[n]!;
    const M = [c(0), scale(zn, cp * pi[n]), scale(zn, -sp * tau[n])];
    const N = [scale(div(zn, rho), cp * n * (n + 1) * st * pi[n]), scale(dzn, cp * tau[n]), scale(dzn, -sp * pi[n])];
    for (let q = 0; q < 3; q++) {
      const term = inside
        ? mul(En, sub(mul(cc[n - 1]!, M[q]!), mul(c(0, 1), mul(d[n - 1]!, N[q]!))))
        : mul(En, sub(mul(c(0, 1), mul(a[n - 1]!, N[q]!)), mul(b[n - 1]!, M[q]!)));
      if (q === 0) Er = add(Er, term); else if (q === 1) Et = add(Et, term); else Ep = add(Ep, term);
    }
  }
  const ct = Math.cos(th);
  let Ex = sub(add(scale(Er, st * cp), scale(Et, ct * cp)), scale(Ep, sp));
  const Ey = add(add(scale(Er, st * sp), scale(Et, ct * sp)), scale(Ep, cp));
  const Ez = sub(scale(Er, ct), scale(Et, st));
  if (!inside) Ex = add(Ex, cexp(c(0, k * Z)));
  return [Ex, Ey, Ez];
}

export interface MieContext { k: number; radius: number; m: C; nmax: number; a: C[]; b: C[]; cc: C[]; d: C[] }
export function mieContext(radius: number, wavelength: number, m: C, nMedium = 1, nmaxIn?: number): MieContext {
  const k = (2 * Math.PI * nMedium) / wavelength;
  const x = k * radius;
  const nmax = nmaxIn ?? pyRound(x + 4.05 * x ** (1 / 3) + 2) + 10;
  const { a, b } = mieAB(m, x, nmax);
  const { cc, d } = mieCD(m, x, nmax);
  return { k, radius, m, nmax, a, b, cc, d };
}

export { csin, ccos };
