// SPDX-License-Identifier: GPL-3.0-or-later
// Signal and pattern analysis used by the eval gates (Node and browser).

/**
 * Upward zero crossings of (x - mean) after index `from`, linearly interpolated, in sample units.
 * With hysteresis h > 0 (Schmitt trigger) a crossing is counted only after the signal has been below -h since the
 * previous crossing, so small high-frequency noise cannot create extra crossings (audit follow-up 2026-11-06).
 */
export function upCrossings(x: ArrayLike<number>, from = 0, to = x.length, h = 0): number[] {
  let m = 0;
  for (let i = from; i < to; i++) m += x[i]!;
  m /= Math.max(1, to - from);
  const out: number[] = [];
  let armed = x[from]! - m < -h;
  for (let i = from + 1; i < to; i++) {
    const a = x[i - 1]! - m;
    const b = x[i]! - m;
    if (b < -h) armed = true;
    if (armed && a < 0 && b >= 0) {
      out.push(i - 1 + a / (a - b));
      armed = false;
    }
  }
  return out;
}

/** RMS of (x - mean) over [from, to). */
export function rms(x: ArrayLike<number>, from = 0, to = x.length): number {
  let m = 0;
  for (let i = from; i < to; i++) m += x[i]!;
  m /= Math.max(1, to - from);
  let s = 0;
  for (let i = from; i < to; i++) s += (x[i]! - m) ** 2;
  return Math.sqrt(s / Math.max(1, to - from));
}

/**
 * Mean period (samples) from the last `periods` upward zero crossings in [from, to); NaN if not enough crossings.
 * Hysteresis = hystFrac x RMS of the window (default 0.25).
 */
export function meanPeriod(x: ArrayLike<number>, from: number, to: number, periods: number, hystFrac = 0.25): number {
  const c = upCrossings(x, from, to, hystFrac * rms(x, from, to));
  if (c.length < periods + 1) return NaN;
  const a = c[c.length - 1 - periods]!;
  const b = c[c.length - 1]!;
  return (b - a) / periods;
}

/** Discrete harmonic sequence: least-squares cos(theta) from x[n+1] + x[n-1] = 2 cos(theta) x[n]. Returns theta. */
export function recurrenceTheta(x: ArrayLike<number>, from = 1): number {
  let num = 0;
  let den = 0;
  for (let n = Math.max(1, from); n < x.length - 1; n++) {
    num += x[n]! * (x[n + 1]! + x[n - 1]!);
    den += 2 * x[n]! * x[n]!;
  }
  return Math.acos(Math.max(-1, Math.min(1, num / den)));
}

/** |DFT| of a Hann-windowed signal at normalized frequency nu (cycles per sample). */
export function dftMag(x: ArrayLike<number>, nu: number): number {
  const n = x.length;
  let re = 0;
  let im = 0;
  for (let k = 0; k < n; k++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * k) / (n - 1));
    const a = -2 * Math.PI * nu * k;
    re += w * x[k]! * Math.cos(a);
    im += w * x[k]! * Math.sin(a);
  }
  return Math.hypot(re, im);
}

/** Peak of the Hann-windowed spectrum in [lo, hi] (cycles per sample): coarse scan, then golden-section refine. */
export function spectralPeak(x: ArrayLike<number>, lo: number, hi: number, scan = 400): number {
  let best = lo;
  let bv = -1;
  for (let i = 0; i <= scan; i++) {
    const nu = lo + ((hi - lo) * i) / scan;
    const v = dftMag(x, nu);
    if (v > bv) {
      bv = v;
      best = nu;
    }
  }
  const h = (hi - lo) / scan;
  let a = best - h;
  let b = best + h;
  const g = (Math.sqrt(5) - 1) / 2;
  let c = b - g * (b - a);
  let d = a + g * (b - a);
  let fc = dftMag(x, c);
  let fd = dftMag(x, d);
  for (let it = 0; it < 60; it++) {
    if (fc > fd) {
      b = d;
      d = c;
      fd = fc;
      c = b - g * (b - a);
      fc = dftMag(x, c);
    } else {
      a = c;
      c = d;
      fc = fd;
      d = a + g * (b - a);
      fd = dftMag(x, d);
    }
  }
  return 0.5 * (a + b);
}

export interface PatternStats {
  components: number;
  foregroundFrac: number;
  largestFrac: number;
  medianQ: number;
  cls: "spots" | "stripes/maze" | "mixed";
}

/**
 * Pattern class of a periodic 2D field (DevLog-005 gate 7, rule fixed before running):
 * foreground = v > (min + max) / 2; periodic 4-connected components; Q = 4 pi A / P^2 with P = exposed cell edges.
 * spots: components >= 10 and median Q >= 0.5. stripes/maze: largest component >= 50 % of foreground or median Q < 0.3.
 */
export function patternClass(v: ArrayLike<number>, nx: number, ny: number): PatternStats {
  const N = nx * ny;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < N; i++) {
    lo = Math.min(lo, v[i]!);
    hi = Math.max(hi, v[i]!);
  }
  const th = 0.5 * (lo + hi);
  const fg = new Uint8Array(N);
  let nfg = 0;
  for (let i = 0; i < N; i++)
    if (v[i]! > th) {
      fg[i] = 1;
      nfg++;
    }
  const lab = new Int32Array(N).fill(-1);
  const areas: number[] = [];
  const perims: number[] = [];
  const stack: number[] = [];
  for (let s = 0; s < N; s++) {
    if (!fg[s] || lab[s] !== -1) continue;
    const id = areas.length;
    let A = 0;
    let P = 0;
    lab[s] = id;
    stack.push(s);
    while (stack.length) {
      const c = stack.pop()!;
      A++;
      const x = c % nx;
      const y = (c - x) / nx;
      const nb = [y * nx + ((x + 1) % nx), y * nx + ((x - 1 + nx) % nx), ((y + 1) % ny) * nx + x, ((y - 1 + ny) % ny) * nx + x];
      for (const q of nb) {
        if (!fg[q]) {
          P++;
          continue;
        }
        if (lab[q] === -1) {
          lab[q] = id;
          stack.push(q);
        }
      }
    }
    areas.push(A);
    perims.push(P);
  }
  const Q = areas.map((A, i) => (perims[i]! > 0 ? (4 * Math.PI * A) / (perims[i]! * perims[i]!) : 1)).sort((a, b) => a - b);
  const medianQ = Q.length ? Q[Math.floor(Q.length / 2)]! : NaN;
  const largest = areas.length ? Math.max(...areas) : 0;
  const largestFrac = nfg > 0 ? largest / nfg : 0;
  const components = areas.length;
  let cls: PatternStats["cls"] = "mixed";
  if (components >= 10 && medianQ >= 0.5) cls = "spots";
  else if (largestFrac >= 0.5 || medianQ < 0.3) cls = "stripes/maze";
  return { components, foregroundFrac: nfg / N, largestFrac, medianQ, cls };
}
