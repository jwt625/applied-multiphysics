// SPDX-License-Identifier: GPL-3.0-or-later
// Turn observed values (one or more mesh levels) into a target verdict, with the tolerance budget printed next to
// the measured difference.

import type { Reference } from './loader.ts';
import { targetId } from './loader.ts';
import {
  checkField, checkScalar, convergenceRateFit, evalRule, fieldError, hFromDof, matchEigen, richardson, richardsonRule, selectEigen,
  RICHARDSON_ORDER_BAND, type RichardsonRuleResult,
  type EigenMatch, type FieldError, type RateFit, type Richardson, type RuleResult, type ScalarCheck,
} from './metrics.ts';

export interface FieldSamples { values: number[] }
export type ObservedValue = number | number[] | FieldSamples;

export interface LevelObservation {
  value: ObservedValue;
  dof?: number;
  h?: number;              // representative size; default from dof and dimension
  wall_ms?: number;
  stages?: Record<string, number>;
  iterations?: number;
  meshHash?: string;
}

export interface TargetObservation {
  levels: LevelObservation[];   // coarse -> fine
  exact?: boolean;              // value is itself a reference computation (no discretization): compare directly
  unit?: string;
}

export type TargetStatus = 'pass' | 'fail' | 'pending' | 'error' | 'info' | 'timeout';

export interface TargetResult {
  target: string;
  quantity: string;
  status: TargetStatus;
  pass: boolean | null;         // null for pending / error
  gated: boolean;
  reason?: string;
  value: number | number[] | null;      // compared value (extrapolated when after = richardson)
  ref: number | number[] | null;
  unit: string;
  tol: Reference['tolerance'];
  diff?: number;
  err_abs?: number;
  err_rel?: number;
  limit?: number;
  limit_basis?: string;
  u_num?: number | null;        // Richardson GCI band of the finest level (absolute)
  order_ratio?: number;         // p_obs / expected_order
  richardson?: Richardson;
  richardson_fallback?: 'finest+monotone';
  rate?: RateFit;
  elements?: ScalarCheck[];
  eigen?: EigenMatch;
  field?: FieldError & { metric: string; measured: number; limit: number; pass: boolean };
  rule?: RuleResult;
  levels?: Array<{ dof?: number; h?: number; value: number | number[] | null; err?: number; wall_ms?: number; meshHash?: string }>;
  time_ms: number | null;
  dof: number | null;
}

function isSamples(v: ObservedValue): v is FieldSamples {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && Array.isArray((v as FieldSamples).values);
}

export function pendingTarget(r: Reference, ref: number | number[] | undefined, reason: string, status: TargetStatus = 'pending'): TargetResult {
  return {
    target: targetId(r), quantity: r.quantity, status, pass: null, gated: r.gate !== false, reason,
    value: null, ref: ref ?? null, unit: r.unit, tol: r.tolerance, time_ms: null, dof: null,
  };
}

export interface EvaluateOptions {
  dim?: number;
  refSamples?: number[];
  expectedOrder?: number;
  safetyFactor?: number;
  /** allowed relative departure |p_obs / expected_order - 1| (shared rule, metrics.richardsonRule); default 0.25 */
  orderBand?: number;
  /** false: do not gate the observed order (convergence.order_check) */
  orderCheck?: boolean;
}

const finiteVal = (v: ObservedValue): boolean =>
  typeof v === 'number' ? Number.isFinite(v) : Array.isArray(v) ? v.every((x) => Number.isFinite(x)) : true;

/**
 * Fallback when the shared rule declares Richardson unavailable (oscillatory or non-nested sequence, order outside
 * the band, flat or too few levels; L4 DevLog-010 s.5 item 3): gate on the finest value against the budget plus a
 * monotone error, |e_k| non-increasing over the levels. Richardson is reported unavailable with the reason.
 */
function fallbackGate(vals: number[], ref: number, tol: Reference['tolerance'], why: string): { fine: ScalarCheck; monotone: boolean; reason: string } {
  const fine = checkScalar(vals[vals.length - 1]!, ref, tol);
  const e = vals.map((v) => Math.abs(v - ref));
  let monotone = true;
  for (let i = 1; i < e.length; i++) if (e[i]! > e[i - 1]! * (1 + 1e-12) + 1e-300) monotone = false;
  const reason = `richardson unavailable (${why}); fallback: finest value ${fine.pass ? 'within' : 'outside'} the budget, |error| ${monotone ? 'non-increasing' : 'not monotone'} over ${vals.length} levels`;
  return { fine, monotone, reason };
}

