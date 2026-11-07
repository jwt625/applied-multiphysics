// SPDX-License-Identifier: GPL-3.0-or-later
// Shared inputs of lane MT's tests and gates (DevLog-033): Euler-Bernoulli cantilever roots and the NAFEMS LE11
// axisymmetric spec (CP-02 inputs; meridian from FeenoX nafems-le11.geo via advanced-packaging-atlas
// validation/cases/B/nafems-LE11.yaml).

const q = (value: number | number[], unit: string) => ({ value, unit });

/** n-th root of the Euler-Bernoulli cantilever equation 1 + cos x cosh x = 0 (bisection in ((n - 1/2) pi +- 1)). */
export function cantileverRoot(n: number): number {
  const f = (x: number) => 1 + Math.cos(x) * Math.cosh(x);
  let a = (n - 0.5) * Math.PI - 1, b = (n - 0.5) * Math.PI + 1;
  if (n === 1) { a = 1; b = 2.5; }
  for (let i = 0; i < 200; i++) { const m = 0.5 * (a + b); if (Math.sign(f(m)) === Math.sign(f(a))) a = m; else b = m; }
  return 0.5 * (a + b);
}

/** every boundary of the LE11 meridian mesh (ids from @amp/geom for the features below) */
const LE11_BOUNDARIES = ['bnd:so.edge', 'bnd:si.edge', 'bnd:low.bottom', 'bnd:top.e1', 'bnd:top.e2', 'bnd:top.e3', 'bnd:top.e4', 'bnd:top.e5'];

export function le11Spec(hmax: number): Record<string, unknown> {
  return {
    schema: 'amp-spec/0', id: 'nafems-le11-mt', title: 'NAFEMS LE11 (axisym, MT gate)',
    params: { s: q(Math.SQRT1_2, 'm') },
    geometry: { dim: 2, axisym: true, features: [
      { id: 'so', type: 'circle', settings: { center: q([0, 0], 'm'), radius: q(1.4, 'm') } },
      { id: 'si', type: 'circle', settings: { center: q([0, 0], 'm'), radius: q(1.0, 'm') } },
      { id: 'ring', type: 'difference', settings: { base: 'so', tools: ['si'] } },
      { id: 'low', type: 'rect', settings: { size: [q(1.4, 'm'), 's'], center: [q(0.7, 'm'), 's/2'] } },
      { id: 'sph', type: 'intersection', settings: { inputs: ['ring', 'low'] } },
      { id: 'top', type: 'polygon', settings: { points: [['s', 's'], ['sqrt(1.96[m^2] - s^2)', 's'], [q(1, 'm'), 's + 0.69[m]'], [q(1, 'm'), 's + 1.09[m]'], ['s', 's + 1.09[m]'], ['s', 's + 0.69[m]']] } },
      { id: 'body', type: 'union', settings: { inputs: ['sph', 'top'] } }] },
    materials: [{ id: 'steel', select: ['dom:body'], override: { E: q(210, 'GPa'), nu: 0.3, alpha: q(2.3e-4, '1/K'), k: q(1, 'W/(m*K)') } }],
    physics: [
      { id: 'ht', type: 'heat', select: ['dom:body'], bcs: [
        { id: 'tb', type: 'temperature', select: LE11_BOUNDARIES, settings: { T: { expr: '273.15 + (r + z) / 1[m]', unit: 'K' } } },
        { id: 'src', type: 'heat-source', select: ['dom:body'], settings: { Q: { expr: '-1[m] / r', unit: 'W/m^3' } } }] },
      { id: 'solid', type: 'elastic', select: ['dom:body'], settings: { model: 'axisym' }, bcs: [
        { id: 'z0', type: 'roller', select: ['bnd:low.bottom'] }, { id: 'ztop', type: 'roller', select: ['bnd:top.e3'] }] },
    ],
    couplings: [{ id: 'th', type: 'thermal-expansion', from: 'ht', to: 'solid', settings: { Tref: q(273.15, 'K') } }],
    mesh: { size: { hmax: q(hmax, 'm') } },
    studies: [{ id: 'st', type: 'stationary', physics: ['ht', 'solid'] }],
  };
}

