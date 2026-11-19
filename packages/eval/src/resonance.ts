// SPDX-License-Identifier: GPL-3.0-or-later
// Resonance search over a frequency or wavelength axis (DevLog-061): locate a peak or dip of a per-step scalar by
// re-solving at chosen points, with sub-step refinement, and report centre, width and Q by two width estimates.
//
// Method. Peak function p(x) = y (peak) or baseline - y (dip), y = scalar^power. A Lorentzian
// p = A / (1 + ((x - x0) / g)^2) has 1 / p = (1 + ((x - x0) / g)^2) / A, exactly quadratic in x, so a least-squares
// quadratic fit of 1 / p gives x0, g and A in closed form (no nonlinear solver).
//  1. coarse scan: n points evenly over the window (one study run); the largest p must be inside the window;
//  2. start from the exact quadratic through 1 / p of the three samples around the largest p;
//  3. iterate: 5 new samples at x0 + g {-1, -1/2, 0, 1/2, 1}, refit on that batch only, until the centre moves by at
//     most tol * FWHM and g by at most tol * g (FWHM = 2 g);
//  4. half-maximum width without a line-shape model: p_pk = p(x0); each crossing p = p_pk / 2 by the secant method,
//     started from x0 -+ g and x0 -+ 1.1 g, until the step is below tol * g.
// Error: for an exact Lorentzian in x the fit is exact up to round-off; a Lorentzian in frequency read on a
// wavelength axis (or the reverse) deviates by O(1 / Q) in the width; a background or a neighbouring line shows in
// the fit residual and in the difference between the fit and half-maximum widths (both reported).

export interface ResonanceDef {
  /** sample points of the coarse scan (>= 5) */
  scan: number;
  /** search window on the axis, in the window unit */
  window: [number, number];
  shape: 'peak' | 'dip';
  /** dip: level the dip is measured from (default 1, a power transmission) */
  baseline: number;
  /** relative convergence tolerance (of FWHM for the centre, of g for the width) */
  tol: number;
  maxIter: number;
}

export interface ResonanceResult {
  center: number; fwhm: number; q: number; peak: number;
  center_halfmax: number; fwhm_halfmax: number; q_halfmax: number;
  diag: { solves: number; iterations: number; shift_over_fwhm: number; fit_residual: number; halfmax_iterations: number; halfmax_step_over_g: number };
}

/** y values of the scalar (already raised to its power) at the given axis points, one study run per call. */
export type BatchEval = (xs: number[]) => Promise<number[]>;

/**
 * 'dip' gate (DevLog-066): largest |fit(x) p(x) - 1| over the last refinement batch above which a dip is an error. A
 * wrong baseline adds a constant to p = baseline - y and bends 1 / p away from a quadratic; the observed residual of the
 * WO-73 peaks is 0.9e-3 to 1.2e-3 (logs/eval-20261118T185253.jsonl), and test/resonance.test.ts (DevLog-066 case) gives
 * the residual of a baseline offset (DevLog-066 s.4).
 */
export const DIP_FIT_RESIDUAL_MAX = 3e-3;

export const RESONANCE_OUTPUTS = ['center', 'fwhm', 'q', 'peak', 'center_halfmax', 'fwhm_halfmax', 'q_halfmax'] as const;
export type ResonanceOutput = (typeof RESONANCE_OUTPUTS)[number];