/** One sequence through the shared rule: extrapolated value, verdict parts and reason. */
function richardsonVerdict(vals: number[], hs: number[], ref: number, tol: Reference['tolerance'], opts: EvaluateOptions): { ri: RichardsonRuleResult; value: number; check: ScalarCheck; pass: boolean; fallback: boolean; reason?: string } {
  const band = opts.orderCheck === false ? Infinity : (opts.orderBand ?? RICHARDSON_ORDER_BAND);
  const ri = richardsonRule(vals, hs, { ...(opts.expectedOrder !== undefined ? { expectedOrder: opts.expectedOrder } : {}), band, ...(opts.safetyFactor !== undefined ? { fs: opts.safetyFactor } : {}) });
  if (!ri.available) {
    const fb = fallbackGate(vals, ref, tol, ri.reason ?? 'unavailable');
    return { ri, value: fb.fine.value, check: fb.fine, pass: fb.fine.pass && fb.monotone, fallback: true, reason: fb.reason };
  }
  const ext = checkScalar(ri.f_ext!, ref, tol);
  const fine = checkScalar(ri.f_fine, ref, tol);
  const reasons = [ri.reason, !fine.pass ? `finest level ${ri.f_fine.toPrecision(6)} outside the budget (|diff| ${fine.abs_err.toPrecision(3)} > ${fine.limit.toPrecision(3)})` : undefined].filter((x): x is string => !!x);
  return { ri, value: ri.f_ext!, check: ext, pass: ext.pass && fine.pass, fallback: false, ...(reasons.length ? { reason: reasons.join('; ') } : {}) };
}

/**
 * ref: reference value (scalar or array). refSamples: reference field samples for extract.kind = field.
 * dim: spatial dimension used for h = DOF^(-1/dim) when levels carry no h.
 */
