// SPDX-License-Identifier: GPL-3.0-or-later
// PROVISIONAL seed registrations for the wave-1 heroes H1-H6 (DevLog-001 s.8), written by lane L2 only so that the
// example specs in sims/ validate. They define names, settings shapes and dimensions, never values. Owners are
// expected to supersede them from their own packages with registry.register(r, {replace: true}):
//   features -> @amp/geom (L3), physics/bc/coupling/study/property -> @amp/physics (L4).
// Sub-entity names used by the examples (rect: left/right/top/bottom; circle: edge; box: xmin..zmax;
// cylinder: side/top/bottom) are proposals for L3 (DevLog-003 s.5).

import * as z from 'zod';
import { quantity, vector, nodeId, POS, NONNEG } from '../schema.ts';
import type { Registration, Registry } from '../registry.ts';
import { coreRegistry } from '../core-types.ts';

const P = { provisional: true } as const;
const geom = { ...P, owner: '@amp/geom' } as const;
const phys = { ...P, owner: '@amp/physics' } as const;

const featureIdList = z.array(nodeId).min(1);
const int = (min = 1) => z.number().int().min(min);

export const WAVE1: Registration[] = [
  // ---- geometry features -------------------------------------------------------------------------------------
  { kind: 'feature', type: 'rect', ...geom, dims: ['2d', '2d-axisym'], description: 'Axis-aligned rectangle; boundaries left/right/top/bottom',
    settings: z.strictObject({ size: vector('m', 2, POS), center: vector('m', 2) }) },
  { kind: 'feature', type: 'circle', ...geom, dims: ['2d', '2d-axisym'], description: 'Disk; boundary edge',
    settings: z.strictObject({ center: vector('m', 2), radius: quantity('m', POS) }) },
  { kind: 'feature', type: 'polygon', ...geom, dims: ['2d', '2d-axisym'], description: 'Simple polygon; boundaries e0..e(n-1)',
    settings: z.strictObject({ points: z.array(vector('m', 2)).min(3) }) },
  { kind: 'feature', type: 'box', ...geom, dims: ['3d'], description: 'Axis-aligned box; boundaries xmin/xmax/ymin/ymax/zmin/zmax',
    settings: z.strictObject({ size: vector('m', 3, POS), center: vector('m', 3) }) },
  { kind: 'feature', type: 'cylinder', ...geom, dims: ['3d'], description: 'Circular cylinder from base center along axis; boundaries side/top/bottom',
    settings: z.strictObject({ radius: quantity('m', POS), height: quantity('m', POS), base: vector('m', 3), axis: z.enum(['x', 'y', 'z']) }) },
  { kind: 'feature', type: 'union', ...geom, refs: ['inputs'], description: 'Union of earlier features (one domain)',
    settings: z.strictObject({ inputs: featureIdList }) },
  { kind: 'feature', type: 'difference', ...geom, refs: ['base', 'tools'], description: 'base minus tools; keepTools keeps the tools as separate domains',
    settings: z.strictObject({ base: nodeId, tools: featureIdList, keepTools: z.boolean().optional() }) },

  // ---- physics -----------------------------------------------------------------------------------------------
  { kind: 'physics', type: 'elastic', ...phys, dims: ['2d', '3d'], description: 'Linear elasticity (small strain)',
    settings: z.strictObject({ model: z.enum(['plane-stress', 'plane-strain', '3d']), thickness: quantity('m', POS).optional() }),
    check: (n, ctx) => {
      const model = (n.settings as { model?: string } | undefined)?.model;
      const bad = (ctx.space === '3d') !== (model === '3d');
      return bad ? [{ path: ['settings', 'model'], message: `model '${model}' does not match geometry ${ctx.space}` }] : [];
    } },
  { kind: 'physics', type: 'heat', ...phys, dims: ['1d', '2d', '2d-axisym', '3d'], description: 'Heat transfer in solids (conduction)' },
  { kind: 'physics', type: 'magnetostatics', ...phys, dims: ['2d-axisym', '3d'], description: 'Magnetostatics (A-formulation; azimuthal A in axisymmetry)' },
  { kind: 'physics', type: 'em-modes', ...phys, dims: ['2d'], description: 'Full-vector waveguide modes of a 2D cross-section' },
  { kind: 'physics', type: 'emw', ...phys, dims: ['3d'], description: 'Electromagnetic waves, frequency domain / eigenfrequency (Nedelec)' },
  { kind: 'physics', type: 'acoustics', ...phys, dims: ['2d', '2d-axisym', '3d'], description: 'Pressure acoustics, frequency domain / eigenfrequency' },

  // ---- conditions (boundary and domain) ----------------------------------------------------------------------
  { kind: 'bc', type: 'fixed', ...phys, for: ['elastic'], select: ['bnd', 'edg', 'pnt'], description: 'Zero displacement' },
  { kind: 'bc', type: 'free', ...phys, for: ['elastic'], select: ['bnd'], description: 'Zero traction (explicit)' },
  { kind: 'bc', type: 'roller', ...phys, for: ['elastic'], select: ['bnd'], description: 'Zero normal displacement (symmetry plane)' },
  { kind: 'bc', type: 'boundary-load', ...phys, for: ['elastic'], select: ['bnd'], description: 'Traction vector (force per area)',
    settings: z.strictObject({ traction: vector('Pa') }) },
  { kind: 'bc', type: 'temperature', ...phys, for: ['heat'], select: ['bnd', 'pnt'], settings: z.strictObject({ T: quantity('K', NONNEG) }) },
  { kind: 'bc', type: 'heat-flux', ...phys, for: ['heat'], select: ['bnd'], description: 'Inward heat flux', settings: z.strictObject({ q: quantity('W/m^2') }) },
  { kind: 'bc', type: 'convection', ...phys, for: ['heat'], select: ['bnd'], description: 'q = h (T_ext - T)',
    settings: z.strictObject({ h: quantity('W/(m^2*K)', NONNEG), T_ext: quantity('K', NONNEG) }) },
  { kind: 'bc', type: 'insulation', ...phys, for: ['heat'], select: ['bnd'], description: 'Zero normal heat flux (explicit)' },
  { kind: 'bc', type: 'surface-radiation', ...phys, for: ['heat'], select: ['bnd'],
    settings: z.strictObject({ emissivity: quantity('1', { ge: 0, le: 1 }), T_amb: quantity('K', NONNEG) }) },
  { kind: 'bc', type: 'heat-source', ...phys, for: ['heat'], select: ['dom'], settings: z.strictObject({ Q: quantity('W/m^3') }) },
  { kind: 'bc', type: 'coil-current', ...phys, for: ['magnetostatics'], select: ['dom'], description: 'Homogenized multi-turn coil: total current = turns * current',
    settings: z.strictObject({ turns: int(), current: quantity('A') }) },
  { kind: 'bc', type: 'magnetic-insulation', ...phys, for: ['magnetostatics'], select: ['bnd'], description: 'n x A = 0' },
  { kind: 'bc', type: 'pec', ...phys, for: ['em-modes', 'emw'], select: ['bnd'], description: 'Perfect electric conductor, n x E = 0' },
  { kind: 'bc', type: 'pmc', ...phys, for: ['em-modes', 'emw'], select: ['bnd'], description: 'Perfect magnetic conductor, n x H = 0' },
  { kind: 'bc', type: 'sound-hard', ...phys, for: ['acoustics'], select: ['bnd'], description: 'Rigid wall, zero normal velocity (explicit)' },
  { kind: 'bc', type: 'pressure', ...phys, for: ['acoustics'], select: ['bnd'], settings: z.strictObject({ p: quantity('Pa') }) },

  // ---- couplings ---------------------------------------------------------------------------------------------
  { kind: 'coupling', type: 'thermal-expansion', ...phys, for: ['heat', 'elastic'], description: 'Thermal strain alpha (T - T_ref)',
    settings: z.strictObject({ T_ref: quantity('K', NONNEG) }) },

  // ---- studies -----------------------------------------------------------------------------------------------
  { kind: 'study', type: 'stationary', ...phys },
  { kind: 'study', type: 'eigen', ...phys, description: 'Eigenfrequencies: nModes closest to shift (lowest when no shift)',
    settings: z.strictObject({ nModes: int(), shift: quantity('Hz').optional() }) },
  { kind: 'study', type: 'mode', ...phys, description: 'Mode analysis at a vacuum wavelength',
    settings: z.strictObject({ wavelength: quantity('m', POS), nModes: int(), neffShift: quantity('1').optional() }) },
  { kind: 'study', type: 'time', ...phys, settings: z.strictObject({ start: quantity('s'), stop: quantity('s'), step: quantity('s', POS) }) },
  { kind: 'study', type: 'frequency', ...phys, settings: z.strictObject({ values: z.array(quantity('Hz', POS)).min(1) }) },

  // ---- material properties (names and reference units only) --------------------------------------------------
  { kind: 'property', type: 'E', ...phys, unit: 'Pa', bounds: POS, description: "Young's modulus" },
  { kind: 'property', type: 'nu', ...phys, unit: '1', bounds: { gt: -1, lt: 0.5 }, description: "Poisson's ratio" },
  { kind: 'property', type: 'rho', ...phys, unit: 'kg/m^3', bounds: POS, description: 'Mass density' },
  { kind: 'property', type: 'k', ...phys, unit: 'W/(m*K)', bounds: NONNEG, description: 'Thermal conductivity' },
  { kind: 'property', type: 'cp', ...phys, unit: 'J/(kg*K)', bounds: POS, description: 'Specific heat capacity at constant pressure' },
  { kind: 'property', type: 'alpha', ...phys, unit: '1/K', description: 'Linear thermal expansion coefficient' },
  { kind: 'property', type: 'eps_r', ...phys, unit: '1', description: 'Relative permittivity (real part)' },
  { kind: 'property', type: 'tan_delta', ...phys, unit: '1', bounds: NONNEG, description: 'Dielectric loss tangent' },
  { kind: 'property', type: 'mu_r', ...phys, unit: '1', description: 'Relative permeability' },
  { kind: 'property', type: 'sigma', ...phys, unit: 'S/m', bounds: NONNEG, description: 'Electrical conductivity' },
  { kind: 'property', type: 'n', ...phys, unit: '1', description: 'Refractive index (real part)' },
  { kind: 'property', type: 'c', ...phys, unit: 'm/s', bounds: POS, description: 'Speed of sound' },
];

export function registerWave1(reg: Registry, opts: { replace?: boolean } = {}): Registry {
  for (const r of WAVE1) reg.register(r, opts);
  return reg;
}

/** A fresh registry with the core types (parametric study) and the provisional wave-1 types. */
export const wave1Registry = (): Registry => registerWave1(coreRegistry());
