// SPDX-License-Identifier: GPL-3.0-or-later
// Material property types (DevLog-013 s.1.3): name, SI reference unit, allowed value shapes and tensor symmetries.
// registerMaterialProperties() puts them into an @amp/spec registry (kind 'property'), superseding only provisional
// seed registrations; a non-provisional registration with the same dimension is left in place.

import type { Registry } from '@amp/spec';
import { parseUnit, sameDim } from './units.ts';

export type Symmetry = 'cubic' | 'uniaxial' | 'trigonal-3m';
export type Variable = 'T' | 'lambda' | 'f';

export interface PropertyDef {
  name: string;
  /** SI reference unit (values returned by getProperty are in this unit). */
  unit: string;
  description: string;
  /** Value shapes: scalar and/or tensor with these symmetries. */
  scalar: boolean;
  tensor: readonly Symmetry[];
}

export const PROPERTY_DEFS: readonly PropertyDef[] = [
  { name: 'rho', unit: 'kg/m^3', description: 'Mass density', scalar: true, tensor: [] },
  { name: 'E', unit: 'Pa', description: "Young's modulus (isotropic)", scalar: true, tensor: [] },
  { name: 'nu', unit: '1', description: "Poisson's ratio (isotropic)", scalar: true, tensor: [] },
  { name: 'G', unit: 'Pa', description: 'Shear modulus (isotropic)', scalar: true, tensor: [] },
  { name: 'C', unit: 'Pa', description: 'Elastic stiffness tensor, Voigt notation, crystal frame', scalar: false, tensor: ['cubic'] },
  { name: 'k', unit: 'W/(m*K)', description: 'Thermal conductivity', scalar: true, tensor: ['uniaxial'] },
  { name: 'cp', unit: 'J/(kg*K)', description: 'Specific heat capacity at constant pressure', scalar: true, tensor: [] },
  { name: 'alpha', unit: '1/K', description: 'Linear thermal expansion coefficient (cte_kind: instantaneous | secant with T_ref)', scalar: true, tensor: ['uniaxial'] },
  { name: 'eps_r', unit: '1', description: 'Relative permittivity (real part)', scalar: true, tensor: ['uniaxial'] },
  { name: 'tan_delta', unit: '1', description: 'Dielectric loss tangent', scalar: true, tensor: ['uniaxial'] },
  { name: 'mu_r', unit: '1', description: 'Relative permeability', scalar: true, tensor: [] },
  { name: 'sigma', unit: 'S/m', description: 'Electrical conductivity', scalar: true, tensor: [] },
  { name: 'rho_e', unit: 'ohm*m', description: 'Electrical resistivity', scalar: true, tensor: [] },
  { name: 'n', unit: '1', description: 'Refractive index (real part); uniaxial: perp = n_o, par = n_e', scalar: true, tensor: ['uniaxial'] },
  { name: 'dndT', unit: '1/K', description: 'Thermo-optic coefficient dn/dT', scalar: true, tensor: ['uniaxial'] },
  { name: 'r_eo', unit: 'm/V', description: 'Linear electro-optic (Pockels) tensor r_ij, Voigt rows, crystal frame', scalar: false, tensor: ['trigonal-3m'] },
  { name: 'c', unit: 'm/s', description: 'Speed of sound', scalar: true, tensor: [] },
  { name: 'mu', unit: 'Pa*s', description: 'Dynamic viscosity', scalar: true, tensor: [] },
];

export const PROPERTY_BY_NAME: ReadonlyMap<string, PropertyDef> = new Map(PROPERTY_DEFS.map((d) => [d.name, d]));

/** Independent components per symmetry; matrices are built by tensorMatrix(). */
export const SYMMETRY_COMPONENTS: Record<Symmetry, readonly string[]> = {
  cubic: ['C11', 'C12', 'C44'],
  uniaxial: ['perp', 'par'],
  'trigonal-3m': ['r13', 'r22', 'r33', 'r51'],
};

/**
 * Full matrix of a tensor property from its independent components (SI values).
 * - cubic C: 6x6 Voigt stiffness.
 * - uniaxial: 3x3 diagonal diag(perp, perp, par), optic / c axis = frame z.
 * - trigonal-3m r: 6x3 Voigt rows (xx, yy, zz, yz, xz, xy) x field (x, y, z), mirror plane = y-z, c axis = z:
 *   [[0, -r22, r13], [0, r22, r13], [0, 0, r33], [0, r51, 0], [r51, 0, 0], [-r22, 0, 0]].
 */
export function tensorMatrix(symmetry: Symmetry, c: Record<string, number>): number[][] {
  const g = (k: string): number => {
    const v = c[k];
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`tensor component ${k} missing or N/A`);
    return v;
  };
  if (symmetry === 'cubic') {
    const [a, b, d] = [g('C11'), g('C12'), g('C44')];
    return [
      [a, b, b, 0, 0, 0], [b, a, b, 0, 0, 0], [b, b, a, 0, 0, 0],
      [0, 0, 0, d, 0, 0], [0, 0, 0, 0, d, 0], [0, 0, 0, 0, 0, d],
    ];
  }
  if (symmetry === 'uniaxial') {
    const [p, q] = [g('perp'), g('par')];
    return [[p, 0, 0], [0, p, 0], [0, 0, q]];
  }
  const [r13, r22, r33, r51] = [g('r13'), g('r22'), g('r33'), g('r51')];
  return [[0, -r22, r13], [0, r22, r13], [0, 0, r33], [0, r51, 0], [r51, 0, 0], [-r22, 0, 0]];
}

/**
 * Register the property types in an @amp/spec registry (kind 'property'). Provisional seeds are superseded; an
 * existing non-provisional registration is kept when its dimension agrees and is an error otherwise.
 * Returns the names registered or replaced.
 */
export function registerMaterialProperties(reg: Registry): string[] {
  const done: string[] = [];
  for (const d of PROPERTY_DEFS) {
    const prev = reg.get('property', d.name);
    if (prev && !prev.provisional) {
      if (!prev.unit || !sameDim(parseUnit(prev.unit).dim, parseUnit(d.unit).dim))
        throw new Error(`property '${d.name}': registered unit '${prev.unit}' differs in dimension from '${d.unit}'`);
      continue;
    }
    reg.register({
      kind: 'property', type: d.name, unit: d.unit, description: d.description, owner: '@amp/materials',
      scalar: d.scalar,
      tensor: Object.fromEntries(d.tensor.map((s) => [s, SYMMETRY_COMPONENTS[s]])),
    }, { replace: !!prev });
    done.push(d.name);
  }
  return done;
}