export function evaluateTarget(r: Reference, ref: number | number[] | undefined, obs: TargetObservation, opts: EvaluateOptions = {}): TargetResult {
  const base = pendingTarget(r, ref, '');
  delete base.reason;
  const gated = r.gate !== false;
  let lv = obs.levels;
  if (!lv.length) return pendingTarget(r, ref, 'no observed levels', 'error');
  const time = lv.reduce((s, l) => s + (l.wall_ms ?? 0), 0);
  const withTime = { ...base, time_ms: lv.some((l) => l.wall_ms !== undefined) ? time : null, dof: lv[lv.length - 1]!.dof ?? null };
  const verdict = (pass: boolean, extra: Partial<TargetResult>): TargetResult => ({
    ...withTime, ...extra, pass, status: gated ? (pass ? 'pass' : 'fail') : 'info',
  });
  const tol = r.tolerance;
  const hs = lv.map((l) => l.h ?? (l.dof !== undefined && opts.dim ? hFromDof(l.dof, opts.dim) : NaN));
  const levelRows = (vals: Array<number | number[] | null>, errs?: number[]) => lv.map((l, i) => ({ dof: l.dof, h: hs[i], value: vals[i] ?? null, ...(errs ? { err: errs[i] } : {}), wall_ms: l.wall_ms, ...(l.meshHash ? { meshHash: l.meshHash } : {}) }));

  // Field targets: error at sample points
  if (isSamples(lv[lv.length - 1]!.value) || r.extract?.kind === 'field') {
    const fine = lv[lv.length - 1]!;
    const rs = opts.refSamples;
    if (!rs) return pendingTarget(r, ref, 'no reference samples', 'error');
    if (!isSamples(fine.value)) return pendingTarget(r, ref, 'observation is not field samples', 'error');
    if (rs.some((x) => !Number.isFinite(x))) return pendingTarget(r, ref, 'reference samples contain NaN / Inf', 'error');
    if (lv.some((l) => isSamples(l.value) && l.value.values.length !== rs.length)) return pendingTarget(r, ref, `field samples: engine gives ${(fine.value as FieldSamples).values.length} values, reference ${rs.length} (components x points must match)`, 'error');
    const fe = fieldError(fine.value.values, rs);
    const isRate = tol.rule?.type === 'rate';
    if (isRate && lv.length < 2) return pendingTarget(r, ref, `rule 'rate' needs >= 2 mesh levels, got ${lv.length}`);
    if (tol.rel === undefined && tol.abs === undefined && !isRate) return pendingTarget(r, ref, "field target needs rel, abs or a 'rate' rule", 'error');
    // unit '1' on a field target = relative norm (||e|| / ||ref||), whatever the field's own unit
    const relative = ['', '1', '-', 'dimensionless'].includes(r.unit.trim());
    const chk = tol.rel !== undefined || tol.abs !== undefined ? checkField(fe, tol, { relative }) : null;
    const key = (chk?.metric ?? (tol.norm === 'max' || tol.norm === 'rel_max' ? 'max_rel' : 'l2_rel')) as 'rms_abs' | 'max_abs' | 'max_rel' | 'l2_rel';
    const errs = lv.map((l) => (isSamples(l.value) ? fieldError(l.value.values, rs)[key] : NaN));
    const rate = lv.length >= 2 ? convergenceRateFit(hs, errs) : undefined;
    const rr = isRate ? evalRule(tol.rule!, [], rate ? { rate: rate.rate } : {}) : undefined;
    // S1: a non-finite sample (outside the mesh, NaN) fails unless extract.max_dropped allows it
    const allowed = r.extract?.max_dropped ?? 0;
    const droppedPerLevel = lv.map((l) => (isSamples(l.value) ? l.value.values.filter((x) => !Number.isFinite(x)).length : 0));
    const dropOk = droppedPerLevel.every((d) => d <= allowed);
    const pass = (chk ? chk.pass : true) && (rr ? rr.pass : true) && dropOk && fe.n > 0;
    return verdict(pass, {
      value: null, ref: null, field: { ...fe, metric: key, measured: fe[key], limit: chk?.limit ?? NaN, pass: chk?.pass ?? true },
      ...(chk ? { limit: chk.limit } : {}), ...(rate ? { rate } : {}), ...(rr ? { rule: rr } : {}),
      ...(!dropOk ? { reason: `non-finite samples ${droppedPerLevel.join('/')} per level > max_dropped ${allowed}` } : {}),
      levels: levelRows(lv.map(() => null), errs),
    });
  }

  // S1 / M2: any non-finite value on any level fails the target, with the level named
  const bad = lv.findIndex((l) => !finiteVal(l.value));
  if (bad >= 0 && r.extract?.kind !== 'eigen') return verdict(false, { value: null, ref: ref ?? null, reason: `non-finite value at level ${bad + 1} of ${lv.length}` });

  // B4: scalar eigen target = position `index` in the sorted list after floor and offset
  if (r.extract?.kind === 'eigen' && !Array.isArray(ref)) {
    const idx = r.extract.index;
    if (idx === undefined) return pendingTarget(r, ref, 'scalar eigen target needs extract.index', 'error');
    const sel = lv.map((l) => (Array.isArray(l.value) ? selectEigen(l.value, idx, { ...(r.extract!.floor !== undefined ? { floor: r.extract!.floor } : {}), ...(r.extract!.offset !== undefined ? { offset: r.extract!.offset } : {}) }) : { value: l.value as number }));
    const why = sel.findIndex((x) => x.reason !== undefined || !Number.isFinite(x.value));
    if (why >= 0) return verdict(false, { value: null, ref: ref ?? null, reason: `level ${why + 1}: ${sel[why]!.reason ?? 'non-finite eigenvalue'}` });
    lv = lv.map((l, i) => ({ ...l, value: sel[i]!.value }));
  }

  const needsRef = !(tol.rule && ((tol.rule.type === 'range' && (tol.rule.range || r.bounds)) || (tol.rule.type === 'sign' && tol.rule.sign) || tol.rule.type === 'monotonic') && tol.rule.of !== 'error');
  if (ref === undefined && needsRef) return pendingTarget(r, ref, 'no reference value (value or expected)', 'error');
  const fv = lv[lv.length - 1]!.value as number | number[];

  // Rules (M3: a rel / abs tolerance given next to the rule is applied too, to the finest value)
  if (tol.rule) {
    let vals = Array.isArray(fv) ? fv : tol.rule.type === 'monotonic' ? lv.map((l) => l.value as number) : [fv];
    // Rules over a sequence (coordinator decision 2026-11-06): a single value cannot decide them -> pending
    if (tol.rule.type === 'rate' && lv.length < 2) return pendingTarget(r, ref, `rule 'rate' needs >= 2 mesh levels, got ${lv.length}`);
    if (tol.rule.type === 'monotonic' && vals.length < 2) return pendingTarget(r, ref, `rule 'monotonic' needs a sequence (levels or a sweep), got ${vals.length} value`);
    if (tol.rule.of === 'error') {
      if (typeof ref !== 'number') return pendingTarget(r, ref, "rule with of: error needs a scalar reference", 'error');
      vals = vals.map((v) => Math.abs(v - ref));
    }
    let rate: RateFit | undefined;
    if (tol.rule.type === 'rate') {
      if (typeof ref !== 'number') return pendingTarget(r, ref, "rule 'rate' needs a scalar reference", 'error');
      rate = convergenceRateFit(hs, lv.map((l) => (l.value as number) - ref));
    }
    const rr = evalRule(tol.rule, vals, { ...(typeof ref === 'number' ? { ref } : {}), ...(r.bounds ? { bounds: r.bounds } : {}), ...(rate ? { rate: rate.rate } : {}) });
    const tolChk = (tol.rel !== undefined || tol.abs !== undefined) && typeof ref === 'number' && typeof fv === 'number' ? checkScalar(fv, ref, tol) : null;
    return verdict(rr.pass && (tolChk ? tolChk.pass : true), {
      value: fv, ref: ref ?? null, rule: rr, ...(rate ? { rate } : {}),
      ...(tolChk ? { diff: tolChk.diff, err_abs: tolChk.abs_err, err_rel: tolChk.rel_err, limit: tolChk.limit, limit_basis: tolChk.limit_basis } : {}),
      ...(tolChk && !tolChk.pass ? { reason: 'rule passed, rel / abs tolerance missed' } : {}),
    });
  }

  if (ref === undefined) return pendingTarget(r, ref, 'no reference value (value or expected)', 'error');
  const after = obs.exact ? 'none' : (tol.after ?? 'finest');

  // Arrays: eigenvalues (matched per level, sorted with multiplicity) or element-wise points
  if (Array.isArray(ref)) {
    if (!Array.isArray(fv)) return pendingTarget(r, ref, 'reference is an array, observation is a scalar', 'error');
    if (r.extract?.kind === 'eigen') return evaluateEigenArray(r, ref, lv, hs, after === 'richardson', opts, verdict);
    if (bad >= 0) return verdict(false, { value: null, ref, reason: `non-finite value at level ${bad + 1} of ${lv.length}` });
    if (fv.length !== ref.length) return pendingTarget(r, ref, `observed ${fv.length} values, reference has ${ref.length}`, 'error');
    let cmp = fv;
    let riEl: Richardson[] | undefined;
    const reasons: string[] = [];
    let extraOk = true;
    if (after === 'richardson') {
      // element-wise, each element through the shared rule (stations where the levels agree exactly have no
      // order: unavailable, finest value with a non-increasing error)
      if (!hs.every(Number.isFinite)) return pendingTarget(r, ref, 'richardson needs h or dof per level', 'error');
      if (lv.some((l) => !Array.isArray(l.value) || (l.value as number[]).length !== ref.length)) return pendingTarget(r, ref, 'richardson on arrays needs the same length on every level', 'error');
      const rv = ref.map((rf, i) => richardsonVerdict(lv.map((l) => (l.value as number[])[i]!), hs, rf, tol, opts));
      riEl = rv.map((x) => x.ri);
      cmp = rv.map((x) => x.value);
      rv.forEach((x, i) => {
        if (!x.pass) extraOk = false;
        if (x.reason && (x.fallback || !x.pass)) reasons.push(`element ${i}: ${x.reason}`);
      });
    }
    const els = cmp.map((v, i) => checkScalar(v, ref[i]!, tol));
    const worst = els.reduce((a, b) => (b.abs_err - b.limit > a.abs_err - a.limit ? b : a));
    return verdict(els.every((e) => e.pass) && extraOk, {
      value: cmp, ref, elements: els, ...(riEl ? { u_num: Math.max(...riEl.map((x) => x.u_abs ?? 0)) } : {}),
      diff: worst.diff, err_abs: worst.abs_err, err_rel: worst.rel_err, limit: worst.limit, limit_basis: worst.limit_basis,
      ...(reasons.length ? { reason: reasons.slice(0, 3).join(' | ') } : {}),
    });
  }

  // Scalars
  if (Array.isArray(fv)) return pendingTarget(r, ref, 'reference is a scalar, observation is an array', 'error');
  const vals = lv.map((l) => l.value as number);
  const levels = levelRows(vals, vals.map((v) => v - ref));
  const rate = lv.length >= 2 && hs.every(Number.isFinite) ? convergenceRateFit(hs, vals.map((v) => v - ref)) : undefined;
  if (after === 'richardson') {
    if (!hs.every(Number.isFinite)) return pendingTarget(r, ref, 'richardson needs h or dof per level', 'error');
    const v = richardsonVerdict(vals, hs, ref, tol, opts);
    return verdict(v.pass, {
      value: v.value, ref, diff: v.check.diff, err_abs: v.check.abs_err, err_rel: v.check.rel_err, limit: v.check.limit, limit_basis: v.check.limit_basis,
      u_num: v.fallback ? null : v.ri.u_abs, richardson: v.ri, levels, ...(rate ? { rate } : {}), ...(v.ri.order_ratio !== null ? { order_ratio: v.ri.order_ratio } : {}),
      ...(v.fallback ? { richardson_fallback: 'finest+monotone' as const } : {}), ...(v.reason ? { reason: v.reason } : {}),
    });
  }
  const c = checkScalar(vals[vals.length - 1]!, ref, tol);
  return verdict(c.pass, { value: c.value, ref, diff: c.diff, err_abs: c.abs_err, err_rel: c.rel_err, limit: c.limit, limit_basis: c.limit_basis, ...(lv.length > 1 ? { levels } : {}), ...(rate ? { rate } : {}) });
}

