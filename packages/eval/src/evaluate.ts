// SPDX-License-Identifier: GPL-3.0-or-later
// Turn observed values (one or more mesh levels) into a target verdict, with the tolerance budget printed next to
// the measured difference.

import type { Reference } from './loader.ts';
import { targetId } from './loader.ts';
import {
  checkField, checkScalar, convergenceRateFit, evalRule, fieldError, hFromDof, matchEigen, richardson,
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
}

export interface TargetObservation {
  levels: LevelObservation[];   // coarse -> fine
  exact?: boolean;              // value is itself a reference computation (no discretization): compare directly
  unit?: string;
}

export type TargetStatus = 'pass' | 'fail' | 'pending' | 'error' | 'info';

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
  rate?: RateFit;
  elements?: ScalarCheck[];
  eigen?: EigenMatch;
  field?: FieldError & { metric: string; measured: number; limit: number; pass: boolean };
  rule?: RuleResult;
  levels?: Array<{ dof?: number; h?: number; value: number | number[] | null; err?: number; wall_ms?: number }>;
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

/**
 * ref: reference value (scalar or array). refSamples: reference field samples for extract.kind = field.
 * dim: spatial dimension used for h = DOF^(-1/dim) when levels carry no h.
 */
export function evaluateTarget(
  r: Reference, ref: number | number[] | undefined, obs: TargetObservation,
  opts: { dim?: number; refSamples?: number[]; expectedOrder?: number; safetyFactor?: number } = {},
): TargetResult {
  const base = pendingTarget(r, ref, '');
  delete base.reason;
  const gated = r.gate !== false;
  const lv = obs.levels;
  if (!lv.length) return pendingTarget(r, ref, 'no observed levels', 'error');
  const fine = lv[lv.length - 1]!;
  const time = lv.reduce((s, l) => s + (l.wall_ms ?? 0), 0);
  const withTime = { ...base, time_ms: lv.some((l) => l.wall_ms !== undefined) ? time : null, dof: fine.dof ?? null };
  const verdict = (pass: boolean, extra: Partial<TargetResult>): TargetResult => ({
    ...withTime, ...extra, pass, status: gated ? (pass ? 'pass' : 'fail') : 'info',
  });
  const tol = r.tolerance;
  const hs = lv.map((l) => l.h ?? (l.dof !== undefined && opts.dim ? hFromDof(l.dof, opts.dim) : NaN));

  // Field targets: error at sample points
  if (isSamples(fine.value) || r.extract?.kind === 'field') {
    const rs = opts.refSamples;
    if (!rs) return pendingTarget(r, ref, 'no reference samples', 'error');
    if (!isSamples(fine.value)) return pendingTarget(r, ref, 'observation is not field samples', 'error');
    const fe = fieldError(fine.value.values, rs);
    const isRate = tol.rule?.type === 'rate';
    if (isRate && lv.length < 2) return pendingTarget(r, ref, `rule 'rate' needs >= 2 mesh levels, got ${lv.length}`);
    if (tol.rel === undefined && tol.abs === undefined && !isRate) return pendingTarget(r, ref, "field target needs rel, abs or a 'rate' rule", 'error');
    const chk = tol.rel !== undefined || tol.abs !== undefined ? checkField(fe, tol) : null;
    const key = (chk?.metric ?? (tol.norm === 'max' ? 'max_rel' : 'l2_rel')) as 'rms_abs' | 'max_abs' | 'max_rel' | 'l2_rel';
    const errs = lv.map((l) => (isSamples(l.value) ? fieldError(l.value.values, rs)[key] : NaN));
    const rate = lv.length >= 2 ? convergenceRateFit(hs, errs) : undefined;
    const rr = isRate ? evalRule(tol.rule!, [], rate ? { rate: rate.rate } : {}) : undefined;
    const pass = (chk ? chk.pass : true) && (rr ? rr.pass : true);
    return verdict(pass, {
      value: null, ref: null, field: { ...fe, metric: key, measured: fe[key], limit: chk?.limit ?? NaN, pass: chk?.pass ?? true },
      ...(chk ? { limit: chk.limit } : {}), ...(rate ? { rate } : {}), ...(rr ? { rule: rr } : {}),
      levels: lv.map((l, i) => ({ dof: l.dof, h: hs[i], value: null, err: errs[i], wall_ms: l.wall_ms })),
    });
  }

  const needsRef = !(tol.rule && ((tol.rule.type === 'range' && (tol.rule.range || r.bounds)) || (tol.rule.type === 'sign' && tol.rule.sign) || tol.rule.type === 'monotonic') && tol.rule.of !== 'error');
  if (ref === undefined && needsRef) return pendingTarget(r, ref, 'no reference value (value or expected)', 'error');
  const fv = fine.value as number | number[];

  // Rules
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
    return verdict(rr.pass, { value: fv, ref: ref ?? null, rule: rr, ...(rate ? { rate } : {}) });
  }

  if (ref === undefined) return pendingTarget(r, ref, 'no reference value (value or expected)', 'error');

  // Arrays: eigenvalues (sorted with multiplicity) or element-wise points
  if (Array.isArray(ref)) {
    if (!Array.isArray(fv)) return pendingTarget(r, ref, 'reference is an array, observation is a scalar', 'error');
    if (r.extract?.kind === 'eigen') {
      const em = matchEigen(fv, ref, tol, {
        ...(r.extract.offset !== undefined ? { offset: r.extract.offset } : {}),
        ...(r.extract.floor !== undefined ? { floor: r.extract.floor } : {}),
        ...(r.extract.match ? { match: r.extract.match } : {}),
      });
      const worst = em.pairs.reduce((m, p) => Math.max(m, p.rel_err), 0);
      return verdict(em.pass, { value: em.pairs.map((p) => p.value), ref, eigen: em, err_rel: worst, ...(em.unmatched_refs.length ? { reason: `${em.unmatched_refs.length} reference modes unmatched` } : {}) });
    }
    if (fv.length !== ref.length) return pendingTarget(r, ref, `observed ${fv.length} values, reference has ${ref.length}`, 'error');
    let cmp = fv;
    let riEl: Richardson[] | undefined;
    if (!obs.exact && tol.after === 'richardson') {
      // element-wise Richardson over the levels (each level must give the same number of values)
      if (!hs.every(Number.isFinite)) return pendingTarget(r, ref, 'richardson needs h or dof per level', 'error');
      if (lv.some((l) => !Array.isArray(l.value) || (l.value as number[]).length !== ref.length)) return pendingTarget(r, ref, 'richardson on arrays needs the same length on every level', 'error');
      riEl = ref.map((_, i) => richardson(lv.map((l) => (l.value as number[])[i]!), hs, { ...(opts.expectedOrder !== undefined ? { assumedOrder: opts.expectedOrder } : {}) }));
      const bad = riEl.findIndex((x) => x.f_ext === null);
      if (bad >= 0) {
        // stations where the levels agree exactly (e.g. boundary values) have no order: keep the finest value
        const exactAll = riEl.every((x, i) => x.f_ext !== null || (x.p_obs_reason === 'no_change'));
        if (!exactAll) return { ...withTime, pass: false, status: gated ? 'fail' : 'info', reason: `richardson unavailable at element ${bad} (${riEl[bad]!.p_obs_reason ?? '?'})`, value: fv, ref };
      }
      cmp = riEl.map((x, i) => x.f_ext ?? fv[i]!);
    }
    const els = cmp.map((v, i) => checkScalar(v, ref[i]!, tol));
    const worst = els.reduce((a, b) => (b.abs_err - b.limit > a.abs_err - a.limit ? b : a));
    return verdict(els.every((e) => e.pass), { value: cmp, ref, elements: els, ...(riEl ? { u_num: Math.max(...riEl.map((x) => x.u_abs ?? 0)) } : {}), diff: worst.diff, err_abs: worst.abs_err, err_rel: worst.rel_err, limit: worst.limit, limit_basis: worst.limit_basis });
  }

  // Scalars
  if (Array.isArray(fv)) return pendingTarget(r, ref, 'reference is a scalar, observation is an array', 'error');
  const vals = lv.map((l) => l.value as number);
  const levels = lv.map((l, i) => ({ dof: l.dof, h: hs[i], value: vals[i]!, err: vals[i]! - ref, wall_ms: l.wall_ms }));
  const rate = lv.length >= 2 && hs.every(Number.isFinite) ? convergenceRateFit(hs, vals.map((v) => v - ref)) : undefined;
  const after = obs.exact ? 'none' : (tol.after ?? 'finest');
  if (after === 'richardson') {
    if (!hs.every(Number.isFinite)) return pendingTarget(r, ref, 'richardson needs h or dof per level', 'error');
    const ri = richardson(vals, hs, { ...(opts.expectedOrder !== undefined ? { assumedOrder: opts.expectedOrder } : {}), ...(opts.safetyFactor !== undefined ? { fs: opts.safetyFactor } : {}) });
    if (ri.f_ext === null) {
      return { ...withTime, pass: false, status: gated ? 'fail' : 'info', reason: `richardson unavailable (${ri.p_obs_reason ?? 'fewer than 2 levels'})`, value: vals[vals.length - 1]!, ref, richardson: ri, levels, ...(rate ? { rate } : {}) };
    }
    const c = checkScalar(ri.f_ext, ref, tol);
    // Pass on the extrapolated value. u_num = GCI band of the finest level (Celik eq. 5), reported next to the
    // budget; p_obs / expected_order flags data outside the asymptotic range (reported, not gated).
    const pr = opts.expectedOrder !== undefined && ri.p_obs !== null ? ri.p_obs / opts.expectedOrder : null;
    return verdict(c.pass, {
      value: ri.f_ext, ref, diff: c.diff, err_abs: c.abs_err, err_rel: c.rel_err, limit: c.limit, limit_basis: c.limit_basis,
      u_num: ri.u_abs, richardson: ri, levels, ...(rate ? { rate } : {}),
      ...(pr !== null ? { order_ratio: pr } : {}),
      ...(pr !== null && Math.abs(pr - 1) > 0.25 ? { reason: `observed order ${ri.p_obs!.toPrecision(3)} vs expected ${opts.expectedOrder}: not asymptotic` } : {}),
    });
  }
  const c = checkScalar(vals[vals.length - 1]!, ref, tol);
  return verdict(c.pass, { value: c.value, ref, diff: c.diff, err_abs: c.abs_err, err_rel: c.rel_err, limit: c.limit, limit_basis: c.limit_basis, ...(lv.length > 1 ? { levels } : {}), ...(rate ? { rate } : {}) });
}
