// SPDX-License-Identifier: GPL-3.0-or-later
// Spec builders and helpers of the Bloch / Floquet gate tests (DevLog-050 s.1.5). Lengths in metres; material values
// are test inputs. Frequencies are reported in Hz by the solver; c0 = 299792458 m/s (SI defining constant).

import { readFileSync } from 'node:fs';
import { prepareRun } from '../src/index.ts';
import { emw2dModule } from '../src/wave2d/index.ts';
import type { Mesh, Solution } from '@amp/spec/types';

export const C0 = 299792458;
export const VERBOSE = !!process.env.W2D_VERBOSE;
export const log = (...a: unknown[]) => { if (VERBOSE) console.log('[bloch]', ...a); };
export const bref = <T = Record<string, unknown>>(name: string): T => JSON.parse(readFileSync(new URL(`../../../validation/bloch/${name}`, import.meta.url), 'utf8')) as T;

const q = (v: number | number[], unit: string) => ({ value: v, unit });
export const rect = (id: string, x0: number, x1: number, y0: number, y1: number) => ({ id, type: 'rect', settings: { center: q([(x0 + x1) / 2, (y0 + y1) / 2], 'm'), size: q([x1 - x0, y1 - y0], 'm') } });

export interface BandsSol extends Solution {
  wave2d: { bands: { f: number[][]; k: Array<[number, number]>; kReduced: number[][]; labels: Array<{ index: number; label: string }>; lattice: { a: Array<[number, number]>; b: Array<[number, number]> }; fieldSteps: Array<{ step: number; label: string; k: number; band: number }> } };
  notes?: string[];
}

export async function runSpec<T extends Solution = BandsSol>(spec: Record<string, unknown>): Promise<{ sol: T; mesh: Mesh; ms: number }> {
  const p = await prepareRun(spec, {});
  const t0 = performance.now();
  const sol = (await emw2dModule.run(p)) as T;
  return { sol, mesh: p.mesh, ms: performance.now() - t0 };
}

export const SQUARE_PATH = [{ label: 'Gamma', k: [0, 0] }, { label: 'X', k: [0.5, 0] }, { label: 'M', k: [0.5, 0.5] }, { label: 'Gamma', k: [0, 0] }];

/** Square (or rectangular) unit cell [0, ax] x [0, ay] with optional centred rod, periodic in x and y. */
export function cellSpec(o: { ax: number; ay: number; h: number; pol: 'TM' | 'TE'; epsBg: number; rod?: { r: number; eps: number; h: number }; layers?: { d1: number; eps1: number; eps2: number };
  study: Record<string, unknown>; kx?: number; ky?: number }): Record<string, unknown> {
  const feats: unknown[] = [rect('cell', 0, o.ax, 0, o.ay)];
  const mats: unknown[] = [];
  const doms = ['dom:cell'];
  if (o.rod) {
    feats.push({ id: 'disk', type: 'circle', settings: { center: q([o.ax / 2, o.ay / 2], 'm'), radius: q(o.rod.r, 'm') } });
    feats.push({ id: 'bg', type: 'difference', settings: { base: 'cell', tools: ['disk'], keepTools: true } });
    doms.splice(0, 1, 'dom:bg', 'dom:disk');
    mats.push({ id: 'm_bg', override: { eps_r: o.epsBg, mu_r: 1 }, select: ['dom:bg'] }, { id: 'm_rod', override: { eps_r: o.rod.eps, mu_r: 1 }, select: ['dom:disk'] });
  } else if (o.layers) {
    // layer 1 at x in [0, d1], layer 2 at x in [d1, ax]
    feats.splice(0, 1, rect('l1', 0, o.layers.d1, 0, o.ay), rect('l2', o.layers.d1, o.ax, 0, o.ay));
    doms.splice(0, 1, 'dom:l1', 'dom:l2');
    mats.push({ id: 'm1', override: { eps_r: o.layers.eps1, mu_r: 1 }, select: ['dom:l1'] }, { id: 'm2', override: { eps_r: o.layers.eps2, mu_r: 1 }, select: ['dom:l2'] });
  } else mats.push({ id: 'm_bg', override: { eps_r: o.epsBg, mu_r: 1 }, select: ['dom:cell'] });
  const sides = o.layers ? { left: 'bnd:l1.left', right: 'bnd:l2.right', bottom: ['bnd:l1.bottom', 'bnd:l2.bottom'], top: ['bnd:l1.top', 'bnd:l2.top'] }
    : { left: 'bnd:cell.left', right: 'bnd:cell.right', bottom: ['bnd:cell.bottom'], top: ['bnd:cell.top'] };
  return {
    schema: 'amp-spec/0', id: 'bloch-cell', title: 'Bloch unit cell',
    geometry: { dim: 2, features: feats },
    materials: mats,
    physics: [{ id: 'w', type: 'emw-2d', select: doms, settings: { polarization: o.pol },
      bcs: [{ id: 'px', type: 'periodic', select: [sides.left, sides.right], ...(o.kx !== undefined ? { settings: { k: o.kx } } : {}) },
        { id: 'py', type: 'periodic', select: [...sides.bottom, ...sides.top], ...(o.ky !== undefined ? { settings: { k: o.ky } } : {}) }] }],
    mesh: { size: { hmax: q(o.h, 'm') }, ...(o.rod ? { refine: [{ select: ['bnd:disk.edge'], h: q(o.rod.h, 'm') }] } : {}) },
    studies: [{ id: 's', physics: ['w'], ...o.study }],
  };
}

/** Empty-lattice frequencies (Hz): c0 |k + G| / (2 pi n) over the reciprocal lattice of an ax x ay cell, lowest nb. */
export function emptyLattice(k: [number, number], ax: number, ay: number, n: number, nb: number): number[] {
  const out: number[] = [];
  for (let m1 = -6; m1 <= 6; m1++) for (let m2 = -6; m2 <= 6; m2++) out.push((C0 * Math.hypot(k[0] + (2 * Math.PI * m1) / ax, k[1] + (2 * Math.PI * m2) / ay)) / (2 * Math.PI * n));
  return out.sort((a, b) => a - b).slice(0, nb);
}
