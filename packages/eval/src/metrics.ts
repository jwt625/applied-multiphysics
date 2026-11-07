// SPDX-License-Identifier: GPL-3.0-or-later
// Accuracy metrics: error vs tolerance (budget next to the measured difference), field errors at sample points,
// convergence-rate fit, observed order and Richardson extrapolation with GCI (Roache 1994; Celik et al. 2008,
// J. Fluids Eng. 130:078001, eqs. 1-5), eigenvalue matching with multiplicity.
// Idea sources (read-only): advanced-packaging-atlas validation/reference/apref/{convergence,compare}.py.

export interface ToleranceSpec { rel?: number; abs?: number }

export interface ScalarCheck {
  value: number;
  ref: number;
  diff: number;           // value - ref
  abs_err: number;
  rel_err: number;        // |diff| / |ref|; Infinity when ref = 0 and diff != 0; 0 when both 0
  limit: number;          // allowed |diff|: rel*|ref|, abs, or max(abs, rel*|ref|) when both are given
  limit_basis: 'rel' | 'abs' | 'max(abs,rel)';
  pass: boolean;
}

export function toleranceLimit(ref: number, tol: ToleranceSpec): { limit: number; basis: ScalarCheck['limit_basis'] } {
  const hasRel = tol.rel !== undefined, hasAbs = tol.abs !== undefined;
  if (!hasRel && !hasAbs) throw new Error('tolerance needs rel or abs');
  if (hasRel && hasAbs) return { limit: Math.max(tol.abs!, tol.rel! * Math.abs(ref)), basis: 'max(abs,rel)' };
  if (hasRel) return { limit: tol.rel! * Math.abs(ref), basis: 'rel' };
  return { limit: tol.abs!, basis: 'abs' };
}

export function checkScalar(value: number, ref: number, tol: ToleranceSpec): ScalarCheck {
  const diff = value - ref;
  const abs_err = Math.abs(diff);
  const rel_err = ref !== 0 ? abs_err / Math.abs(ref) : abs_err === 0 ? 0 : Infinity;
  const { limit, basis } = toleranceLimit(ref, tol);
  return { value, ref, diff, abs_err, rel_err, limit, limit_basis: basis, pass: Number.isFinite(value) && abs_err <= limit };
}

// ---------------------------------------------------------------------------------------------------------------
// Field error at sample points

export interface FieldError {
  n: number;              // finite sample pairs used
  n_dropped: number;      // pairs with a non-finite value (outside the mesh, void)
  l2_rel: number;         // ||a - b||_2 / ||b - offset||_2
  rms_abs: number;        // sqrt(mean (a - b)^2)
  max_abs: number;        // max |a - b|
  max_rel: number;        // max |a - b| / max |b - offset|
}

export function fieldError(a: ArrayLike<number>, b: ArrayLike<number>, offset = 0): FieldError {
  if (a.length !== b.length) throw new Error(`fieldError: ${a.length} values vs ${b.length} reference values`);
  let n = 0, s2 = 0, r2 = 0, mx = 0, rmx = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!, y = b[i]!;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const d = x - y;
    n++; s2 += d * d; r2 += (y - offset) * (y - offset);
    mx = Math.max(mx, Math.abs(d)); rmx = Math.max(rmx, Math.abs(y - offset));
  }
  const tiny = 1e-300;
  return {
    n, n_dropped: a.length - n,
    l2_rel: n ? Math.sqrt(s2) / Math.max(Math.sqrt(r2), tiny) : NaN,
    rms_abs: n ? Math.sqrt(s2 / n) : NaN,
    max_abs: n ? mx : NaN,
    max_rel: n ? mx / Math.max(rmx, tiny) : NaN,
  };
}

export function checkField(err: FieldError, tol: ToleranceSpec & { norm?: 'l2' | 'max' }): { metric: string; measured: number; limit: number; pass: boolean } {
  const norm = tol.norm ?? 'l2';
  if (tol.rel !== undefined) {
    const measured = norm === 'l2' ? err.l2_rel : err.max_rel;
    return { metric: `${norm}_rel`, measured, limit: tol.rel, pass: Number.isFinite(measured) && measured <= tol.rel };
  }
  if (tol.abs !== undefined) {
    const measured = norm === 'l2' ? err.rms_abs : err.max_abs;
    return { metric: norm === 'l2' ? 'rms_abs' : 'max_abs', measured, limit: tol.abs, pass: Number.isFinite(measured) && measured <= tol.abs };
  }
  throw new Error('field tolerance needs rel or abs');
}

// ---------------------------------------------------------------------------------------------------------------
// Convergence

export interface RateFit { rate: number; log_c: number; r2: number; n: number; pairwise: number[] }

