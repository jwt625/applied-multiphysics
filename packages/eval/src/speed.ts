// SPDX-License-Identifier: GPL-3.0-or-later
// Speed metrics (R3 s.5.3): one discarded warm-up + median of N >= 5 timed runs; per-stage timing from
// Solution.timing (C5); time-to-accuracy over a mesh sequence; CEED BP-style throughput
// (Fischer et al. 2020, IJHPCA 34:562, eq. 3: DOF/s = CG iterations x DOFs / (nodes x seconds)).

export function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : 0.5 * (s[m - 1]! + s[m]!);
}

export interface TimingSummary {
  warmup_ms: number[];
  samples_ms: number[];
  median_ms: number;
  min_ms: number;
  max_ms: number;
  mad_ms: number;                       // median absolute deviation
  stages_median_ms: Record<string, number>;  // per stage (Solution.timing), median over timed runs
}

export interface TimeOptions { warmup?: number; repeats?: number; now?: () => number; setup?: () => void }

/** Time an async function. If it returns an object with `timing` (C5 Solution), stage times are aggregated. */
export async function timeRuns<T>(fn: () => Promise<T> | T, opts: TimeOptions = {}): Promise<{ summary: TimingSummary; last: T }> {
  const warmup = opts.warmup ?? 1, repeats = opts.repeats ?? 5;
  if (repeats < 1) throw new Error('repeats must be >= 1');
  const now = opts.now ?? (() => performance.now());
  const warm: number[] = [], samples: number[] = [];
  const stages: Array<Record<string, number>> = [];
  let last: T | undefined;
  for (let i = 0; i < warmup + repeats; i++) {
    opts.setup?.();   // untimed per-run preparation (e.g. resetting the initial guess)
    const t0 = now();
    last = await fn();
    const dt = now() - t0;
    if (i < warmup) { warm.push(dt); continue; }
    samples.push(dt);
    const tm = (last as { timing?: Record<string, number> } | null)?.timing;
    if (tm && typeof tm === 'object') stages.push(tm);
  }
  const med = median(samples);
  return {
    summary: {
      warmup_ms: warm, samples_ms: samples, median_ms: med,
      min_ms: Math.min(...samples), max_ms: Math.max(...samples),
      mad_ms: median(samples.map((s) => Math.abs(s - med))),
      stages_median_ms: stageMedians(stages),
    },
    last: last as T,
  };
}

export function stageMedians(timings: Array<Record<string, number>>): Record<string, number> {
  const keys = new Set<string>();
  for (const t of timings) for (const k of Object.keys(t)) keys.add(k);
  const out: Record<string, number> = {};
  for (const k of keys) out[k] = median(timings.map((t) => t[k]).filter((v): v is number => typeof v === 'number' && Number.isFinite(v)));
  return out;
}

// ---------------------------------------------------------------------------------------------------------------

export interface LevelTiming { level: number; dof: number; wall_ms: number; error: number }

export interface TimeToAccuracy {
  tol: number;
  reached: boolean;
  level: number | null;            // first (coarsest) level with error <= tol
  t_level_ms: number | null;       // wall time of that single solve (user re-solve cost)
  t_cum_ms: number | null;         // cumulative wall time over the sequence up to that level
  t_interp_ms: number | null;      // log-log interpolation of wall vs error at error = tol (R3 s.5.3 T_tol)
  dof: number | null;
  dof_per_s: number | null;        // DOF / single-solve wall time (Kronbichler-Wall convention)
  min_error: number;
  points: Array<{ wall_ms: number; error: number; dof: number }>;  // work-precision curve
}

/** Levels ordered coarse -> fine. Errors are |value - ref| in the units of the tolerance. */
export function timeToAccuracy(levels: LevelTiming[], tol: number): TimeToAccuracy {
  const pts = levels.map((l) => ({ wall_ms: l.wall_ms, error: Math.abs(l.error), dof: l.dof }));
  const minErr = Math.min(...pts.map((p) => p.error));
  const k = pts.findIndex((p) => p.error <= tol);
  const base = { tol, points: pts, min_error: minErr };
  if (k < 0) return { ...base, reached: false, level: null, t_level_ms: null, t_cum_ms: null, t_interp_ms: null, dof: null, dof_per_s: null };
  const lv = levels[k]!;
  let cum = 0;
  for (let i = 0; i <= k; i++) cum += levels[i]!.wall_ms;
  let interp: number | null = lv.wall_ms;
  if (k > 0) {
    const a = pts[k - 1]!, b = pts[k]!;
    if (a.error > 0 && b.error > 0 && a.wall_ms > 0 && b.wall_ms > 0 && a.error !== b.error) {
      const t = (Math.log(tol) - Math.log(a.error)) / (Math.log(b.error) - Math.log(a.error));
      interp = Math.exp(Math.log(a.wall_ms) + t * (Math.log(b.wall_ms) - Math.log(a.wall_ms)));
    }
  }
  return { ...base, reached: true, level: lv.level, t_level_ms: lv.wall_ms, t_cum_ms: cum, t_interp_ms: interp, dof: lv.dof, dof_per_s: lv.dof / (lv.wall_ms / 1000) };
}

// ---------------------------------------------------------------------------------------------------------------

export interface Throughput { dof: number; iterations: number; seconds: number; nodes: number; dof_per_s: number; mdof_per_s: number }

/** CEED BP metric: DOF x CG iterations / (nodes x seconds). nodes = compute nodes (1 for one browser / process). */
export function ceedThroughput(dof: number, iterations: number, seconds: number, nodes = 1): Throughput {
  if (!(seconds > 0)) throw new Error('ceedThroughput: seconds must be > 0');
  const r = (dof * iterations) / (nodes * seconds);
  return { dof, iterations, seconds, nodes, dof_per_s: r, mdof_per_s: r / 1e6 };
}

/** r_max and n_0.8 (smallest DOF/node reaching 80 % of peak) from a throughput sweep; t_0.8 ~ 1.25 n_0.8 / r_max. */
export function throughputSummary(sweep: Array<{ dof: number; dof_per_s: number }>): { r_max: number; n_08: number | null; t_08_s: number | null } {
  const sorted = [...sweep].sort((a, b) => a.dof - b.dof);
  const rmax = Math.max(...sorted.map((s) => s.dof_per_s));
  const hit = sorted.find((s) => s.dof_per_s >= 0.8 * rmax);
  const n08 = hit ? hit.dof : null;
  return { r_max: rmax, n_08: n08, t_08_s: n08 !== null ? (1.25 * n08) / rmax : null };
}
