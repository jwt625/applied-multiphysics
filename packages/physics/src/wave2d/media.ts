// SPDX-License-Identifier: GPL-3.0-or-later
// Per-cell media of wave2d (moved from index.ts, DevLog-050): emw-2d eps_r (with tan_delta) or n (with kappa), mu_r;
// acoustics c, rho. An override eps_r wins over a library n. When the run binds a wavelength (driven frequency runs),
// a library n (at that wavelength) wins over a library eps_r; without one (eigen / bands studies) the library eps_r
// (with tan_delta) is used and the library n is not (DevLog-050 s.9).
// Time convention exp(+j omega t): passive loss has Im(eps_r) < 0.

import type { RunContext } from '@amp/spec/types';
import { cellProps, optionalCellProp } from '../common/ctx.ts';
import { selectEntities } from '../common/mesh.ts';

export type Kind = 'emw' | 'acoustics';

export interface Media { mask: Uint8Array; epsRe: Float64Array; epsIm: Float64Array; mu: Float64Array; rho: Float64Array; c: Float64Array; notes: string[] }

/**
 * `wavelength`: true when the material table was evaluated at the run's vacuum wavelength (prepareRun of a
 * single-frequency study, or `materialsAt(c0 / f)` per frequency); false for eigen / bands studies and for a
 * multi-frequency table evaluated once without a wavelength.
 */
export function media(ctx: RunContext, kind: Kind, o: { wavelength?: boolean } = {}): Media {
  const notes: string[] = [];
  if (kind === 'acoustics') {
    const { mask, values } = cellProps(ctx, ['c', 'rho']);
    const nc = mask.length;
    return { mask, epsRe: new Float64Array(nc), epsIm: new Float64Array(nc), mu: new Float64Array(nc), rho: values.rho!, c: values.c!, notes };
  }
  const { mask } = cellProps(ctx, []);
  const epsR = optionalCellProp(ctx, 'eps_r', mask), tand = optionalCellProp(ctx, 'tan_delta', mask);
  const n = optionalCellProp(ctx, 'n', mask), kap = optionalCellProp(ctx, 'kappa', mask), mu = optionalCellProp(ctx, 'mu_r', mask);
  const nc = mask.length;
  const atWl = o.wavelength === true;
  // precedence (DevLog-050 s.8, s.9): an eps_r the user wrote (override) wins; otherwise, when the material table holds
  // both a library eps_r (a low-frequency permittivity) and a library n, the optical n (with kappa) is used only when
  // it was resolved at this run's wavelength; without a wavelength the library eps_r (with tan_delta) is used
  const m = ctx.mesh;
  const epsUser = new Uint8Array(m.entities.domains.length), libBoth: string[] = [];
  for (const mat of ctx.spec.materials ?? []) {
    const ov = (mat as { override?: Record<string, unknown> }).override ?? {};
    const rec = ctx.materials[mat.id] ?? {};
    if ('eps_r' in ov) for (const d of selectEntities(m.entities, 'domains', mat.select)) epsUser[d] = 1;
    else if (typeof rec.eps_r === 'number' && typeof rec.n === 'number') libBoth.push(mat.id);
  }
  const epsRe = new Float64Array(nc), epsIm = new Float64Array(nc), muO = new Float64Array(nc);
  let muDefault = false;
  for (let c = 0; c < nc; c++) {
    if (!mask[c]) continue;
    const useN = atWl && Number.isFinite(n[c]!) && Number.isFinite(epsR[c]!) && !epsUser[m.cells.domain[c]!];
    if (Number.isFinite(epsR[c]!) && !useN) { epsRe[c] = epsR[c]!; epsIm[c] = Number.isFinite(tand[c]!) ? -epsR[c]! * tand[c]! : 0; }
    else if (Number.isFinite(n[c]!)) { const kk = Number.isFinite(kap[c]!) ? kap[c]! : 0; epsRe[c] = n[c]! * n[c]! - kk * kk; epsIm[c] = -2 * n[c]! * kk; }
    else throw new Error(`emw-2d: the material of domain ${ctx.mesh.entities.domains[ctx.mesh.cells.domain[c]!]!.id} has neither eps_r nor n`);
    if (Number.isFinite(mu[c]!)) muO[c] = mu[c]!; else { muO[c] = 1; muDefault = true; }
  }
  if (muDefault) notes.push('emw-2d: mu_r not given for some materials: non-magnetic, mu_r = 1');
  if (libBoth.length && atWl) notes.push(`emw-2d: ${libBoth.map((x) => `'${x}'`).join(', ')}: the library refractive index n (and kappa) at this wavelength is used; the library eps_r (a low-frequency permittivity) is not. Give eps_r as an override to use a permittivity`);
  else for (const id of libBoth) {
    const rec = ctx.materials[id]!;
    const td = typeof rec.tan_delta === 'number' ? `, tan_delta ${rec.tan_delta}` : '';
    notes.push(`emw-2d: '${id}': this study has no wavelength (eigen or bands study, or one material evaluation for several frequencies), so the library eps_r (${rec.eps_r}${td}) is used; the library refractive index n (${rec.n}) is not, since it is stated at a wavelength. Give n (or eps_r) as an override to choose the optical value`);
  }
  return { mask, epsRe, epsIm, mu: muO, rho: new Float64Array(nc), c: new Float64Array(nc), notes };
}