/** Least-squares slope of ln(err) vs ln(h): err ~ C h^rate. Levels with err <= 0 or non-finite are dropped. */
export function convergenceRateFit(h: number[], err: number[]): RateFit {
  if (h.length !== err.length) throw new Error('convergenceRateFit: length mismatch');
  const xs: number[] = [], ys: number[] = [];
  for (let i = 0; i < h.length; i++) {
    const e = Math.abs(err[i]!);
    if (h[i]! > 0 && e > 0 && Number.isFinite(e)) { xs.push(Math.log(h[i]!)); ys.push(Math.log(e)); }
  }
  const n = xs.length;
  const pairwise: number[] = [];
  for (let i = 0; i + 1 < h.length; i++) {
    const e0 = Math.abs(err[i]!), e1 = Math.abs(err[i + 1]!);
    pairwise.push(e0 > 0 && e1 > 0 ? Math.log(e0 / e1) / Math.log(h[i]! / h[i + 1]!) : NaN);
  }
  if (n < 2) return { rate: NaN, log_c: NaN, r2: NaN, n, pairwise };
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxx += (xs[i]! - mx) ** 2; sxy += (xs[i]! - mx) * (ys[i]! - my); syy += (ys[i]! - my) ** 2; }
  const rate = sxy / sxx;
  const r2 = syy > 0 ? (sxy * sxy) / (sxx * syy) : 1;
  return { rate, log_c: my - rate * mx, r2, n, pairwise };
}

export interface ObservedOrder { p: number | null; reason?: 'too_few_levels' | 'oscillatory' | 'no_change' | 'not_converged'; iterations?: number }

/**
 * Observed order from the three finest levels (values f and sizes h ordered coarse -> fine, any ratios).
 * Celik et al. 2008 eqs. 3a-3c, fixed-point iteration for non-constant refinement ratio.
 */
export function observedOrder(f: number[], h: number[]): ObservedOrder {
  if (f.length < 3 || h.length !== f.length) return { p: null, reason: 'too_few_levels' };
  const f3 = f[f.length - 3]!, f2 = f[f.length - 2]!, f1 = f[f.length - 1]!;
  const h3 = h[h.length - 3]!, h2 = h[h.length - 2]!, h1 = h[h.length - 1]!;
  const r21 = h2 / h1, r32 = h3 / h2;
  const e21 = f2 - f1, e32 = f3 - f2;
  if (e21 === 0 || e32 === 0) return { p: null, reason: 'no_change' };
  const s = Math.sign(e32 / e21);
  if (s < 0) return { p: null, reason: 'oscillatory' };
  let p = Math.abs(Math.log(Math.abs(e32 / e21))) / Math.log(r21);
  for (let it = 1; it <= 500; it++) {
    const q = Math.log((r21 ** p - s) / (r32 ** p - s));
    const pn = Math.abs(Math.log(Math.abs(e32 / e21)) + q) / Math.log(r21);
    if (!Number.isFinite(pn)) return { p: null, reason: 'not_converged', iterations: it };
    if (Math.abs(pn - p) < 1e-12 * Math.max(1, Math.abs(p))) return { p: pn, iterations: it };
    p = pn;
  }
  return { p: null, reason: 'not_converged', iterations: 500 };
}

export interface Richardson {
  levels: number;
  p_obs: number | null;
  p_obs_reason?: string;
  p_used: number | null;
  f_fine: number;
  f_ext: number | null;
  r: number | null;            // h_{n-1} / h_n of the two finest levels
  rel_change_last: number | null;
  gci_fine: number | null;     // relative (Celik eq. 5), safety factor fs
  u_abs: number | null;        // gci_fine * |f_fine|: numerical uncertainty band of f_fine
  fs: number;
}

/**
 * Richardson extrapolation from the two finest levels with order p: observed from three levels when available,
 * else `assumedOrder`. Safety factor default 1.25 with an observed order (3+ levels), 3.0 with an assumed order
 * (Roache 1994 two-grid recommendation), unless given.
 */
export function richardson(f: number[], h: number[], opts: { assumedOrder?: number; fs?: number } = {}): Richardson {
  const n = f.length;
  const fFine = f[n - 1]!;
  const oo = observedOrder(f, h);
  const p = oo.p ?? opts.assumedOrder ?? null;
  const fs = opts.fs ?? (oo.p !== null ? 1.25 : 3.0);
  const base: Richardson = { levels: n, p_obs: oo.p, ...(oo.reason ? { p_obs_reason: oo.reason } : {}), p_used: p, f_fine: fFine, f_ext: null, r: null, rel_change_last: null, gci_fine: null, u_abs: null, fs };
  if (n < 2 || p === null) return base;
  const r = h[n - 2]! / h[n - 1]!;
  const rp = r ** p;
  const fExt = (rp * fFine - f[n - 2]!) / (rp - 1);
  const ea = fFine !== 0 ? Math.abs((fFine - f[n - 2]!) / fFine) : NaN;
  const gci = (fs * ea) / (rp - 1);
  return { ...base, f_ext: fExt, r, rel_change_last: ea, gci_fine: gci, u_abs: gci * Math.abs(fFine) };
}

