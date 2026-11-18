// SPDX-License-Identifier: GPL-3.0-or-later
// wave2d: driven frequency-domain scalar waves on 2D meshes (lane S1, DevLog-042), one kernel (kernel.ts) for
//  - `emw-2d`: in-plane electromagnetic waves, TM (out-of-plane E_z, a = 1/mu_r, m = k0^2 eps_r) or TE (out-of-plane
//    H_z, a = 1/eps_r, m = k0^2 mu_r);
//  - `acoustics` with a `frequency` study: pressure p, a = 1/rho, m = omega^2 / (rho c^2).
// Time convention exp(+j omega t): passive loss has Im(eps_r) < 0; eps_r = eps' (1 - j tan_delta); from a complex index
// N = n - j kappa (kappa >= 0 for loss): eps_r = N^2. Conditions: pml (domains), plane-wave (scattered field; select =
// background domains), port (modal, S-parameters), scattering (first-order absorbing), pec / pmc (EM), sound-hard /
// pressure / normal-velocity (acoustics), impedance (both).

import { dimOf } from '@amp/spec';
import type { FieldData, Mesh, PhysicsModule, RunContext, Solution, Spec } from '@amp/spec/types';
import { NPC, nCells, nNodes, facetsOn, selectEntities } from '../common/mesh.ts';
import { cellProps, optionalCellProp, physicsNode, q, bcsOf, specReadiness, type BcLike } from '../common/ctx.ts';
import { StageTimer, makeSolution, attachMesh, checkAbort } from '../common/solution.ts';
import { gatherX, physGrad, shapeTable } from '../common/lagrange.ts';
import { EPS0, MU0 } from '../electrostatics/index.ts';
import { Wave2DSolver, csqrtOut, type Coeffs, type Cx, type FacetBc, type FreqResult, type PortDef } from './kernel.ts';
import { buildPml, cellBox, type PmlModel } from './pml.ts';
import { farField } from './farfield.ts';
import type { FactorKind } from '@amp/core/la/ldlt-select';

/** Speed of light in vacuum, m/s (SI defining constant, exact). */
export const C0 = 299792458;

export { WAVE2D_REGISTRATIONS, RESULT_NAMES_WAVE2D } from './spec.ts';

export const WAVE2D_NORMALIZATION = 'complex amplitudes, time convention exp(+j omega t) (instantaneous field = Re(u exp(j omega t))); ports: incident power per unit depth `power` (default 1 W/m), S-parameters power-normalised; plane wave: amplitude as given';

type Kind = 'emw' | 'acoustics';
type Pol = 'TM' | 'TE';

/** Frequencies (Hz) of a frequency study: settings.values (Hz) or settings.wavelengths (vacuum, m; EM only). */
export function studyFrequencies(spec: Spec, study: RunContext['study'], kind: Kind): number[] {
  if (study.type !== 'frequency') throw new Error(`study '${study.id}' is '${study.type}'; driven waves need a 'frequency' study`);
  const s = (study.settings ?? {}) as { values?: unknown[]; wavelengths?: unknown[] };
  if (s.values && s.wavelengths) throw new Error('frequency study: give values or wavelengths, not both');
  if (s.values) return s.values.map((v, i) => q(spec, v, `study ${study.id} values[${i}]`));
  if (s.wavelengths) {
    if (kind !== 'emw') throw new Error('frequency study: wavelengths (vacuum) apply to electromagnetic physics only; give values in Hz');
    return s.wavelengths.map((v, i) => C0 / q(spec, v, `study ${study.id} wavelengths[${i}]`));
  }
  throw new Error(`frequency study '${study.id}' needs values (Hz) or wavelengths (m)`);
}

const BC_TYPES: Record<Kind, string[]> = {
  emw: ['pml', 'plane-wave', 'port', 'scattering', 'pec', 'pmc', 'impedance'],
  acoustics: ['pml', 'plane-wave', 'port', 'scattering', 'sound-hard', 'pressure', 'impedance', 'normal-velocity'],
};

