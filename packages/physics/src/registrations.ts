// SPDX-License-Identifier: GPL-3.0-or-later
// @amp/physics registrations that supersede the provisional wave-1 seed of @amp/spec (packages/spec/src/provisional/
// wave1.ts) where L4 needs settings, and add the types the seed lacks (electrostatics). Bounds follow DevLog-003 S4.
// Result expression names per physics are listed in RESULT_NAMES (fields and scalars of the C5 Solution).

import * as z from 'zod';
import { quantity, vector, field, type Registration, type Registry } from '@amp/spec';
import { wave1Registry } from '@amp/spec/provisional';
import { registerGeomFeatures } from '@amp/geom/spec';
import { registerMaterialProperties } from '@amp/materials';
import { COUPLING_REGISTRATIONS } from './couplings/index.ts';
import { crystalsSchema } from './couplings/photonic.ts';
import { RESULT_NAMES_COUPLED } from './modes/coupled.ts';

const own = { owner: '@amp/physics' } as const;

export const L4_REGISTRATIONS: Registration[] = [
  { kind: 'physics', type: 'heat', ...own, dims: ['2d', '2d-axisym', '3d'], description: 'Heat transfer in solids: steady, or transient (bdf1, bdf2, crank-nicolson) from the initial field T0',
    settings: z.strictObject({ T0: field('K', { bounds: { ge: 0 }, vars: 'space' }).optional() }) },
  { kind: 'physics', type: 'elastic', ...own, dims: ['2d', '2d-axisym', '3d'], description: 'Linear elasticity (small strain), P2 by default; stationary, or eigenfrequencies (eigen study); axisym = axisymmetric (r, z), azimuthal order 0',
    settings: z.strictObject({ model: z.enum(['plane-stress', 'plane-strain', '3d', 'axisym']), thickness: quantity('m', { gt: 0 }).optional() }),
    check: (n, ctx) => {
      const model = (n.settings as { model?: string } | undefined)?.model;
      const want = ctx.space === '3d' ? ['3d'] : ctx.space === '2d-axisym' ? ['axisym'] : ['plane-stress', 'plane-strain'];
      return model && ctx.space && !want.includes(model) ? [{ path: ['settings', 'model'], message: `model '${model}' does not match geometry ${ctx.space} (use ${want.join(' or ')})` }] : [];
    } },
  { kind: 'physics', type: 'electrostatics', ...own, dims: ['2d', '2d-axisym', '3d'], description: 'Electrostatics; terminals give the Maxwell capacitance matrix',
    settings: z.strictObject({ crystals: crystalsSchema.optional() }) },
  { kind: 'physics', type: 'magnetostatics', ...own, dims: ['2d-axisym'], description: 'Axisymmetric magnetostatics, A_phi; optional inductance matrix of the coils',
    settings: z.strictObject({ inductance: z.boolean().optional() }) },
  { kind: 'physics', type: 'em-modes', ...own, dims: ['2d'], description: 'Full-vector waveguide modes (Nedelec + Lagrange)',
    settings: z.strictObject({ order: z.union([z.literal(1), z.literal(2)]).optional(), crystals: crystalsSchema.optional() }) },
  { kind: 'physics', type: 'emw', ...own, dims: ['3d'], description: 'Electromagnetic eigenmodes, Nedelec order 1-2',
    settings: z.strictObject({ order: z.union([z.literal(1), z.literal(2)]).optional() }) },
  { kind: 'physics', type: 'acoustics', ...own, dims: ['2d', '2d-axisym', '3d'], description: 'Pressure acoustics eigenfrequencies; order 2 (default) = P2 on tet10 / tri6, order 1 = P1 / Q1 hex',
    settings: z.strictObject({ order: z.union([z.literal(1), z.literal(2)]).optional() }) },
  { kind: 'physics', type: 'emw-axisym', ...own, dims: ['2d-axisym'], description: 'Electromagnetic eigenmodes of a body of revolution, per azimuthal order m (meridional Nedelec + Lagrange); the 3D emw path stays available',
    settings: z.strictObject({ azimuthal: z.array(z.number().int().min(0).max(64)).min(1), order: z.union([z.literal(1), z.literal(2)]).optional() }) },
  { kind: 'bc', type: 'pec', ...own, for: ['emw-axisym'], select: ['bnd'], description: 'Perfect electric conductor, n x E = 0 (meridional boundary)' },
  { kind: 'bc', type: 'terminal', ...own, for: ['electrostatics'], select: ['bnd'], description: 'Conductor surface; one row/column of the capacitance matrix' },
  { kind: 'bc', type: 'ground', ...own, for: ['electrostatics'], select: ['bnd'], description: 'V = 0' },
  { kind: 'bc', type: 'potential', ...own, for: ['electrostatics'], select: ['bnd'], settings: z.strictObject({ V: field('V', { vars: 'space' }) }) },
  { kind: 'bc', type: 'zero-charge', ...own, for: ['electrostatics'], select: ['bnd'], description: 'n . D = 0 (explicit)' },
  // DC currents (lane MC, DevLog-031); BC names scoped to 'currents'
  { kind: 'physics', type: 'currents', ...own, dims: ['2d', '2d-axisym', '3d'], description: 'Electric currents, DC conduction -div(sigma grad V) = 0; terminal currents, resistance, Joule heat density',
    settings: z.strictObject({
      thickness: quantity('m', { gt: 0 }).optional(),
      outOfPlane: z.strictObject({ Ez: quantity('V/m').optional(), V: quantity('V').optional(), length: quantity('m', { gt: 0 }).optional(), I: quantity('A').optional() }).optional()
        .meta({ description: '2D section of long conductors driven along the out-of-plane axis: uniform E_z = V / length, or I / int sigma dA, or Ez (no in-plane solve)' }),
    }) },
  { kind: 'bc', type: 'ground', ...own, for: ['currents'], select: ['bnd'], description: 'V = 0' },
  { kind: 'bc', type: 'potential', ...own, for: ['currents'], select: ['bnd'], settings: z.strictObject({ V: field('V', { vars: 'space' }) }) },
  { kind: 'bc', type: 'terminal', ...own, for: ['currents'], select: ['bnd'], description: 'Electrode at a terminal voltage V, or carrying a total current I into the domain (sets its voltage)',
    settings: z.strictObject({ V: quantity('V').optional(), I: quantity('A').optional() }),
    check: (n) => {
      const s = (n.settings ?? {}) as { V?: unknown; I?: unknown };
      return (s.V === undefined) === (s.I === undefined) ? [{ path: ['settings'], message: 'terminal: give exactly one of V or I' }] : [];
    } },
  { kind: 'bc', type: 'insulation', ...own, for: ['currents'], select: ['bnd'], description: 'Electric insulation, n . J = 0 (explicit)' },
  ...COUPLING_REGISTRATIONS,
];

