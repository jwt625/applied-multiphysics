// SPDX-License-Identifier: GPL-3.0-or-later
// Spec builders and helpers of the wave2d gate tests (lane S1, DevLog-042 s.1.7). Geometry in metres, lambda0 = 1 m
// (EM: f = c0 / 1 m; acoustics: f = c / 1 m), so every length is in wavelengths. Material values are test inputs.

import { readFileSync } from 'node:fs';
import { prepareRun } from '../src/index.ts';
import { emw2dModule, solveWave2D } from '../src/wave2d/index.ts';
import { probe } from '../src/wave2d/probe.ts';
import type { Mesh, Solution } from '@amp/spec/types';

export const VERBOSE = !!process.env.W2D_VERBOSE;
export const log = (...a: unknown[]) => { if (VERBOSE) console.log('[wave2d]', ...a); };

export const ref = <T = Record<string, unknown>>(name: string): T => JSON.parse(readFileSync(new URL(`../../../validation/wave2d/${name}`, import.meta.url), 'utf8')) as T;

const q = (v: number | number[], unit: string) => ({ value: v, unit });
export const rect = (id: string, x0: number, x1: number, y0: number, y1: number) => ({ id, type: 'rect', settings: { center: q([(x0 + x1) / 2, (y0 + y1) / 2], 'm'), size: q([x1 - x0, y1 - y0], 'm') } });
export const circle = (id: string, r: number) => ({ id, type: 'circle', settings: { center: q([0, 0], 'm'), radius: q(r, 'm') } });

export type Sol = Solution & { wave2d: { perFrequency: Array<Record<string, unknown>> }; notes?: string[]; mesh?: Mesh };

/** prepareRun + run of the first physics; module = emw-2d or the acoustics frequency path. */
export async function run(spec: Record<string, unknown>): Promise<{ sol: Sol; mesh: Mesh; ms: number }> {
  const p = await prepareRun(spec, {});
  const t0 = performance.now();
  const type = (spec.physics as Array<{ type: string }>)[0]!.type;
  const sol = (type === 'emw-2d' ? await emw2dModule.run(p) : await solveWave2D(p, 'acoustics')) as Sol;
  return { sol, mesh: p.mesh, ms: performance.now() - t0 };
}

export const field = (sol: Solution, name: string, step = 0): Float64Array => {
  const f = sol.fields.find((x) => x.name === name && (x.step ?? 0) === step);
  if (!f) throw new Error(`no field ${name} step ${step}`);
  return f.data;
};
export const sc = (sol: Solution, name: string): number => {
  const s = sol.scalars[name];
  if (!s) throw new Error(`no scalar ${name} (have ${Object.keys(sol.scalars).slice(0, 30).join(', ')})`);
  return s.value;
};
export function probeC(mesh: Mesh, sol: Solution, base: string, x: number, y: number, step = 0): [number, number] {
  const v = probe(mesh, [field(sol, `${base}_re`, step), field(sol, `${base}_im`, step)], x, y);
  if (!v) throw new Error(`probe (${x}, ${y}) outside the mesh`);
  return [v[0]!, v[1]!];
}

/**
 * Plane wave (along +x) on a circular cylinder of radius a = 0.5 m in vacuum (or acoustic medium), non-PML box
 * [-1.5, 1.5]^2 m, PML 0.5 m. kind: 'pec' (hole with pec / sound-hard / sound-soft walls) or 'diel' (eps_r 4 core).
 */
export function cylinderSpec(o: { physics: 'emw-2d' | 'acoustics'; pol?: 'TM' | 'TE'; kind: 'pec' | 'diel' | 'hard' | 'soft'; h: number; R0?: number }): Record<string, unknown> {
  const L = 1.5, d = 0.5;
  const diel = o.kind === 'diel';
  const feats: unknown[] = [rect('outer', -L - d, L + d, -L - d, L + d), rect('inner', -L, L, -L, L), rect('inner2', -L, L, -L, L), circle('cyl', 0.5),
    { id: 'pml', type: 'difference', settings: { base: 'outer', tools: ['inner2'] } },
    { id: 'air', type: 'difference', settings: { base: 'inner', tools: ['cyl'], ...(diel ? { keepTools: true } : {}) } }];
  const acoustic = o.physics === 'acoustics';
  const bg = acoustic ? { c: q(343, 'm/s'), rho: q(1.2, 'kg/m^3') } : { eps_r: 1, mu_r: 1 };
  const wall = o.kind === 'pec' ? [{ id: 'wall', type: 'pec', select: ['bnd:cyl.edge'] }]
    : o.kind === 'hard' ? [{ id: 'wall', type: 'sound-hard', select: ['bnd:cyl.edge'] }]
      : o.kind === 'soft' ? [{ id: 'wall', type: 'pressure', select: ['bnd:cyl.edge'], settings: { p: q(0, 'Pa') } }] : [];
  const amp = acoustic ? q(1, 'Pa') : q(1, o.pol === 'TM' ? 'V/m' : 'A/m');
  return {
    schema: 'amp-spec/0', id: 'w2d-cyl', title: 'cylinder scattering',
    geometry: { dim: 2, features: feats },
    materials: [{ id: 'bg', override: bg, select: ['dom:pml', 'dom:air'] }, ...(diel ? [{ id: 'core', override: { eps_r: 4, mu_r: 1 }, select: ['dom:cyl'] }] : [])],
    physics: [{ id: 'w', type: o.physics, select: ['dom:pml', 'dom:air', ...(diel ? ['dom:cyl'] : [])], ...(acoustic ? {} : { settings: { polarization: o.pol } }),
      bcs: [{ id: 'absorb', type: 'pml', select: ['dom:pml'], ...(o.R0 ? { settings: { R0: o.R0 } } : {}) },
        { id: 'inc', type: 'plane-wave', select: ['dom:air'], settings: { direction: q(0, 'deg'), amplitude: amp } }, ...wall] }],
    mesh: { size: { hmax: q(o.h, 'm') }, ...(diel ? { refine: [{ select: ['dom:cyl'], h: q(o.h / 2, 'm') }] } : {}) },
    studies: [{ id: 's', type: 'frequency', physics: ['w'], settings: acoustic ? { values: [q(343, 'Hz')] } : { wavelengths: [q(1, 'm')] } }],
  };
}