export function wave2dReadiness(spec: Spec, physicsId: string, kind: Kind): string[] {
  const reasons: string[] = [];
  const p = physicsNode(spec, physicsId);
  for (const b of (p.bcs ?? []) as BcLike[]) if (!BC_TYPES[kind].includes(b.type)) reasons.push(`BC '${b.id}': type '${b.type}' is not supported by the frequency-domain solver (${BC_TYPES[kind].join(', ')})`);
  const bcs = (p.bcs ?? []) as BcLike[];
  if (bcs.filter((b) => b.type === 'plane-wave').length > 1) reasons.push('at most one plane-wave condition');
  if (bcs.some((b) => b.type === 'plane-wave') && bcs.some((b) => b.type === 'port')) reasons.push('plane-wave and port in one physics are not supported');
  if (bcs.filter((b) => b.type === 'port' && (b.settings as { excite?: boolean } | undefined)?.excite === true).length > 1) reasons.push('at most one port with excite: true');
  const st = (spec.studies ?? []).filter((s) => !(s as { physics?: string[] }).physics || (s as { physics?: string[] }).physics!.includes(physicsId));
  if (!st.some((s) => s.type === 'frequency' || s.type === 'parametric')) reasons.push('no frequency study for this physics');
  if (kind === 'acoustics') reasons.push(...specReadiness(spec, physicsId, { props: ['c', 'rho'] }));
  else reasons.push(...specReadiness(spec, physicsId, { props: [] }));
  return reasons;
}

interface Media { mask: Uint8Array; epsRe: Float64Array; epsIm: Float64Array; mu: Float64Array; rho: Float64Array; c: Float64Array; notes: string[] }

function media(ctx: RunContext, kind: Kind): Media {
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
  const epsRe = new Float64Array(nc), epsIm = new Float64Array(nc), muO = new Float64Array(nc);
  let muDefault = false;
  for (let c = 0; c < nc; c++) {
    if (!mask[c]) continue;
    if (Number.isFinite(epsR[c]!)) { epsRe[c] = epsR[c]!; epsIm[c] = Number.isFinite(tand[c]!) ? -epsR[c]! * tand[c]! : 0; }
    else if (Number.isFinite(n[c]!)) { const kk = Number.isFinite(kap[c]!) ? kap[c]! : 0; epsRe[c] = n[c]! * n[c]! - kk * kk; epsIm[c] = -2 * n[c]! * kk; }
    else throw new Error(`emw-2d: the material of domain ${ctx.mesh.entities.domains[ctx.mesh.cells.domain[c]!]!.id} has neither eps_r nor n`);
    if (Number.isFinite(mu[c]!)) muO[c] = mu[c]!; else { muO[c] = 1; muDefault = true; }
  }
  if (muDefault) notes.push('emw-2d: mu_r not given for some materials: non-magnetic, mu_r = 1');
  return { mask, epsRe, epsIm, mu: muO, rho: new Float64Array(nc), c: new Float64Array(nc), notes };
}

function coeffsAt(md: Media, kind: Kind, pol: Pol, omega: number): Coeffs {
  const nc = md.mask.length;
  const C: Coeffs = { aRe: new Float64Array(nc), aIm: new Float64Array(nc), mRe: new Float64Array(nc), mIm: new Float64Array(nc), kPml: new Float64Array(nc) };
  const k0 = omega / C0;
  for (let c = 0; c < nc; c++) {
    if (!md.mask[c]) continue;
    if (kind === 'acoustics') {
      C.aRe[c] = 1 / md.rho[c]!; C.mRe[c] = (omega * omega) / (md.rho[c]! * md.c[c]! * md.c[c]!); C.kPml[c] = omega / md.c[c]!;
      continue;
    }
    const er = md.epsRe[c]!, ei = md.epsIm[c]!, mu = md.mu[c]!;
    if (pol === 'TM') { C.aRe[c] = 1 / mu; C.mRe[c] = k0 * k0 * er; C.mIm[c] = k0 * k0 * ei; }
    else { const d = er * er + ei * ei; C.aRe[c] = er / d; C.aIm[c] = -ei / d; C.mRe[c] = k0 * k0 * mu; }
    const n2 = er * mu;
    C.kPml[c] = n2 > 0 ? k0 * Math.sqrt(n2) : k0;
  }
  return C;
}