/** Representative mesh size from DOF count (Celik eq. 1 with N = DOF): h = (1/N)^(1/d), up to a constant. */
export function hFromDof(dof: number, dim: number): number {
  return Math.pow(1 / dof, 1 / dim);
}

// ---------------------------------------------------------------------------------------------------------------
// Eigenvalue matching

export interface EigenPair { ref_index: number; ref: number; value: number; diff: number; rel_err: number; limit: number; pass: boolean }
export interface EigenMatch {
  pairs: EigenPair[];
  unmatched_refs: number[];     // reference indices with no computed partner
  groups: Array<{ ref: number; multiplicity: number; split_rel: number }>;  // degenerate reference groups
  n_computed: number;
  n_dropped: number;            // computed values under `floor`
  n_nonfinite: number;          // NaN / Inf computed values (fail the match, audit S1)
  pass: boolean;
}

/**
 * Match computed eigenvalues to a reference list that repeats degenerate values (multiplicity).
 * Both lists are sorted ascending. 'sorted': the k-th reference meets the (offset + k)-th computed value.
 * 'subsequence': order-preserving assignment of references to a subset of computed values, minimising the sum of
 * squared relative errors (dynamic programming), robust to spurious or extra computed modes.
 */
export function matchEigen(
  computed: ArrayLike<number>, reference: number[], tol: ToleranceSpec,
  opts: { offset?: number; floor?: number; match?: 'sorted' | 'subsequence'; degenerateRel?: number } = {},
): EigenMatch {
  const floor = opts.floor ?? -Infinity;
  const raw = Array.from(computed);
  const nonFinite = raw.filter((x) => !Number.isFinite(x)).length;
  const all = raw.filter((x) => Number.isFinite(x));
  const comp = all.filter((x) => Math.abs(x) >= floor).sort((a, b) => a - b);
  const order = reference.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const refs = order.map((o) => o.v);
  const m = refs.length, n = comp.length;
  const assign: Array<number | null> = new Array(m).fill(null);
  if ((opts.match ?? 'sorted') === 'sorted') {
    const off = opts.offset ?? 0;
    for (let k = 0; k < m; k++) if (off + k < n) assign[k] = off + k;
  } else {
    // Order-preserving alignment with skips on both sides (audit M11): minimise the number of unmatched references
    // first, then the sum of squared relative errors. dp[k][j] = best over refs[0..k), comp[0..j).
    const cost = (k: number, j: number) => { const d = (comp[j]! - refs[k]!) / (refs[k] !== 0 ? refs[k]! : 1); return d * d; };
    type Cell = { u: number; c: number; from: 0 | 1 | 2 };   // 0 = match, 1 = skip computed, 2 = skip reference
    const better = (a: Cell, b: Cell) => a.u < b.u || (a.u === b.u && a.c < b.c);
    const dp: Cell[][] = Array.from({ length: m + 1 }, () => new Array<Cell>(n + 1));
    for (let k = 0; k <= m; k++) for (let j = 0; j <= n; j++) {
      if (k === 0) { dp[0]![j] = { u: 0, c: 0, from: 1 }; continue; }
      let best: Cell = { u: dp[k - 1]![j]!.u + 1, c: dp[k - 1]![j]!.c, from: 2 };
      if (j > 0) {
        const sk: Cell = { u: dp[k]![j - 1]!.u, c: dp[k]![j - 1]!.c, from: 1 };
        if (better(sk, best)) best = sk;
        const mt: Cell = { u: dp[k - 1]![j - 1]!.u, c: dp[k - 1]![j - 1]!.c + cost(k - 1, j - 1), from: 0 };
        if (better(mt, best) || (mt.u === best.u && mt.c === best.c)) best = mt;
      }
      dp[k]![j] = best;
    }
    for (let k = m, j = n; k > 0;) {
      const f = dp[k]![j]!.from;
      if (f === 0) { assign[k - 1] = j - 1; k--; j--; } else if (f === 1) j--; else k--;
    }
  }
  const pairs: EigenPair[] = [];
  const unmatched: number[] = [];
  for (let k = 0; k < m; k++) {
    const a = assign[k];
    if (a === null || a === undefined) { unmatched.push(order[k]!.i); continue; }
    const c = checkScalar(comp[a]!, refs[k]!, tol);
    pairs.push({ ref_index: order[k]!.i, ref: refs[k]!, value: comp[a]!, diff: c.diff, rel_err: c.rel_err, limit: c.limit, pass: c.pass });
  }
  const dr = opts.degenerateRel ?? 1e-9;
  const groups: EigenMatch['groups'] = [];
  for (let k = 0; k < m;) {
    let e = k + 1;
    while (e < m && Math.abs(refs[e]! - refs[k]!) <= dr * Math.abs(refs[k]!)) e++;
    if (e - k > 1) {
      const vals = pairs.filter((p) => Math.abs(p.ref - refs[k]!) <= dr * Math.abs(refs[k]!)).map((p) => p.value);
      const split = vals.length > 1 ? (Math.max(...vals) - Math.min(...vals)) / Math.abs(refs[k]!) : NaN;
      groups.push({ ref: refs[k]!, multiplicity: e - k, split_rel: split });
    }
    k = e;
  }
  return { pairs, unmatched_refs: unmatched, groups, n_computed: raw.length, n_dropped: all.length - comp.length, n_nonfinite: nonFinite, pass: nonFinite === 0 && unmatched.length === 0 && pairs.every((p) => p.pass) };
}

