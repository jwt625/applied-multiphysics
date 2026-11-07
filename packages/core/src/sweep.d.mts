// SPDX-License-Identifier: GPL-3.0-or-later
// Declarations of sweep.mjs (hand-written, 2026-11-06; shapes follow EO engine/src/sweep.d.mts at 0546007).
export const MAX_STUDY_POINTS: number;
export interface SweepAxis { param: string; values: number[] }
export interface ParametricStudy { axes: SweepAxis[]; nPoints: number }
export type SweepAxisInput = { param: string; values: number[] } | { param: string; range: { start: number; stop: number; n: number } };
export function sweepAxis(entry: unknown, path: string): SweepAxis;
/** params: the parameter names a sweep may act on; when null / omitted the unknown-parameter check is skipped (EO always checks). */
export function parametricStudy(sweep: unknown[], options?: { params?: Iterable<string> | Record<string, unknown> | null; path?: string; maxPoints?: number }): ParametricStudy;
export function rejectSweptOverrides(study: ParametricStudy, params?: Record<string, number> | null): void;
export function pointValues(study: ParametricStudy, index: number): Record<string, number>;
export function enumeratePoints(study: ParametricStudy): { index: number; values: Record<string, number> }[];
export interface SweepPoint<R> { index: number; values: Record<string, number>; result: R | null; error: string | null; elapsed_ms: number }
export function runSweep<R>(study: ParametricStudy, runPoint: (values: Record<string, number>, index: number) => R | Promise<R>,
  options?: { signal?: AbortSignal; stopOnError?: boolean }, onPoint?: (point: SweepPoint<R>, done: number, total: number) => void): Promise<{
  axes: SweepAxis[]; nPoints: number; completed: number; cancelled: boolean; points: SweepPoint<R>[]; errors: number; elapsed_ms: number;
}>;
