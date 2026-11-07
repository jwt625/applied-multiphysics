// SPDX-License-Identifier: GPL-3.0-or-later
// Material property types (DevLog-013 s.1.3): name, SI reference unit, allowed value shapes and tensor symmetries.
// registerMaterialProperties() puts them into an @amp/spec registry (kind 'property'), superseding only provisional
// seed registrations; a non-provisional registration with the same dimension is left in place.

import type { Registry } from '@amp/spec';
import { parseUnit, sameDim } from './units.ts';

export type Symmetry = 'cubic' | 'uniaxial' | 'trigonal-3m' | 'hexagonal-6mm' | 'tetragonal-4mm';
export type Variable = 'T' | 'lambda' | 'f';

export interface PropertyDef {
  name: string;
  /** SI reference unit (values returned by getProperty are in this unit). */
  unit: string;
  description: string;
  /** Value shapes: scalar and/or tensor with these symmetries. */
  scalar: boolean;
  tensor: readonly Symmetry[];
  /** Independent components per symmetry when they differ from SYMMETRY_COMPONENTS (C, e_piezo; DevLog-031 X1). */
  components?: Partial<Record<Symmetry, readonly string[]>>;
}

export const PROPERTY_DEFS: readonly PropertyDef[] = [
  { name: 'rho', unit: 'kg/m^3', description: 'Mass density', scalar: true, tensor: [] },
  { name: 'E', unit: 'Pa', description: "Young's modulus (isotropic)", scalar: true, tensor: [] },
  { name: 'nu', unit: '1', description: "Poisson's ratio (isotropic)", scalar: true, tensor: [] },
  { name: 'G', unit: 'Pa', description: 'Shear modulus (isotropic)', scalar: true, tensor: [] },
  { name: 'C', unit: 'Pa', description: 'Elastic stiffness tensor c^E, Voigt notation, crystal frame (z = c / poling axis)', scalar: false, tensor: ['cubic', 'hexagonal-6mm', 'tetragonal-4mm', 'trigonal-3m'],
    components: { 'hexagonal-6mm': ['C11', 'C12', 'C13', 'C33', 'C44'], 'tetragonal-4mm': ['C11', 'C12', 'C13', 'C33', 'C44', 'C66'], 'trigonal-3m': ['C11', 'C12', 'C13', 'C14', 'C33', 'C44'] } },
  { name: 'e_piezo', unit: 'C/m^2', description: 'Piezoelectric stress constants e (3x6 Voigt, crystal frame, z = c / poling axis)', scalar: false, tensor: ['hexagonal-6mm', 'tetragonal-4mm', 'trigonal-3m'],
    components: { 'hexagonal-6mm': ['e15', 'e31', 'e33'], 'tetragonal-4mm': ['e15', 'e31', 'e33'], 'trigonal-3m': ['e15', 'e22', 'e31', 'e33'] } },
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

/** Default independent components per symmetry (C and e_piezo state their own in PropertyDef.components). */
export const SYMMETRY_COMPONENTS: Record<Symmetry, readonly string[]> = {
  cubic: ['C11', 'C12', 'C44'],
  uniaxial: ['perp', 'par'],
  'trigonal-3m': ['r13', 'r22', 'r33', 'r51'],
  'hexagonal-6mm': ['C11', 'C12', 'C13', 'C33', 'C44'],
  'tetragonal-4mm': ['C11', 'C12', 'C13', 'C33', 'C44', 'C66'],
};

/** Independent components of a property for a symmetry. */
export const tensorComponents = (def: PropertyDef, s: Symmetry): readonly string[] => def.components?.[s] ?? SYMMETRY_COMPONENTS[s];

/**
 * Full matrix of a tensor property from its independent components (SI values). Voigt order (xx, yy, zz, yz, xz, xy),
 * crystal frame, z = c / optic / poling axis; for trigonal-3m x = a axis and mirror plane = y-z (the matrix forms of
 * @amp/physics coupled/tensors.ts, lane MT, so one convention holds for the library and the solvers).
 * - C (6x6 Voigt stiffness): cubic C11 C12 C44; hexagonal-6mm C11 C12 C13 C33 C44 with C66 = (C11 - C12) / 2;
 *   tetragonal-4mm as 6mm with an independent C66; trigonal-3m C11 C12 C13 C14 C33 C44:
 *   [[C11, C12, C13, C14, 0, 0], [C12, C11, C13, -C14, 0, 0], [C13, C13, C33, 0, 0, 0], [C14, -C14, 0, C44, 0, 0],
 *    [0, 0, 0, 0, C44, C14], [0, 0, 0, 0, C14, (C11 - C12) / 2]].
 * - e_piezo (3x6): 6mm / 4mm [[0, 0, 0, 0, e15, 0], [0, 0, 0, e15, 0, 0], [e31, e31, e33, 0, 0, 0]];
 *   trigonal-3m [[0, 0, 0, 0, e15, -e22], [-e22, e22, 0, e15, 0, 0], [e31, e31, e33, 0, 0, 0]].
 * - uniaxial: 3x3 diagonal diag(perp, perp, par), optic / c axis = frame z.
 * - r_eo trigonal-3m: 6x3 Voigt rows (xx, yy, zz, yz, xz, xy) x field (x, y, z), mirror plane = y-z, c axis = z:
 *   [[0, -r22, r13], [0, r22, r13], [0, 0, r33], [0, r51, 0], [r51, 0, 0], [-r22, 0, 0]].
 * `prop` selects the form where a symmetry is shared (trigonal-3m: C, e_piezo, r_eo; default r_eo / C as before).
 */
export function tensorMatrix(symmetry: Symmetry, c: Record<string, number>, prop?: string): number[][] {
  const g = (k: string): number => {
    const v = c[k];
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`tensor component ${k} missing or N/A`);
    return v;
  };
  if (prop === 'e_piezo') {
    if (symmetry === 'trigonal-3m') { const [e15, e22, e31, e33] = [g('e15'), g('e22'), g('e31'), g('e33')]; return [[0, 0, 0, 0, e15, -e22], [-e22, e22, 0, e15, 0, 0], [e31, e31, e33, 0, 0, 0]]; }
    const [e15, e31, e33] = [g('e15'), g('e31'), g('e33')];
    return [[0, 0, 0, 0, e15, 0], [0, 0, 0, e15, 0, 0], [e31, e31, e33, 0, 0, 0]];
  }
  if (symmetry === 'hexagonal-6mm' || symmetry === 'tetragonal-4mm') {
    const [a, b, d, z, f] = [g('C11'), g('C12'), g('C13'), g('C33'), g('C44')];
    const h = symmetry === 'tetragonal-4mm' ? g('C66') : (a - b) / 2;
    return [[a, b, d, 0, 0, 0], [b, a, d, 0, 0, 0], [d, d, z, 0, 0, 0], [0, 0, 0, f, 0, 0], [0, 0, 0, 0, f, 0], [0, 0, 0, 0, 0, h]];
  }
  if (symmetry === 'trigonal-3m' && prop === 'C') {
    const [a, b, d, q, z, f] = [g('C11'), g('C12'), g('C13'), g('C14'), g('C33'), g('C44')];
    return [[a, b, d, q, 0, 0], [b, a, d, -q, 0, 0], [d, d, z, 0, 0, 0], [q, -q, 0, f, 0, 0], [0, 0, 0, 0, f, q], [0, 0, 0, 0, q, (a - b) / 2]];
  }
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
      tensor: Object.fromEntries(d.tensor.map((s) => [s, tensorComponents(d, s)])),
    }, { replace: !!prev });
    done.push(d.name);
  }
  return done;
}
