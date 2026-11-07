// SPDX-License-Identifier: GPL-3.0-or-later
// Sampling for plots and for the eval harness: values at points, along a line, on a grid; CSV export.

import type { Mesh, Solution } from '@amp/spec/types';
import { evaluateField } from './evaluate.ts';
import { fieldOf, meshOf } from './store.ts';

export interface SampleOptions { mesh?: Mesh; component?: number | 'norm'; step?: number; /** reference-coordinate tolerance for points on curved walls (e.g. 1e-3) */ snap?: number }

/**
 * L8 hook (CONTRACTS-v0 changelog; DevLog-009 request 4): values of `field` at points ([[x, y(, z)], ...] or flat),
 * one value per point (component `component`, default 0; |v| when component is 'norm'). NaN outside the mesh.
 */
export function sample(sol: Solution, field: string, points: ArrayLike<number> | number[][], o: SampleOptions = {}): Float64Array {
  const mesh = meshOf(sol, o.mesh);
  const f = fieldOf(sol, field, o.step);
  const flat = Array.isArray(points) && Array.isArray(points[0]) ? Float64Array.from((points as number[][]).flat()) : (points as ArrayLike<number>);
  if (flat.length % mesh.dim) throw new Error(`sample: ${flat.length} coordinates is not a multiple of dim ${mesh.dim}`);
  const { values } = evaluateField(mesh, f, flat, o.snap ? { snap: o.snap } : {});
  const nc = f.components, np = flat.length / mesh.dim, out = new Float64Array(np);
  for (let i = 0; i < np; i++) {
    if (o.component === 'norm') { let s = 0; for (let j = 0; j < nc; j++) s += values[i * nc + j]! ** 2; out[i] = Math.sqrt(s); }
    else out[i] = values[i * nc + ((o.component as number | undefined) ?? 0)]!;
  }
  return out;
}

/** n points from a to b (inclusive) and the arc length s of each. */
export function linePoints(a: number[], b: number[], n: number): { points: Float64Array; s: Float64Array } {
  const dim = a.length, points = new Float64Array(dim * n), s = new Float64Array(n);
  const L = Math.hypot(...a.map((v, d) => b[d]! - v));
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0 : i / (n - 1);
    for (let d = 0; d < dim; d++) points[dim * i + d] = a[d]! + t * (b[d]! - a[d]!);
    s[i] = t * L;
  }
  return { points, s };
}

/** Regular 2D grid (nx x ny points over the box), row-major in x; for heat maps. */
export function gridPoints(x: [number, number], y: [number, number], nx: number, ny: number): Float64Array {
  const p = new Float64Array(2 * nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    p[2 * (j * nx + i)] = x[0] + ((x[1] - x[0]) * i) / Math.max(1, nx - 1);
    p[2 * (j * nx + i) + 1] = y[0] + ((y[1] - y[0]) * j) / Math.max(1, ny - 1);
  }
  return p;
}

/** CSV text from named columns (equal length); header carries units as `name [unit]`. NaN is written empty. */
export function toCsv(columns: Array<{ name: string; unit?: string; values: ArrayLike<number> }>): string {
  const n = columns[0]?.values.length ?? 0;
  if (columns.some((c) => c.values.length !== n)) throw new Error('toCsv: columns differ in length');
  const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const lines = [columns.map((c) => esc(c.unit ? `${c.name} [${c.unit}]` : c.name)).join(',')];
  for (let i = 0; i < n; i++) lines.push(columns.map((c) => { const v = c.values[i]!; return Number.isFinite(v) ? String(v) : ''; }).join(','));
  return lines.join('\n') + '\n';
}
