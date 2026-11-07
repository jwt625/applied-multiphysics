// SPDX-License-Identifier: GPL-3.0-or-later
// @amp/physics registrations that supersede the provisional wave-1 seed of @amp/spec (packages/spec/src/provisional/
// wave1.ts) where L4 needs settings, and add the types the seed lacks (electrostatics). Bounds follow DevLog-003 S4.
// Result expression names per physics are listed in RESULT_NAMES (fields and scalars of the C5 Solution).

import * as z from 'zod';
import { quantity, vector, type Registration, type Registry } from '@amp/spec';
import { wave1Registry } from '@amp/spec/provisional';

const own = { owner: '@amp/physics' } as const;
const T_ABS = quantity('K', { ge: 0 });

export const L4_REGISTRATIONS: Registration[] = [
  { kind: 'physics', type: 'heat', ...own, dims: ['2d', '2d-axisym', '3d'], description: 'Heat transfer in solids: steady, or transient BDF2 from T0',
    settings: z.strictObject({ T0: T_ABS.optional() }) },
  { kind: 'physics', type: 'elastic', ...own, dims: ['2d', '3d'], description: 'Linear elasticity (small strain), P2 by default',
    settings: z.strictObject({ model: z.enum(['plane-stress', 'plane-strain', '3d']), thickness: quantity('m', { gt: 0 }).optional() }) },
  { kind: 'physics', type: 'electrostatics', ...own, dims: ['2d', '2d-axisym'], description: 'Electrostatics; terminals give the Maxwell capacitance matrix' },
  { kind: 'physics', type: 'magnetostatics', ...own, dims: ['2d-axisym'], description: 'Axisymmetric magnetostatics, A_phi; optional inductance matrix of the coils',
    settings: z.strictObject({ inductance: z.boolean().optional() }) },
  { kind: 'physics', type: 'em-modes', ...own, dims: ['2d'], description: 'Full-vector waveguide modes (Nedelec + Lagrange)',
    settings: z.strictObject({ order: z.union([z.literal(1), z.literal(2)]).optional() }) },
  { kind: 'physics', type: 'emw', ...own, dims: ['3d'], description: 'Electromagnetic eigenmodes, Nedelec order 1-2',
    settings: z.strictObject({ order: z.union([z.literal(1), z.literal(2)]).optional() }) },
  { kind: 'bc', type: 'terminal', ...own, for: ['electrostatics'], select: ['bnd'], description: 'Conductor surface; one row/column of the capacitance matrix' },
  { kind: 'bc', type: 'ground', ...own, for: ['electrostatics'], select: ['bnd'], description: 'V = 0' },
  { kind: 'bc', type: 'potential', ...own, for: ['electrostatics'], select: ['bnd'], settings: z.strictObject({ V: quantity('V') }) },
  { kind: 'bc', type: 'zero-charge', ...own, for: ['electrostatics'], select: ['bnd'], description: 'n . D = 0 (explicit)' },
  { kind: 'bc', type: 'pressure', ...own, for: ['acoustics', 'elastic'], select: ['bnd'], description: 'acoustics: p = value; elastic: normal pressure (traction -p n)',
    settings: z.strictObject({ p: quantity('Pa') }) },
];

/** Field and scalar names of each module's Solution (C5), for results[].expr ('<physics id>.<name>'). */
export const RESULT_NAMES: Record<string, { fields: string[]; scalars: string[] }> = {
  heat: { fields: ['T'], scalars: ['T_max', 'T_min'] },
  elastic: { fields: ['u', 'sxx', 'syy', 'sxy', 'szz', 'syz', 'sxz', 'mises', 's1', 's2', 's3'], scalars: ['mises_max', 'u_max'] },
  electrostatics: { fields: ['V'], scalars: ['C_<i>_<j>', 'C_per_m', 'L_per_m', 'Z0'] },
  magnetostatics: { fields: ['A_phi', 'Br', 'Bz', 'normB'], scalars: ['W_m', 'L_<i>_<j>'] },
  'em-modes': { fields: ['Ex', 'Ey', 'Ez', 'Hx', 'Hy', 'Hz', 'normE'], scalars: ['neff_<k>', 'teFraction_<k>', 'ng_<k>', 'powerW_<k>', 'lossDbPerM_<k>'] },
  emw: { fields: ['E'], scalars: ['f_<k>', 'Q_<k>'] },
  acoustics: { fields: ['p'], scalars: ['f_<k>'] },
};

export function registerPhysics(reg: Registry): Registry {
  for (const r of L4_REGISTRATIONS) reg.register(r, { replace: true });
  return reg;
}

/** Registry with the spec seed (provisional wave 1) superseded by the L4 registrations. */
export function physicsRegistry(): Registry {
  return registerPhysics(wave1Registry());
}

void vector;
