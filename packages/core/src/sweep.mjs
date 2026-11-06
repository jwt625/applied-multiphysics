// Ported from eo-modulator-atlas/engine/src/sweep.mjs at 0546007 (GPL-3.0-or-later). Changes: generic part only.
// Kept verbatim: MAX_STUDY_POINTS, sweep-axis parsing (`sweepValues`, exported as `sweepAxis`), the axis checks of
// `studyOf` (unknown / twice-swept parameter, point limit), `pointValues` (row-major, last axis fastest),
// `rejectSweptOverrides`, and the sequential loop of `runSweep` (AbortSignal checked before each point, yield to the
// event loop between points, per-point errors recorded, `stopOnError`). Removed (EO-coupled, owned by the spec and
// physics lanes): YAML reading, the study keys `stages` / `outputs` / `sweep_targets` / `section`, `runConfig`,
// target evaluation, run globals and electrostatics reuse. The point runner is injected (`runPoint(values, index)`),
// and the caller passes the known parameter names instead of `resolveParams(raw.params).defs`.
// SPDX-License-Identifier: GPL-3.0-or-later

export const MAX_STUDY_POINTS = 2000;
const fail = (p, m) => { throw new Error(`${p}: ${m}`); };
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

/** One sweep axis `{param, values}` or `{param, range: {start, stop, n}}` -> `{param, values}`. */
export function sweepAxis(entry, p) {
  if (!isObj(entry)) fail(p, 'expected {param, values} or {param, range}');
  for (const k of Object.keys(entry)) if (!['param', 'values', 'range'].includes(k)) fail(`${p}.${k}`, 'unsupported field');
  if (typeof entry.param !== 'string' || !entry.param) fail(`${p}.param`, 'expected a parameter name');
  if ((entry.values == null) === (entry.range == null)) fail(p, 'give exactly one of values or range');
  let values;
  if (entry.values != null) {
    if (!Array.isArray(entry.values) || !entry.values.length) fail(`${p}.values`, 'expected a non-empty array of numbers');
    values = entry.values.map((v, i) => { if (typeof v !== 'number' || !Number.isFinite(v)) fail(`${p}.values[${i}]`, 'expected a finite number'); return v; });
  } else {
    const r = entry.range;
    if (!isObj(r)) fail(`${p}.range`, 'expected {start, stop, n}');
    for (const k of Object.keys(r)) if (!['start', 'stop', 'n'].includes(k)) fail(`${p}.range.${k}`, 'unsupported field');
    for (const k of ['start', 'stop']) if (typeof r[k] !== 'number' || !Number.isFinite(r[k])) fail(`${p}.range.${k}`, 'expected a finite number');
    if (!Number.isInteger(r.n) || r.n < 1) fail(`${p}.range.n`, 'expected an integer >= 1');
    if (r.n === 1 && r.stop !== r.start) fail(`${p}.range`, 'a single point needs stop = start');
    values = r.n === 1 ? [r.start] : Array.from({ length: r.n }, (_, i) => r.start + ((r.stop - r.start) * i) / (r.n - 1));
  }
  return { param: entry.param, values };
}

/**
 * Validated parametric study over named parameters (axes nested: the first axis is outermost).
 * @param {unknown[]} sweep axis entries (see sweepAxis)
 * @param {{params: Iterable<string> | Record<string, unknown>, path?: string, maxPoints?: number}} options
 *   params: the parameter names a sweep may act on (a name list or a defs object keyed by name)
 * @returns {{axes: {param: string, values: number[]}[], nPoints: number}}
 */
export function parametricStudy(sweep, { params, path = 'study', maxPoints = MAX_STUDY_POINTS } = {}) {
  const p = path;
  const known = params == null ? null : isObj(params) ? new Set(Object.keys(params)) : new Set(params);
  if (!Array.isArray(sweep) || !sweep.length) fail(`${p}.sweep`, 'expected a non-empty array of sweep axes');
  const axes = sweep.map((e, i) => sweepAxis(e, `${p}.sweep[${i}]`));
  const seen = new Set();
  for (const [i, a] of axes.entries()) {
    if (known && !known.has(a.param)) fail(`${p}.sweep[${i}].param`, `unknown parameter ${a.param} (sweeps act on params)`);
    if (seen.has(a.param)) fail(`${p}.sweep[${i}].param`, `parameter ${a.param} swept twice`);
    seen.add(a.param);
  }
  const nPoints = axes.reduce((n, a) => n * a.values.length, 1);
  if (nPoints > maxPoints) fail(`${p}.sweep`, `${nPoints} points exceed the limit of ${maxPoints}`);
  return { axes, nPoints };
}

/** A fixed param override that is also swept would be silently replaced by the point value (audit A12): reject it. */
export function rejectSweptOverrides(study, params) {
  for (const k of Object.keys(params ?? {})) if (study.axes.some((a) => a.param === k)) fail('params', `${k} is swept by the study; it cannot also be fixed`);
}

/** Parameter values of point `index` (row-major over the axes: the last axis varies fastest). */
export function pointValues(study, index) {
  if (!Number.isInteger(index) || index < 0 || index >= study.nPoints) fail('sweep', `point index ${index} outside 0..${study.nPoints - 1}`);
  const values = {};
  let rest = index;
  for (let a = study.axes.length - 1; a >= 0; a--) {
    const ax = study.axes[a];
    values[ax.param] = ax.values[rest % ax.values.length];
    rest = Math.floor(rest / ax.values.length);
  }
  return Object.fromEntries(study.axes.map((ax) => [ax.param, values[ax.param]]));
}

/** Every point of a study without solving (for worker pools that run points by index). */
export function enumeratePoints(study) {
  return Array.from({ length: study.nPoints }, (_, i) => ({ index: i, values: pointValues(study, i) }));
}

/**
 * Run every point of a study in order. Cancellation: `options.signal` (AbortSignal) is checked before each point; the
 * function yields to the event loop between points so an abort can arrive. A failing point (runPoint throws) is
 * recorded with its error and the sweep continues unless `stopOnError`.
 * @param {{axes: {param: string, values: number[]}[], nPoints: number}} study
 * @param {(values: Record<string, number>, index: number) => any} runPoint
 * @param {{signal?: AbortSignal, stopOnError?: boolean}} [options]
 * @param {(point: any, done: number, total: number) => void} [onPoint]
 */
export async function runSweep(study, runPoint, options = {}, onPoint = () => {}) {
  const points = [];
  let cancelled = false;
  const t0 = performance.now();
  for (let i = 0; i < study.nPoints; i++) {
    if (options.signal?.aborted) { cancelled = true; break; }
    const values = pointValues(study, i);
    const tp = performance.now();
    let point;
    try {
      point = { index: i, values, result: await runPoint(values, i), error: null, elapsed_ms: performance.now() - tp };
    } catch (e) {
      point = { index: i, values, result: null, error: e instanceof Error ? e.message : String(e), elapsed_ms: performance.now() - tp };
    }
    points.push(point);
    onPoint(point, i + 1, study.nPoints);
    if (point.error && options.stopOnError) break;
    await new Promise((r) => setTimeout(r, 0));
  }
  return { axes: study.axes, nPoints: study.nPoints, completed: points.length, cancelled, points,
    errors: points.filter((p) => p.error).length, elapsed_ms: performance.now() - t0 };
}