/** Spec -> kernel problem, all frequencies, C5 Solution. */
export async function solveWave2D(ctx: RunContext, kind: Kind, opts: { factor?: FactorKind | null } = {}): Promise<Solution & { wave2d: unknown; notes?: string[]; normalization?: string }> {
  const timer = new StageTimer();
  const { spec, mesh } = ctx;
  const phys = physicsNode(spec, ctx.physicsId);
  const pol: Pol = kind === 'emw' ? ((phys.settings as { polarization?: Pol } | undefined)?.polarization ?? (() => { throw new Error('emw-2d: settings.polarization (TM or TE) is required'); })()) : 'TM';
  const freqs = studyFrequencies(spec, ctx.study, kind);
  timer.start('assemble');
  const md = media(ctx, kind);
  const notes = [...md.notes];
  const nc = nCells(mesh), nn = nNodes(mesh);
  const bcs = bcsOf(spec, ctx.physicsId);
  const unknown = bcs.filter((b) => !BC_TYPES[kind].includes(b.type));
  if (unknown.length) throw new Error(`unsupported BC types for the frequency-domain solver: ${unknown.map((b) => `${b.id} (${b.type})`).join(', ')}`);
  // PML cells
  const pmlCell = new Uint8Array(nc), R0 = new Float64Array(nc), ordArr = new Float64Array(nc);
  for (const b of bcs.filter((x) => x.type === 'pml')) {
    const doms = new Set(selectEntities(mesh.entities, 'domains', b.select));
    const s = (b.settings ?? {}) as { R0?: unknown; order?: number };
    const r0 = s.R0 !== undefined ? q(spec, s.R0, `${b.id}.R0`) : 1e-6, po = s.order ?? 2;
    for (let c = 0; c < nc; c++) if (md.mask[c] && doms.has(mesh.cells.domain[c]!)) { pmlCell[c] = 1; R0[c] = r0; ordArr[c] = po; }
  }
  const pml: PmlModel | null = pmlCell.some((v) => v) ? buildPml(mesh, md.mask, pmlCell, R0, ordArr) : null;
  // plane wave
  const pwBc = bcs.find((b) => b.type === 'plane-wave');
  let pwDir = 0, pwAmp = 0, bgCell = -1;
  if (pwBc) {
    const s = pwBc.settings as { direction: unknown; amplitude: unknown };
    pwDir = q(spec, s.direction, `${pwBc.id}.direction`);
    const ampUnit = kind === 'acoustics' ? 'Pa' : pol === 'TM' ? 'V/m' : 'A/m';
    const ampQ = s.amplitude;
    const unitStr = typeof ampQ === 'object' && ampQ !== null && 'unit' in ampQ ? String((ampQ as { unit: string }).unit) : null;
    if (unitStr && dimOf(unitStr).join() !== dimOf(ampUnit).join()) throw new Error(`${pwBc.id}.amplitude: unit '${unitStr}' is not ${ampUnit}`);
    pwAmp = q(spec, ampQ, `${pwBc.id}.amplitude`);
    const doms = new Set(selectEntities(mesh.entities, 'domains', pwBc.select));
    const mats = new Set<number>();
    for (let c = 0; c < nc; c++) if (md.mask[c] && doms.has(mesh.cells.domain[c]!)) { if (bgCell < 0) bgCell = c; mats.add(c); }
    if (bgCell < 0) throw new Error(`${pwBc.id}: the background selection has no cells of the physics`);
    for (const c of mats) {
      const same = kind === 'acoustics' ? md.rho[c] === md.rho[bgCell] && md.c[c] === md.c[bgCell] : md.epsRe[c] === md.epsRe[bgCell] && md.epsIm[c] === md.epsIm[bgCell] && md.mu[c] === md.mu[bgCell];
      if (!same) throw new Error(`${pwBc.id}: the background domains must hold one homogeneous medium`);
    }
  }
  // facets per BC, Dirichlet facets
  const facetsOf = (b: BcLike) => facetsOn(mesh, b.select);
  const isDir = (b: BcLike) => (kind === 'acoustics' ? b.type === 'pressure' : (pol === 'TM' && b.type === 'pec') || (pol === 'TE' && b.type === 'pmc'));
  const dirFacets = bcs.filter(isDir).flatMap(facetsOf);
  if (pwBc) checkOpenBoundaries(mesh, md, kind, pmlCell, bgCell, bcs.filter((b) => b.type !== 'pml' && b.type !== 'plane-wave').flatMap(facetsOf));
  const portBcs = bcs.filter((b) => b.type === 'port');
  const exciteIdx = Math.max(0, portBcs.findIndex((b) => (b.settings as { excite?: boolean } | undefined)?.excite === true));
  const portDefs: PortDef[] = portBcs.map((b, i) => {
    const s = (b.settings ?? {}) as { nModes?: number; power?: unknown; excite?: boolean };
    return { id: b.id, facets: facetsOf(b), nModes: s.nModes ?? 1, power: s.power !== undefined ? q(spec, s.power, `${b.id}.power`) : 1, excite: i === exciteIdx };
  });
  timer.stop('assemble');
  // pattern (cells + dense port blocks) and nested-dissection symbolic analysis, shared by all frequencies
  const solver = timer.time('analyze', () => new Wave2DSolver(mesh, md.mask, pml, portDefs, dirFacets, { factor: opts.factor ?? null }));
  const fields: FieldData[] = [];
  const scalars: Solution['scalars'] = {};
  const extra: Array<Record<string, unknown>> = [];
  const U = kind === 'acoustics' ? 'p' : pol === 'TM' ? 'Ez' : 'Hz';
  const uUnit = kind === 'acoustics' ? 'Pa' : pol === 'TM' ? 'V/m' : 'A/m';
  const space = mesh.cells.type === 'tri6' ? 'H1P2' : 'H1P1';
  const multi = freqs.length > 1;
  const sfx = (i: number) => (multi ? `_${i}` : '');
  let dofMax = 0, resMax = 0;
  const statsSolver = `complex supernodal LDL^T (${opts.factor ?? 'default'} front kernel, nested dissection, iterative refinement)`;
  for (let fi = 0; fi < freqs.length; fi++) {
    checkAbort(ctx.signal);
    ctx.progress?.('solve', fi / freqs.length, `f = ${freqs[fi]!.toPrecision(6)} Hz`);
    const f = freqs[fi]!, omega = 2 * Math.PI * f;
    const C = coeffsAt(md, kind, pol, omega);
    const fbcs: FacetBc[] = [];
    for (const b of bcs) {
      const fs = () => facetsOf(b);
      const s = (b.settings ?? {}) as Record<string, unknown>;
      switch (b.type) {
        case 'pml': case 'plane-wave': case 'port': break;
        case 'pec': case 'pmc': case 'pressure': {
          if (isDir(b)) {
            const val = b.type === 'pressure' ? q(spec, s.p, `${b.id}.p`) : 0;
            fbcs.push({ kind: 'dirichlet', id: b.id, facets: fs(), value: () => [val, 0], wall: true });
          } else fbcs.push({ kind: 'wall', id: b.id, facets: fs() });
          break;
        }
        case 'sound-hard': fbcs.push({ kind: 'wall', id: b.id, facets: fs() }); break;
        case 'scattering': fbcs.push({ kind: 'robin', id: b.id, facets: fs(), wall: false, coef: (c) => {
          // + j k a with k^2 = m / a of the adjacent cell (complex)
          const kc = csqrtOut(cdivC([C.mRe[c]!, C.mIm[c]!], [C.aRe[c]!, C.aIm[c]!]));
          return cmulC([0, 1], cmulC(kc, [C.aRe[c]!, C.aIm[c]!]));
        } }); break;
        case 'impedance': {
          let coef: Cx;
          if (kind === 'acoustics') coef = [0, omega / q(spec, s.Z, `${b.id}.Z`)];
          else {
            const Zs: Cx = s.sigma !== undefined ? (() => { const r = Math.sqrt((omega * MU0) / (2 * q(spec, s.sigma, `${b.id}.sigma`))); return [r, r] as Cx; })()
              : [s.R !== undefined ? q(spec, s.R, `${b.id}.R`) : 0, s.X !== undefined ? q(spec, s.X, `${b.id}.X`) : 0];
            coef = pol === 'TM' ? cdivC([0, omega * MU0], Zs) : cmulC([0, omega * EPS0], Zs);
          }
          fbcs.push({ kind: 'robin', id: b.id, facets: fs(), wall: true, coef: () => coef });
          break;
        }
        case 'normal-velocity': {
          const v = q(spec, s.v, `${b.id}.v`);
          fbcs.push({ kind: 'neumann', id: b.id, facets: fs(), g: () => [0, omega * v] });
          break;
        }
        default: throw new Error(`BC '${b.id}': type '${b.type}' not supported`);
      }
    }
    const planeWave = pwBc ? { dir: pwDir, amp: pwAmp, aB: [C.aRe[bgCell]!, C.aIm[bgCell]!] as Cx, mB: [C.mRe[bgCell]!, C.mIm[bgCell]!] as Cx } : undefined;
    const powerC = kind === 'acoustics' ? 1 : pol === 'TM' ? MU0 : EPS0;
    const r = solver.solve({ omega, coeffs: C, bcs: fbcs, ports: portDefs, ...(planeWave ? { planeWave } : {}), powerC });
    timer.add('assemble', r.timing.assemble); if (r.timing.ports > 0 && portDefs.length) timer.add('ports', r.timing.ports); timer.add('factor', r.timing.factor); timer.add('solve', r.timing.solve);
    for (const n of r.notes) if (!notes.includes(n)) notes.push(n);
    dofMax = Math.max(dofMax, nn); resMax = Math.max(resMax, r.relResidual);
    if (r.nPerturbed > 0) notes.push(`f = ${f} Hz: ${r.nPerturbed} pivots perturbed in the LDL^T factor (refined residual ${r.relResidual.toExponential(2)})`);
    timer.start('post');
    const push = (name: string, unit: string, data: Float64Array, sp: FieldData['space'] = space, comps: 1 | 2 = 1) => fields.push({ name, unit, space: sp, components: comps, data, step: fi });
    push(`${U}_re`, uUnit, r.uRe); push(`${U}_im`, uUnit, r.uIm); push(`${U}_abs`, uUnit, Float64Array.from(r.uRe, (v, i) => Math.hypot(v, r.uIm[i]!)));
    if (r.usRe && r.usIm) { const a = r.usRe, b = r.usIm; push(`${U}_sc_re`, uUnit, a); push(`${U}_sc_im`, uUnit, b); push(`${U}_sc_abs`, uUnit, Float64Array.from(a, (v, i) => Math.hypot(v, b[i]!))); }
    // derived DG0 vectors from grad u at the cell centroid
    const der = derived(mesh, md.mask, C, r, kind, pol, omega);
    const [Dn, Du] = kind === 'acoustics' ? ['v', 'm/s'] : pol === 'TM' ? ['H', 'A/m'] : ['E', 'V/m'];
    push(`${Dn}_re`, Du, der.re, 'DG0', 2); push(`${Dn}_im`, Du, der.im, 'DG0', 2); push(`norm${Dn === 'v' ? 'V' : Dn}`, Du, der.norm, 'DG0');
    scalars[`freq${sfx(fi)}`] = { value: f, unit: 'Hz' };
    const rec: Record<string, unknown> = { f };
    // ports
    r.ports.forEach((pr, pi) => pr.modes.slice(0, portDefs[pi]!.nModes).forEach((m, k) => {
      scalars[`beta_${pi + 1}_${k}${sfx(fi)}`] = { value: m.beta[0], unit: '1/m' };
      if (kind === 'emw') scalars[`neff_${pi + 1}_${k}${sfx(fi)}`] = { value: m.beta[0] / (omega / C0), unit: '1' };
    }));
    if (r.S) {
      const nk = r.S.keys.length;
      for (let i = 0; i < nk; i++) for (let j = 0; j < nk; j++) {
        const a = r.S.keys[i]!, b = r.S.keys[j]!;
        const base = `S${a.port + 1}${b.port + 1}${a.mode || b.mode ? `_${a.mode}${b.mode}` : ''}`;
        const re = r.S.re[i * nk + j]!, im = r.S.im[i * nk + j]!, ab = Math.hypot(re, im);
        scalars[`${base}_re${sfx(fi)}`] = { value: re, unit: '1' };
        scalars[`${base}_im${sfx(fi)}`] = { value: im, unit: '1' };
        scalars[`${base}_abs${sfx(fi)}`] = { value: ab, unit: '1' };
        scalars[`${base}_dB${sfx(fi)}`] = { value: 20 * Math.log10(ab), unit: '1' };
        scalars[`${base}_phase${sfx(fi)}`] = { value: Math.atan2(im, re), unit: 'rad' };
      }
      if (r.Pin !== undefined) scalars[`P_in${sfx(fi)}`] = { value: r.Pin, unit: 'W/m' };
      if (r.srcPower) r.srcPower.forEach((P, pi) => { scalars[`P_src_${pi + 1}${sfx(fi)}`] = { value: P, unit: 'W/m' }; });
      rec.S = { keys: r.S.keys.map((k) => ({ port: portDefs[k.port]!.id, mode: k.mode })), re: Array.from(r.S.re), im: Array.from(r.S.im) };
      rec.beta = r.ports.map((pr) => pr.modes.slice(0, 8).map((m) => m.beta));
      if (r.srcPower) rec.srcPower = r.srcPower;
    }
    // scattering width
    if (planeWave && r.usRe && r.usIm) {
      const kb = csqrtOut(cdivC(planeWave.mB, planeWave.aB));
      if (Math.abs(kb[1]) > 1e-12 * kb[0]) notes.push('scattering width: lossy background, not computed');
      else {
        const nAng = 360;
        const angles = new Float64Array(nAng + 2);
        for (let i = 0; i < nAng; i++) angles[i] = (2 * Math.PI * i) / nAng;
        angles[nAng] = pwDir; angles[nAng + 1] = pwDir + Math.PI;
        const inner = pml ? pml.inner : cellBox(mesh, (c) => !!md.mask[c])!;
        const scat: number[] = [];
        const kk = NPC[mesh.cells.type];
        const differs = (c: number) => C.aRe[c] !== planeWave.aB[0] || C.aIm[c] !== planeWave.aB[1] || C.mRe[c] !== planeWave.mB[0] || C.mIm[c] !== planeWave.mB[1];
        for (let c = 0; c < nc; c++) if (md.mask[c] && !pmlCell[c] && differs(c)) for (let a = 0; a < 3; a++) { const n = mesh.cells.conn[kk * c + a]!; scat.push(mesh.nodes[2 * n]!, mesh.nodes[2 * n + 1]!); }
        for (const fb of fbcs) if (fb.kind !== 'robin' || fb.wall) for (const fct of fb.facets) {
          const kf = NPC[mesh.facets.type];
          for (let a = 0; a < kf; a++) { const n = mesh.facets.conn[kf * fct + a]!; const x = mesh.nodes[2 * n]!, y = mesh.nodes[2 * n + 1]!; if (x > inner.x0 && x < inner.x1 && y > inner.y0 && y < inner.y1) scat.push(x, y); }
        }
        if (!scat.length) notes.push('scattering width: no scatterer found (no cells differ from the background and no walls inside the non-PML box)');
        else {
          let ff: ReturnType<typeof farField> | null = null;
          try { ff = farField({ mesh, active: md.mask, notBackground: (c) => !!pmlCell[c] || differs(c), usRe: r.usRe, usIm: r.usIm, k: kb[0], amp: pwAmp, inner, scatPts: Float64Array.from(scat), angles }); }
          catch (e) { const msg = `${(e as Error).message}; scattering width not computed`; if (!notes.includes(msg)) notes.push(msg); }
          if (ff) {
            let tot = 0; for (let i = 0; i < nAng; i++) tot += ff.sigma[i]!;
            scalars[`sigma2d_fwd${sfx(fi)}`] = { value: ff.sigma[nAng]!, unit: 'm' };
            scalars[`sigma2d_back${sfx(fi)}`] = { value: ff.sigma[nAng + 1]!, unit: 'm' };
            scalars[`sigma2d_total${sfx(fi)}`] = { value: tot / nAng, unit: 'm' };
            rec.farField = { phi: Array.from(angles.subarray(0, nAng)), sigma2d: Array.from(ff.sigma.subarray(0, nAng)), band: ff.bandQ, bandCells: ff.nBandCells };
          }
        }
      }
    }
    extra.push(rec);
    timer.stop('post');
  }
  const sol = await makeSolution({
    mesh, spec, fields, steps: { kind: 'freq', values: Float64Array.from(freqs), unit: 'Hz' }, scalars,
    stats: { dof: dofMax, nnz: solver.pat.nnz, residual: resMax, solver: statsSolver },
    timer,
  });
  attachMesh(sol, mesh);
  const out = sol as Solution & { wave2d: unknown; notes?: string[]; normalization?: string };
  out.wave2d = { kind, polarization: kind === 'emw' ? pol : undefined, field: U, freqs, perFrequency: extra, pml: pml ? { inner: pml.inner, outer: pml.outer } : null };
  if (notes.length) out.notes = notes;
  out.normalization = WAVE2D_NORMALIZATION;
  return out;
}

