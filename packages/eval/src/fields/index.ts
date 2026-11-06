// SPDX-License-Identifier: GPL-3.0-or-later
// Browser-safe exact-field evaluator: same cases, parameters, field names and units as validation/a/fields.py
// (lane L7a). DEFAULTS mirror fields.py DEFAULTS (case inputs defined by L7a; read 2026-11-06), so that
// evaluateFields(case, points) == `uv run python a/fields.py <case> --points ...` to 1e-12 relative
// (gate: bench/fields-crosscheck.ts). Complex fields are returned as {re, im}, like the CLI.

import { ac03Pressure, danckwerts, eofProfile, helmholtz, kirsch, kovasznay, mieContext, mieFieldPoint, poiseuille, type EofParams } from './closed-forms.ts';
import { c } from './special.ts';

export type FieldValues = number[] | { re: number[]; im: number[] };
export interface FieldResult { case: string; fields: Record<string, FieldValues>; units: Record<string, string>; params: Record<string, unknown>; generator: string }

const TR01 = { L: 1.0, u: 1.0e-3, k: 1.0e-3 };
const CP05: EofParams = { eps_r: 80.0, zeta_V: -0.05, E_V_m: 1.0e4, eta_Pa_s: 1.0e-3, c0_mol_m3: 1.0, T_K: 298.15, h_m: 100e-9 };

export const DEFAULTS: Record<string, Record<string, unknown>> = {
  'SM-01': { a: 5.0e-3, L: 50.0e-3, s_inf: 100.0e6, E: 200.0e9, nu: 0.3 },
  'FL-01': { Re: 10.0, domain: [[-0.5, 1.5], [-0.5, 1.5]] },
  'FL-01-pois': { mu: 1.0 },
  'WO-03': { radius: 0.525e-6, wavelength: 0.6328e-6, m_re: 1.55, m_im: 0.0, n_medium: 1.0 },
  'EM-04': { R: 0.1, I: 1.0, N: 1 },
  'AC-03': { ka: 5.0, a: 1.0, p0: 1.0, polar: false },
  'TR-01': { ...TR01, Pe: 10.0 },
  'CP-05': { ...CP05 },
};

export const FIELD_CASES = Object.keys(DEFAULTS);

const num = (p: Record<string, unknown>, k: string) => {
  const v = p[k];
  if (typeof v !== 'number') throw new Error(`parameter ${k} must be a number`);
  return v;
};

export function evaluateFields(caseId: string, points: number[][], params: Record<string, unknown> = {}): FieldResult {
  const d = DEFAULTS[caseId];
  if (!d) throw new Error(`no exact field for case '${caseId}' (have ${FIELD_CASES.join(', ')})`);
  const p = { ...d, ...params };
  const cols = (names: string[], f: (pt: number[]) => Record<string, number>) => {
    const out: Record<string, number[]> = Object.fromEntries(names.map((n) => [n, [] as number[]]));
    for (const pt of points) { const v = f(pt); for (const n of names) out[n]!.push(v[n]!); }
    return out;
  };
  let fields: Record<string, FieldValues>, units: Record<string, string>;
  switch (caseId) {
    case 'SM-01':
      fields = cols(['sxx', 'syy', 'sxy', 'ux', 'uy'], (q) => kirsch(q[0]!, q[1]!, num(p, 'a'), num(p, 's_inf'), num(p, 'E'), num(p, 'nu')));
      units = { sxx: 'Pa', syy: 'Pa', sxy: 'Pa', ux: 'm', uy: 'm' };
      break;
    case 'FL-01':
      fields = cols(['u', 'v', 'p'], (q) => kovasznay(q[0]!, q[1]!, num(p, 'Re'), p.domain as [[number, number], [number, number]]));
      units = { u: 'm/s', v: 'm/s', p: 'Pa' };
      break;
    case 'FL-01-pois':
      fields = cols(['u', 'v', 'p'], (q) => poiseuille(q[0]!, q[1]!, num(p, 'mu')));
      units = { u: 'm/s', v: 'm/s', p: 'Pa' };
      break;
    case 'WO-03': {
      const ctx = mieContext(num(p, 'radius'), num(p, 'wavelength'), c(num(p, 'm_re'), num(p, 'm_im')), num(p, 'n_medium'));
      const re: number[][] = [[], [], []], im: number[][] = [[], [], []];
      for (const q of points) {
        const E = mieFieldPoint([q[0]!, q[1]!, q[2]!], ctx);
        E.forEach((e, i) => { re[i]!.push(e.re); im[i]!.push(e.im); });
      }
      fields = { Ex: { re: re[0]!, im: im[0]! }, Ey: { re: re[1]!, im: im[1]! }, Ez: { re: re[2]!, im: im[2]! } };
      units = { Ex: 'E0', Ey: 'E0', Ez: 'E0' };
      break;
    }
    case 'EM-04':
      fields = cols(['B_rho', 'B_z'], (q) => {
        const [rho, z] = q.length === 3 ? [Math.hypot(q[0]!, q[1]!), q[2]!] : [q[0]!, q[1]!];
        return helmholtz(rho, z, num(p, 'R'), num(p, 'I'), num(p, 'N'));
      });
      units = { B_rho: 'T', B_z: 'T' };
      break;
    case 'AC-03': {
      const re: number[] = [], im: number[] = [];
      for (const q of points) {
        let r: number, th: number;
        if (p.polar) { r = q[0]!; th = q[1]!; } else {
          r = Math.hypot(q[0]!, q[1]!, q[2]!);
          th = Math.acos(Math.min(1, Math.max(-1, q[2]! / r)));
        }
        const v = ac03Pressure(r, th, num(p, 'ka'), num(p, 'a'), num(p, 'p0'));
        re.push(v.re); im.push(v.im);
      }
      fields = { p: { re, im } };
      units = { p: 'p0' };
      break;
    }
    case 'TR-01': {
      const D = (num(p, 'u') * num(p, 'L')) / num(p, 'Pe');
      fields = { C_over_C0: points.map((q) => danckwerts(q[0]!, num(p, 'L'), num(p, 'u'), D, num(p, 'k'))) };
      units = { C_over_C0: '1' };
      break;
    }
    case 'CP-05':
      fields = { u: points.map((q) => eofProfile(q[0]!, p as unknown as EofParams)) };
      units = { u: 'm/s' };
      break;
    default:
      throw new Error(`unreachable: ${caseId}`);
  }
  return { case: caseId, fields, units, params: p, generator: 'packages/eval/src/fields (TS port of validation/a/fields.py)' };
}

/** Same signature as adapters/fields.ts evaluateExactField, backed by the TS port (browser-safe). */
export async function evaluateExactFieldTs(
  evaluator: string, caseId: string, field: string, points: number[][], opts: { params?: Record<string, unknown> } = {},
): Promise<{ values: FieldValues; unit: string | undefined; generator: string }> {
  if (!/validation\/a\/fields\.py$/.test(evaluator)) throw new Error(`TS port covers validation/a/fields.py only, not ${evaluator}`);
  const r = evaluateFields(caseId, points, opts.params ?? {});
  const v = r.fields[field];
  if (v === undefined) throw new Error(`${caseId}: no field '${field}' (has ${Object.keys(r.fields).join(', ')})`);
  return { values: v, unit: r.units[field], generator: r.generator };
}
