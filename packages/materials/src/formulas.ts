// SPDX-License-Identifier: GPL-3.0-or-later
// Fit formulas referenced by `fit.formula` in materials/*.yaml (DevLog-013). Each formula takes its variables in the
// units declared by the fit's `vars` (e.g. lambda in um, T in K) and returns the property in the leaf's `unit`.
// Coefficients come from the YAML file only; no coefficient is stored here.

export type Coeffs = Record<string, number | number[]>;

export interface Formula {
  id: string;
  vars: readonly string[];
  /** Coefficient names and whether each is an array. */
  coeffs: Record<string, 'number' | 'array'>;
  description: string;
  evaluate(x: Record<string, number>, c: Coeffs): number;
}

const num = (c: Coeffs, k: string): number => c[k] as number;
const arr = (c: Coeffs, k: string): number[] => c[k] as number[];
const polyval = (a: readonly number[], x: number): number => a.reduceRight((s, ai) => s * x + ai, 0);
const dpolyval = (a: readonly number[], x: number): number => a.reduceRight((s, ai, i) => (i === 0 ? s : s * x + i * ai), 0);

function sellmeier(lambda: number, c: Coeffs, squared: boolean): number {
  const B = arr(c, 'B'), C = arr(c, 'C');
  if (B.length !== C.length) throw new Error('Sellmeier: B and C must have equal length');
  const l2 = lambda * lambda;
  let n2 = 1 + num(c, 'A');
  for (let i = 0; i < B.length; i++) n2 += (B[i] as number) * l2 / (l2 - (squared ? (C[i] as number) ** 2 : (C[i] as number)));
  if (!(n2 > 0)) throw new Error('Sellmeier: n^2 <= 0 (outside the transparent range)');
  return Math.sqrt(n2);
}

export const FORMULAS: Record<string, Formula> = {
  'sellmeier-c2': {
    id: 'sellmeier-c2', vars: ['lambda'], coeffs: { A: 'number', B: 'array', C: 'array' },
    description: 'n^2 = 1 + A + sum_i B_i lambda^2 / (lambda^2 - C_i^2) (refractiveindex.info "formula 1")',
    evaluate: (x, c) => sellmeier(x.lambda as number, c, true),
  },
  'sellmeier-c': {
    id: 'sellmeier-c', vars: ['lambda'], coeffs: { A: 'number', B: 'array', C: 'array' },
    description: 'n^2 = 1 + A + sum_i B_i lambda^2 / (lambda^2 - C_i) (refractiveindex.info "formula 2")',
    evaluate: (x, c) => sellmeier(x.lambda as number, c, false),
  },
  'nist-cryo-log-poly': {
    id: 'nist-cryo-log-poly', vars: ['T'], coeffs: { a: 'array' },
    description: 'NIST cryogenic materials pages: log10 y = sum_i a_i (log10 T)^i, i = 0..8 (coefficients a..i)',
    evaluate: (x, c) => 10 ** polyval(arr(c, 'a'), Math.log10(x.T as number)),
  },
  'nist-cryo-linexp-secant': {
    id: 'nist-cryo-linexp-secant', vars: ['T'], coeffs: { a: 'array', scale: 'number', T_ref: 'number' },
    description: 'NIST cryogenic linear expansion y(T) = (L - L293)/L293 / scale = sum_i a_i T^i; returns the secant ' +
      'coefficient [y(T) - y(T_ref)] scale / (T - T_ref) (derivative at T = T_ref), so the fit residual at T_ref cancels',
    evaluate: (x, c) => {
      const a = arr(c, 'a'), s = num(c, 'scale'), T0 = num(c, 'T_ref'), T = x.T as number;
      if (Math.abs(T - T0) < 1e-6) return dpolyval(a, T0) * s;
      return (polyval(a, T) - polyval(a, T0)) * s / (T - T0);
    },
  },
  poly: {
    id: 'poly', vars: ['T'], coeffs: { c: 'array', x0: 'number' },
    description: 'y = sum_i c_i (T - x0)^i, T in the fit variable unit',
    evaluate: (x, c) => polyval(arr(c, 'c'), (x.T as number) - num(c, 'x0')),
  },
  'leviton-frey-sellmeier': {
    id: 'leviton-frey-sellmeier', vars: ['lambda', 'T'], coeffs: { S1: 'array', S2: 'array', S3: 'array', L1: 'array', L2: 'array', L3: 'array' },
    description: 'n^2 - 1 = sum_{i=1..3} S_i(T) lambda^2 / (lambda^2 - lambda_i(T)^2), S_i(T) = sum_j S_ij T^j, lambda_i(T) = sum_j lambda_ij T^j (Leviton and Frey 2006)',
    evaluate: (x, c) => {
      const l2 = (x.lambda as number) ** 2, T = x.T as number;
      let n2 = 1;
      for (const i of [1, 2, 3]) {
        const S = polyval(arr(c, `S${i}`), T), L = polyval(arr(c, `L${i}`), T);
        n2 += S * l2 / (l2 - L * L);
      }
      return Math.sqrt(n2);
    },
  },
};

export function checkFormulaCoeffs(id: string, c: Coeffs): string[] {
  const f = FORMULAS[id];
  if (!f) return [`unknown formula '${id}' (known: ${Object.keys(FORMULAS).join(', ')})`];
  const errs: string[] = [];
  for (const [k, kind] of Object.entries(f.coeffs)) {
    const v = c[k];
    if (kind === 'number' && !(typeof v === 'number' && Number.isFinite(v))) errs.push(`coefficient ${k}: number required`);
    if (kind === 'array' && !(Array.isArray(v) && v.length > 0 && v.every((e) => Number.isFinite(e)))) errs.push(`coefficient ${k}: non-empty number array required`);
  }
  for (const k of Object.keys(c)) if (!(k in f.coeffs)) errs.push(`unknown coefficient '${k}' for formula ${id}`);
  return errs;
}