/**
 * Plane wave (scattered field): an exterior boundary of the physics without a condition acts on the scattered field,
 * which is consistent only next to the background medium (DevLog-042 s.7.7, O7). Next to another medium (outside PML)
 * it is rejected: the user must say what the boundary is.
 */
function checkOpenBoundaries(mesh: Mesh, md: Media, kind: Kind, pmlCell: Uint8Array, bgCell: number, listed: number[]): void {
  const k = NPC[mesh.cells.type], nc = nCells(mesh), nn = nNodes(mesh);
  const key = (v0: number, v1: number) => Math.min(v0, v1) * nn + Math.max(v0, v1);
  const edgeCell = new Map<number, number>();   // edge -> adjacent active cell, -1 when shared by two
  for (let c = 0; c < nc; c++) {
    if (!md.mask[c]) continue;
    for (let a = 0; a < 3; a++) {
      const e = key(mesh.cells.conn[k * c + a]!, mesh.cells.conn[k * c + ((a + 1) % 3)]!);
      edgeCell.set(e, edgeCell.has(e) ? -1 : c);
    }
  }
  const covered = new Set(listed);
  const sameMedium = (c: number) => (kind === 'acoustics' ? md.rho[c] === md.rho[bgCell] && md.c[c] === md.c[bgCell]
    : md.epsRe[c] === md.epsRe[bgCell] && md.epsIm[c] === md.epsIm[bgCell] && md.mu[c] === md.mu[bgCell]);
  const kf = NPC[mesh.facets.type], nf = mesh.facets.boundary.length;
  const bad = new Map<string, Set<string>>();   // boundary id -> domain ids
  for (let f = 0; f < nf; f++) {
    if (covered.has(f)) continue;
    const c = edgeCell.get(key(mesh.facets.conn[kf * f]!, mesh.facets.conn[kf * f + 1]!));
    if (c === undefined || c < 0 || pmlCell[c] || sameMedium(c)) continue;
    const b = mesh.entities.boundaries[mesh.facets.boundary[f]!]?.id ?? `#${mesh.facets.boundary[f]}`;
    const d = mesh.entities.domains[mesh.cells.domain[c]!]?.id ?? `#${mesh.cells.domain[c]}`;
    (bad.get(b) ?? bad.set(b, new Set()).get(b)!).add(d);
  }
  if (!bad.size) return;
  const walls = kind === 'acoustics' ? 'sound-hard, pressure, impedance' : 'pec, pmc, impedance';
  const list = [...bad].map(([b, ds]) => `'${b}' (next to ${[...ds].map((d) => `'${d}'`).join(', ')})`).join('; ');
  const many = bad.size > 1;
  throw new Error(`plane wave: ${many ? 'boundaries' : 'boundary'} ${list} ${many ? 'have' : 'has'} no condition and ${many ? 'touch' : 'touches'} a medium other than the background, so the plane-wave (scattered-field) formulation cannot treat ${many ? 'them' : 'it'} as open. Add a PML domain beyond ${many ? 'them' : 'it'}, a scattering condition, or a wall condition (${walls}) on ${many ? 'them' : 'it'}`);
}