/** Least-squares quadratic 1 / p = a t^2 + b t + c on t = (x - xc) / s; returns the Lorentzian x0, g, A or why not. */
export function lorentzFit(xs: number[], ps: number[], xc: number, s: number): { x0: number; g: number; A: number; residual: number } | { error: string } {
  if (xs.length < 3) return { error: 'Lorentzian fit needs at least 3 points' };
  if (ps.some((p) => !(p > 0) || !Number.isFinite(p))) return { error: `peak function not positive at every fit point (${ps.map((p) => p.toPrecision(4)).join(', ')})` };
  const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], r = [0, 0, 0];
  const ts = xs.map((x) => (x - xc) / s);
  for (let i = 0; i < xs.length; i++) {
    const row = [ts[i]! * ts[i]!, ts[i]!, 1], y = 1 / ps[i]!;
    for (let a = 0; a < 3; a++) { r[a]! += row[a]! * y; for (let b = 0; b < 3; b++) M[a]![b]! += row[a]! * row[b]!; }
  }
  const sol = solve3(M, r);
  if (!sol) return { error: 'Lorentzian fit: singular normal equations (repeated points)' };
  const [a, b, c] = sol;
  if (!(a > 0)) return { error: `Lorentzian fit: 1 / p is not convex (a = ${a.toPrecision(3)}); no peak in these points` };
  const invA = c - (b * b) / (4 * a);
  if (!(invA > 0)) return { error: 'Lorentzian fit: negative peak height' };
  const t0 = -b / (2 * a), gt = Math.sqrt(invA / a);
  const residual = Math.max(...ts.map((t, i) => Math.abs((a * t * t + b * t + c) * ps[i]! - 1)));
  return { x0: xc + s * t0, g: s * gt, A: 1 / invA, residual };
}

function solve3(A: number[][], b: number[]): [number, number, number] | null {
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let k = 0; k < 3; k++) {
    let p = k;
    for (let i = k + 1; i < 3; i++) if (Math.abs(M[i]![k]!) > Math.abs(M[p]![k]!)) p = i;
    if (Math.abs(M[p]![k]!) === 0) return null;
    [M[k], M[p]] = [M[p]!, M[k]!];
    for (let i = k + 1; i < 3; i++) { const f = M[i]![k]! / M[k]![k]!; for (let j = k; j < 4; j++) M[i]![j]! -= f * M[k]![j]!; }
  }
  const x = [0, 0, 0];
  for (let i = 2; i >= 0; i--) { let s = M[i]![3]!; for (let j = i + 1; j < 3; j++) s -= M[i]![j]! * x[j]!; x[i] = s / M[i]![i]!; }
  return x.every(Number.isFinite) ? (x as [number, number, number]) : null;
}