/** Field and scalar names of each module's Solution (C5), for results[].expr ('<physics id>.<name>'). */
export const RESULT_NAMES: Record<string, { fields: string[]; scalars: string[] }> = {
  heat: { fields: ['T'], scalars: ['T_max', 'T_min', 'Q_total'] },
  elastic: { fields: ['u', 'sxx', 'syy', 'sxy', 'szz', 'syz', 'sxz', 'srr', 'sphi', 'srz', 'mises', 's1', 's2', 's3'], scalars: ['mises_max', 'u_max', 'f_<k>'] },
  electrostatics: { fields: ['V'], scalars: ['C_<i>_<j>', 'C_per_m', 'L_per_m', 'Z0'] },
  magnetostatics: { fields: ['A_phi', 'Br', 'Bz', 'normB'], scalars: ['W_m', 'L_<i>_<j>'] },
  'em-modes': { fields: ['Ex', 'Ey', 'Ez', 'Hx', 'Hy', 'Hz', 'normE'], scalars: ['neff_<k>', 'teFraction_<k>', 'ng_<k>', 'powerW_<k>', 'lossDbPerM_<k>', ...RESULT_NAMES_COUPLED.thermo, ...RESULT_NAMES_COUPLED.eo] },
  emw: { fields: ['E', 'E_nodal'], scalars: ['f_<k>', 'Q_<k>'] },
  'emw-axisym': { fields: ['E_rphiz (meridional E_r, E_phi, E_z; 3D: reconstruct3D)'], scalars: ['f_<k>', 'm_<k>', 'ezFraction_<k>'] },
  acoustics: { fields: ['p'], scalars: ['f_<k>'] },
  // monolithic couplings (lane MT): fields keep their physics tags (u: elastic, V: electrostatics, p: acoustics)
  piezoelectric: { fields: ['u', 'V'], scalars: ['f_<k>'] },
  'acoustic-structure': { fields: ['u', 'p'], scalars: ['f_<k>'] },
  // optomechanical (lane MOM, DevLog-034): pair scalars per optical mode i and mechanical mode j, g/2pi in Hz and Hz/m;
  // merged keys <elastic id>.<name> plus the bare name; per-mode elastic f_/meff_/xzpf_<j>, emw-axisym f_/m_/ezFraction_<i>
  optomechanical: { fields: ['u', 'E_rphiz'], scalars: ['g0_<i>_<j>', 'g0MB_<i>_<j>', 'g0PE_<i>_<j>', 'gOM_<i>_<j>', 'gOMMB_<i>_<j>', 'gOMPE_<i>_<j>', 'f_<j>', 'meff_<j>', 'xzpf_<j>'] },
  currents: { fields: ['V', 'E', 'J', 'Q'], scalars: ['I_<t>', 'V_<t>', 'R_<t>', 'G_<i>_<j>', 'P', 'Ez', 'I', 'V', 'R', 'R_per_length'] },
};