/**
 * Eigenvalue selection for a scalar target (audit B4): sort ascending, drop |v| < floor (rigid-body / null modes),
 * then skip `offset` more, then take position `index` (0-based). Use floor or offset to skip rigid modes, not both.
 */
export function selectEigen(computed: ArrayLike<number>, index: number, opts: { floor?: number; offset?: number } = {}): { value: number; reason?: string } {
  const raw = Array.from(computed);
  if (raw.some((x) => !Number.isFinite(x))) return { value: NaN, reason: 'non-finite eigenvalue in the computed list' };
  const s = raw.filter((x) => Math.abs(x) >= (opts.floor ?? -Infinity)).sort((a, b) => a - b).slice(opts.offset ?? 0);
  if (index >= s.length) return { value: NaN, reason: `index ${index} beyond ${s.length} computed values after floor / offset` };
  return { value: s[index]! };
}

// ---------------------------------------------------------------------------------------------------------------
// Rules (range, sign, monotonic, rate)

export interface RuleResult { rule: string; pass: boolean; detail: string }

export function evalRule(
  rule: { type: 'range' | 'sign' | 'monotonic' | 'rate'; range?: [number, number]; sign?: -1 | 1; direction?: 'increasing' | 'decreasing'; min?: number; max?: number; of?: 'value' | 'error' },
  values: number[], ctx: { ref?: number; bounds?: [number, number]; rate?: number } = {},
): RuleResult {
  switch (rule.type) {
    case 'range': {
      const rg = rule.range ?? ctx.bounds;
      if (!rg) return { rule: 'range', pass: false, detail: 'no range or bounds' };
      const bad = values.filter((v) => !(v >= rg[0] && v <= rg[1]));
      return { rule: 'range', pass: bad.length === 0 && values.length > 0, detail: `[${rg[0]}, ${rg[1]}]; outside: ${bad.length}/${values.length}` };
    }
    case 'sign': {
      const s = rule.sign ?? (ctx.ref !== undefined ? (Math.sign(ctx.ref) as -1 | 1) : undefined);
      if (!s) return { rule: 'sign', pass: false, detail: 'no sign or scalar reference' };
      const bad = values.filter((v) => Math.sign(v) !== s);
      return { rule: 'sign', pass: bad.length === 0 && values.length > 0, detail: `sign ${s}; wrong: ${bad.length}/${values.length}` };
    }
    case 'monotonic': {
      const inc = rule.direction !== 'decreasing';
      let ok = values.length >= 2;
      for (let i = 1; i < values.length; i++) if (inc ? !(values[i]! > values[i - 1]!) : !(values[i]! < values[i - 1]!)) ok = false;
      return { rule: 'monotonic', pass: ok, detail: `${inc ? 'increasing' : 'decreasing'} over ${values.length} values` };
    }
    case 'rate': {
      const r = ctx.rate;
      if (r === undefined || !Number.isFinite(r)) return { rule: 'rate', pass: false, detail: 'no convergence rate measured' };
      const ok = (rule.min === undefined || r >= rule.min) && (rule.max === undefined || r <= rule.max);
      return { rule: 'rate', pass: ok, detail: `rate ${r.toPrecision(4)} vs [${rule.min ?? '-inf'}, ${rule.max ?? 'inf'}]` };
    }
  }
}