export async function findResonance(evalY: BatchEval, d: ResonanceDef): Promise<ResonanceResult | { error: string }> {
  const [lo, hi] = d.window;
  if (!(hi > lo)) return { error: `window [${lo}, ${hi}] is empty` };
  if (!(d.scan >= 5)) return { error: 'scan needs at least 5 points' };
  let solves = 0;
  // sample points stay inside the window and at x > 0 (wavelengths and frequencies; DevLog-066)
  const xMin = Math.max(lo, hi * 1e-12), clampX = (x: number) => Math.min(hi, Math.max(xMin, x));
  const pOf = (y: number) => (d.shape === 'peak' ? y : d.baseline - y);
  const run = async (xs: number[]) => {   // xs clamped to the window
    xs = xs.map(clampX);
    const ys = await evalY(xs);
    solves += xs.length;
    if (ys.length !== xs.length || ys.some((y) => !Number.isFinite(y))) throw new Error(`non-finite scalar in the resonance search at ${xs.map((x) => x.toPrecision(8)).join(', ')}`);
    return { ys, ps: ys.map(pOf) };
  };
  try {
    // 1. coarse scan
    const xs0 = Array.from({ length: d.scan }, (_, i) => lo + ((hi - lo) * i) / (d.scan - 1));
    const s0 = await run(xs0);
    let k = 0;
    for (let i = 1; i < xs0.length; i++) if (s0.ps[i]! > s0.ps[k]!) k = i;
    if (k === 0 || k === xs0.length - 1) return { error: `${d.shape === 'peak' ? 'largest value' : 'deepest value'} at the window edge (${xs0[k]!.toPrecision(8)}): widen or move the window` };
    const step = (hi - lo) / (d.scan - 1);
    // 2. start: exact quadratic through 1 / p of the three samples around the extreme
    const f0 = lorentzFit(xs0.slice(k - 1, k + 2), s0.ps.slice(k - 1, k + 2), xs0[k]!, step);
    let x0 = 'error' in f0 ? xs0[k]! : f0.x0, g = 'error' in f0 ? step : f0.g;
    if (!(x0 > lo && x0 < hi)) { x0 = xs0[k]!; g = step; }
    // 3. Lorentzian refinement on local batches
    let it = 0, shift = Infinity, residual = NaN, converged = false;
    const T = [-1, -0.5, 0, 0.5, 1];
    for (; it < d.maxIter; it++) {
      // half-span: g, shortened so the 5 points stay inside the window (distinct points for the fit)
      const h = Math.min(g, x0 - xMin, hi - x0);
      const xs = T.map((t) => x0 + t * h);
      const b = await run(xs);
      const f = lorentzFit(xs, b.ps, x0, h);
      if ('error' in f) return { error: `refinement step ${it + 1}: ${f.error}` };
      shift = Math.abs(f.x0 - x0) / (2 * f.g);
      const dg = Math.abs(f.g - g) / f.g;
      x0 = f.x0; g = f.g; residual = f.residual;
      if (!(x0 > lo && x0 < hi)) return { error: `refined centre ${x0.toPrecision(8)} left the window` };
      if (shift <= d.tol && dg <= d.tol) { converged = true; it++; break; }
    }
    if (!converged) return { error: `Lorentzian refinement not converged in ${d.maxIter} steps (last centre change ${shift.toExponential(2)} FWHM)` };
    if (d.shape === 'dip' && !(residual <= DIP_FIT_RESIDUAL_MAX))
      return { error: `dip: Lorentzian fit residual ${residual.toExponential(2)} > ${DIP_FIT_RESIDUAL_MAX} (baseline ${d.baseline} not the off-resonance level, or not a single Lorentzian dip)` };
    if (x0 - 1.1 * g < xMin || x0 + 1.1 * g > hi) return { error: `the half-maximum points x0 +- 1.1 g (${(x0 - 1.1 * g).toPrecision(8)}, ${(x0 + 1.1 * g).toPrecision(8)}) leave the window: widen it` };
    // 4. half-maximum crossings by the secant method (both sides per run)
    const hb = await run([x0, x0 - g, x0 + g, x0 - 1.1 * g, x0 + 1.1 * g]);
    const yPk = hb.ys[0]!, half = hb.ps[0]! / 2;
    const side = [
      { a: x0 - g, fa: hb.ps[1]! - half, b: x0 - 1.1 * g, fb: hb.ps[3]! - half },
      { a: x0 + g, fa: hb.ps[2]! - half, b: x0 + 1.1 * g, fb: hb.ps[4]! - half },
    ];
    let hit = 0, last = Infinity;
    for (; hit < 8; hit++) {
      const nx = side.map((s) => clampX(s.fb === s.fa ? s.b : s.b - (s.fb * (s.b - s.a)) / (s.fb - s.fa)));
      last = Math.max(...nx.map((x, i) => Math.abs(x - side[i]!.b))) / g;
      if (last <= d.tol) { side.forEach((s, i) => { s.b = nx[i]!; }); hit++; break; }
      const r = await run(nx);
      side.forEach((s, i) => { s.a = s.b; s.fa = s.fb; s.b = nx[i]!; s.fb = r.ps[i]! - half; });
    }
    if (last > d.tol) return { error: `half-maximum crossings not converged in 8 secant steps (last step ${last.toExponential(2)} g)` };
    const [xl, xr] = [side[0]!.b, side[1]!.b];
    if (!(xl > xMin && xr < hi)) return { error: `half-maximum crossings ${xl.toPrecision(8)}, ${xr.toPrecision(8)} at or beyond the window [${lo}, ${hi}]: widen it` };
    if (!(xl < x0 && xr > x0)) return { error: `half-maximum crossings ${xl.toPrecision(8)}, ${xr.toPrecision(8)} do not bracket the centre` };
    const fwhm = 2 * g, fw2 = xr - xl, c2 = (xl + xr) / 2;
    return {
      center: x0, fwhm, q: x0 / fwhm, peak: yPk, center_halfmax: c2, fwhm_halfmax: fw2, q_halfmax: c2 / fw2,
      diag: { solves, iterations: it, shift_over_fwhm: shift, fit_residual: residual, halfmax_iterations: hit, halfmax_step_over_g: last },
    };
  } catch (e) { return { error: (e as Error).message }; }
}