export function registerPhysics(reg: Registry): Registry {
  for (const r of L4_REGISTRATIONS) reg.register(r, { replace: true });
  return reg;
}

/**
 * Registry with the spec seed (provisional wave 1) superseded by the material property types of @amp/materials
 * (tensor forms, dndT, r_eo, ...; DevLog-031 R0) and then by the L4 registrations. The seed's physical bounds of a
 * property (e.g. E > 0) are kept on the @amp/materials registration, which has none.
 */
export function physicsRegistry(): Registry {
  const reg = registerGeomFeatures(wave1Registry());
  const seedBounds = new Map(reg.list('property').filter((r) => r.bounds).map((r) => [r.type, r.bounds!]));
  for (const name of registerMaterialProperties(reg)) {
    const b = seedBounds.get(name), r = reg.get('property', name);
    if (b && r && !r.bounds) reg.register({ ...r, bounds: b }, { replace: true });
  }
  const mat = new Map(reg.list('property').map((r) => [r.type, r]));
  registerPhysics(reg);
  // a property that @amp/physics re-registers (e.g. the provisional piezo C, eps_r of lane MT) keeps the
  // @amp/materials forms as well: tensor symmetries are merged, a scalar form stays allowed when either allows it
  for (const [name, m] of mat) {
    const r = reg.get('property', name);
    if (!r || r === m) continue;
    // merged = settled (not provisional): a later registerMaterialProperties keeps it instead of re-imposing its own forms
    reg.register({ ...r, provisional: false, owner: '@amp/physics + @amp/materials', tensor: { ...(m.tensor ?? {}), ...(r.tensor ?? {}) }, scalar: r.scalar !== false || m.scalar !== false, ...(r.bounds ?? m.bounds ? { bounds: r.bounds ?? m.bounds } : {}) }, { replace: true });
  }
  return reg;
}

void vector;
