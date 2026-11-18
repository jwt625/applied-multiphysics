// SPDX-License-Identifier: GPL-3.0-or-later
// Material dispersion for mode solvers (DevLog-041 s.4, lane S2): refractive index, its wavelength derivative, the
// group index n_g = n - lambda dn/dlambda, and the complex index / permittivity where an extinction coefficient is
// stored. Everything is evaluated through Library.getProperty (vacuum wavelength in m, n relative to vacuum), so the
// provenance, validity ranges and air-to-vacuum conversion of the stored data apply unchanged.

import type { EvalOptions, Library, PropertyValue } from './library.ts';

export interface DispersionResult {
  material: string;
  /** Vacuum wavelength, m. */
  lambda: number;
  /** Refractive index (real part) relative to vacuum. */
  n: number;
  /** dn / dlambda, 1/m (central difference of the stored n over +-h). */
  dn_dlambda: number;
  /** Group index n - lambda dn/dlambda. */
  ng: number;
  /** Extinction coefficient when the material stores `kappa` at this wavelength. */
  kappa?: number;
  /** Complex relative permittivity (n + i kappa)^2 = epsRe + i epsIm (kappa 0 when not stored). */
  epsRe: number;
  epsIm: number;
  /** Half step of the central difference, m. */
  h: number;
  /**
   * 'smooth' when n is a fit (formula), 'piecewise-linear' when it is a table: then dn/dlambda is the slope of the
   * table segment(s) around lambda and is only as good as the node spacing (stated, not hidden).
   */
  derivative: 'smooth' | 'piecewise-linear' | 'constant';
  nValue: PropertyValue;
  kappaValue?: PropertyValue;
  extrapolated: boolean;
}

export interface DispersionOptions extends Omit<EvalOptions, 'lambda'> {
  /** Relative half step for the central difference (default 1e-4, i.e. 0.155 nm at 1550 nm). */
  relStep?: number;
}

function form(lib: Library, id: string, prop: string, alt?: string): 'smooth' | 'piecewise-linear' | 'constant' {
  const leaf = lib.get(id)?.properties[prop];
  const l = alt === undefined ? leaf : leaf?.alternatives.find((a) => a.id === alt);
  if (!l) return 'constant';
  if (l.fit) return 'smooth';
  if (l.table) return 'piecewise-linear';
  if (l.tensor) {
    const c = Object.values(l.tensor.components)[0];
    if (typeof c === 'object' && c !== null && 'fit' in c && c.fit) return 'smooth';
    if (typeof c === 'object' && c !== null && 'table' in c && c.table) return 'piecewise-linear';
  }
  return 'constant';
}

const num = (v: PropertyValue): number => {
  if (typeof v.value !== 'number') throw new Error(`${v.material}.${v.property} is a tensor: pass {component: 'perp' | 'par'}`);
  return v.value;
};

/**
 * n, dn/dlambda, n_g and complex permittivity at vacuum wavelength `lambda` (m). Uniaxial materials need
 * `component` ('perp' = ordinary, 'par' = extraordinary). Throws MaterialRangeError outside the stored validity
 * unless `extrapolate`. kappa is read only when the material has a `kappa` property (same component and alternative
 * rules do not apply to kappa: its default leaf is used).
 */
export function dispersion(lib: Library, materialId: string, lambda: number, opts: DispersionOptions = {}): DispersionResult {
  const { relStep = 1e-4, ...o } = opts;
  const h = relStep * lambda;
  const at = (l: number): PropertyValue => lib.getProperty(materialId, 'n', { ...o, lambda: l });
  const nValue = at(lambda);
  const n = num(nValue);
  const derivative = form(lib, materialId.replace(/^materials\//, ''), 'n', o.alternative);
  let dn = 0;
  let extrapolated = nValue.extrapolated === true;
  if (derivative !== 'constant') {
    const p = at(lambda + h), m = at(lambda - h);
    extrapolated ||= p.extrapolated === true || m.extrapolated === true;
    dn = (num(p) - num(m)) / (2 * h);
  }
  const out: DispersionResult = {
    material: nValue.material, lambda, n, dn_dlambda: dn, ng: n - lambda * dn, epsRe: n * n, epsIm: 0, h, derivative, nValue, extrapolated,
  };
  const doc = lib.get(materialId);
  if (doc?.properties.kappa && doc.properties.kappa.value !== 'N/A') {
    const kv = lib.getProperty(materialId, 'kappa', { T: o.T, lambda, component: o.component, extrapolate: o.extrapolate });
    const k = num(kv);
    out.kappa = k;
    out.kappaValue = kv;
    out.epsRe = n * n - k * k;
    out.epsIm = 2 * n * k;
    out.extrapolated ||= kv.extrapolated === true;
  }
  return out;
}

/** Complex refractive index N = n + i kappa and eps = N^2 at vacuum wavelength `lambda` (m); kappa 0 if not stored. */
export function complexIndex(lib: Library, materialId: string, lambda: number, opts: Omit<EvalOptions, 'lambda'> = {}): { n: number; kappa: number; epsRe: number; epsIm: number } {
  const n = num(lib.getProperty(materialId, 'n', { ...opts, lambda }));
  const doc = lib.get(materialId);
  const k = doc?.properties.kappa && doc.properties.kappa.value !== 'N/A' ? num(lib.getProperty(materialId, 'kappa', { T: opts.T, lambda, component: opts.component, extrapolate: opts.extrapolate })) : 0;
  return { n, kappa: k, epsRe: n * n - k * k, epsIm: 2 * n * k };
}