/**
 * Eigen arrays (audit S2): match every level to the reference list, then (after: richardson) extrapolate each
 * reference mode. A degenerate reference cluster (equal values) is a subspace: its sorted matched values are
 * extrapolated through the cluster mean, and each member keeps its finest-level offset from the mean (the split).
 */
function evaluateEigenArray(
  r: Reference, ref: number[], lv: LevelObservation[], hs: number[], extrapolate: boolean, opts: EvaluateOptions,
  verdict: (pass: boolean, extra: Partial<TargetResult>) => TargetResult,
): TargetResult {
  const tol = r.tolerance;
  const mo = { ...(r.extract!.offset !== undefined ? { offset: r.extract!.offset } : {}), ...(r.extract!.floor !== undefined ? { floor: r.extract!.floor } : {}), ...(r.extract!.match ? { match: r.extract!.match } : {}) };
  const ms = lv.map((l) => matchEigen(Array.isArray(l.value) ? l.value : [l.value as number], ref, tol, mo));
  const fine = ms[ms.length - 1]!;
  const badLevel = ms.findIndex((m) => m.n_nonfinite > 0 || m.unmatched_refs.length > 0);
  if (badLevel >= 0) {
    const m = ms[badLevel]!;
    return verdict(false, { value: fine.pairs.map((p) => p.value), ref, eigen: fine, reason: `level ${badLevel + 1}: ${m.n_nonfinite ? `${m.n_nonfinite} non-finite eigenvalues` : `${m.unmatched_refs.length} reference modes unmatched`}` });
  }
  if (!extrapolate || lv.length < 2) {
    const worst = fine.pairs.reduce((a, p) => Math.max(a, p.rel_err), 0);
    return verdict(fine.pass, { value: fine.pairs.map((p) => p.value), ref, eigen: fine, err_rel: worst });
  }
  if (!hs.every(Number.isFinite)) return pendingTarget(r, ref, 'richardson needs h or dof per level', 'error');
  const matched = ms.map((m) => { const v = new Array<number>(ref.length); for (const p of m.pairs) v[p.ref_index] = p.value; return v; });
  const dr = 1e-9;
  const order = ref.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const ext = new Array<number>(ref.length);
  const ris: Richardson[] = [];
  const reasons: string[] = [];
  let ok = true;
  for (let k = 0; k < order.length;) {
    let e = k + 1;
    while (e < order.length && Math.abs(order[e]!.v - order[k]!.v) <= dr * Math.abs(order[k]!.v)) e++;
    const idx = order.slice(k, e).map((o) => o.i);
    const sortedPerLevel = matched.map((v) => idx.map((i) => v[i]!).sort((a, b) => a - b));
    const means = sortedPerLevel.map((s) => s.reduce((a, b) => a + b, 0) / s.length);
    const fineSorted = sortedPerLevel[sortedPerLevel.length - 1]!, fineMean = means[means.length - 1]!;
    const v = richardsonVerdict(means, hs, order[k]!.v, tol, opts);
    ris.push(v.ri);
    if (!v.pass) ok = false;
    if (v.reason && (v.fallback || !v.pass)) reasons.push(`mode(s) ${idx.join(',')}: ${v.reason}`);
    idx.forEach((i, j) => { ext[i] = v.value + (fineSorted[j]! - fineMean); });
    k = e;
  }
  const els = ext.map((v, i) => checkScalar(v, ref[i]!, tol));
  const worst = els.reduce((a, b) => (b.abs_err - b.limit > a.abs_err - a.limit ? b : a));
  return verdict(ok && els.every((x) => x.pass), {
    value: ext, ref, eigen: fine, elements: els, u_num: Math.max(...ris.map((x) => x.u_abs ?? 0)),
    diff: worst.diff, err_abs: worst.abs_err, err_rel: worst.rel_err, limit: worst.limit, limit_basis: worst.limit_basis,
    ...(reasons.length ? { reason: reasons.slice(0, 3).join(' | ') } : {}),
  });
}