const cmulC = (a: Cx, b: Cx): Cx => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];
const cdivC = (a: Cx, b: Cx): Cx => { const d = b[0] * b[0] + b[1] * b[1]; return [(a[0] * b[0] + a[1] * b[1]) / d, (a[1] * b[0] - a[0] * b[1]) / d]; };

/** DG0 derived vectors from grad u at the centroid: TM H = (j a / (omega mu0)) (du/dy, -du/dx); TE E = (-j a / (omega eps0)) (du/dy, -du/dx); acoustics v = (j a / omega) grad p. */
function derived(mesh: Mesh, mask: Uint8Array, C: Coeffs, r: FreqResult, kind: Kind, pol: Pol, omega: number): { re: Float64Array; im: Float64Array; norm: Float64Array } {
  const k = NPC[mesh.cells.type], nc = nCells(mesh);
  const rule = { dim: 2, n: 1, pts: Float64Array.of(1 / 3, 1 / 3), wts: Float64Array.of(0.5) };
  const tab = shapeTable(mesh.cells.type, rule);
  const X = new Float64Array(2 * k), G = new Float64Array(2 * k);
  const re = new Float64Array(2 * nc), im = new Float64Array(2 * nc), norm = new Float64Array(nc);
  for (let c = 0; c < nc; c++) {
    if (!mask[c]) continue;
    gatherX(mesh.nodes, 2, mesh.cells.conn, c, k, X);
    physGrad(tab, 0, X, 2, G);
    let gxr = 0, gxi = 0, gyr = 0, gyi = 0;
    for (let a = 0; a < k; a++) {
      const n = mesh.cells.conn[k * c + a]!;
      gxr += G[2 * a]! * r.uRe[n]!; gxi += G[2 * a]! * r.uIm[n]!; gyr += G[2 * a + 1]! * r.uRe[n]!; gyi += G[2 * a + 1]! * r.uIm[n]!;
    }
    const a: Cx = [C.aRe[c]!, C.aIm[c]!];
    let fac: Cx, vx: Cx, vy: Cx;
    if (kind === 'acoustics') { fac = cmulC([0, 1 / omega], a); vx = [gxr, gxi]; vy = [gyr, gyi]; }
    else { fac = cmulC([0, pol === 'TM' ? 1 / (omega * MU0) : -1 / (omega * EPS0)], a); vx = [gyr, gyi]; vy = [-gxr, -gxi]; }
    const ex = cmulC(fac, vx), ey = cmulC(fac, vy);
    re[2 * c] = ex[0]; im[2 * c] = ex[1]; re[2 * c + 1] = ey[0]; im[2 * c + 1] = ey[1];
    norm[c] = Math.hypot(ex[0], ex[1], ey[0], ey[1]);
  }
  return { re, im, norm };
}

export const emw2dModule: PhysicsModule = {
  type: 'emw-2d',
  dims: ['2d'],
  readiness(spec, physicsId) {
    let reasons: string[] = [];
    try { reasons = wave2dReadiness(spec as Spec, physicsId, 'emw'); } catch (e) { reasons = [(e as Error).message]; }
    return { ready: reasons.length === 0, reasons };
  },
  async run(ctx: RunContext) { return solveWave2D(ctx, 'emw'); },
};

/** Acoustics frequency study (dispatched from acoustics/index.ts). */
export const solveAcousticsFrequency = (ctx: RunContext) => solveWave2D(ctx, 'acoustics');
