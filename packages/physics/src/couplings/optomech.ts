// SPDX-License-Identifier: GPL-3.0-or-later
// Optomechanical coupling of lane MOM (C11, DevLog-034):
//   optomechanical   elastic -> emw-axisym   vacuum coupling g0 per optical x mechanical mode pair (moving boundary +
//                                            photoelastic), on one meridional (r, z) mesh
// Kind 'monolithic' (the driver's extension point that receives both run contexts): both eigenproblems are solved here
// (emw-axisym solveAxisymModes per azimuthal order; torsion-free axisymmetric solid modes), then every pair is
// evaluated. Nothing is coupled back: g0 is a post-eigen pair quantity. Conventions (signs, normalisation, m_eff,
// azimuthal factors): optomech/axisym.ts header; DevLog-034 s.1.2.
//
// Settings: optical {nModes, shift} (defaults: the study's nModes and shift) and mechanical {nModes, shift} (defaults:
// the study's nModes, no shift = the lowest modes; a free body's rigid mode is reported as f = 0 and skipped in the pairs);
// photoelastic [{material, p11, p12, p44, frame}] (cubic m3m contracted constants, dimensionless; frame 'crystal-avg'
// = crystal [001] on the axis, azimuthal average of the rotated tensor; 'cylindrical' = the cubic matrix applied in the
// local (r, phi, z) axes, the convention of Baker et al. 2014 Opt. Express 22 14072 eq. 13). Stiffness: a material with
// a cubic tensor C uses its azimuthal average (crystal [001] on the axis; approximation: the 4 phi part is dropped),
// else isotropic E, nu.
// Output: steps = optical modes (sorted over m) then mechanical modes, kind eigen, Hz; fields E_rphiz (tag = to, steps
// 0..No-1) and u (tag = from, steps No..No+Nm-1); scalars <to>.f_<i>, <to>.m_<i>, <to>.ezFraction_<i>,
// <from>.f_<j>, <from>.meff_<j> (kg), <from>.xzpf_<j> (m), and per pair (i optical, j mechanical) g0_<i>_<j>,
// g0MB_<i>_<j>, g0PE_<i>_<j> (g0 / 2 pi, Hz), gOM_<i>_<j>, gOMMB_<i>_<j>, gOMPE_<i>_<j> (g_OM / 2 pi, Hz/m).

import * as z from 'zod';
import { quantity, resolveQuantity, type Registration } from '@amp/spec';
import type { CouplingNode, FieldData, Mesh, Solution, Spec } from '@amp/spec/types';
import type { CouplingImpl } from './core.ts';
import { nCells, selectEntities } from '../common/mesh.ts';
import { bcSelections, cellProps, eigenStudy, optionalCellProp, physicsNode, specScope } from '../common/ctx.ts';
import { StageTimer, attachMesh, checkAbort, makeSolution } from '../common/solution.ts';
import { solveAxisymModes, nodalFields } from '../em-axisym/index.ts';
import { materialTensor, solidBcsOf } from './twoway.ts';
import { STIFFNESS_COMPONENTS } from '../coupled/tensors.ts';
import { isoD } from '../coupled/assemble.ts';
import { cubicT4, azimuthalAverage, axisymD, type T4 } from '../optomech/tensors.ts';
import {
  HBAR, toTri3, interfaceEdges, movingBoundaryIntegral, photoelasticIntegral, opticalEnergy, modalMass, solidModesAxisym, fixSign,
  evalU, type OpticalMode,
} from '../optomech/axisym.ts';

export const OPTOMECH_NORMALIZATION =
  'optical E per mode: arbitrary (g is a ratio); mechanical u per mode: max |u| over the solid nodes = 1 m after the overlap (alpha = max |Q|, Eichenfield 2009 app. D), sign: dominant component at the max node positive';

const modeSet = z.strictObject({ nModes: z.number().int().min(1).optional(), shift: quantity('Hz', { ge: 0 }).optional() });
const peEntry = z.strictObject({
  material: z.string(),
  p11: z.number(), p12: z.number(), p44: z.number(),
  frame: z.enum(['crystal-avg', 'cylindrical']).optional(),
});
export const optomechSettings = z.strictObject({ optical: modeSet.optional(), mechanical: modeSet.optional(), photoelastic: z.array(peEntry).optional() });
type Settings = z.infer<typeof optomechSettings>;

/** Cell -> spec material id ('' = none). */
function materialIds(spec: Spec, m: Mesh): string[] {
  const owner: string[] = new Array(m.entities.domains.length).fill('');
  for (const mat of spec.materials ?? []) for (const d of selectEntities(m.entities, 'domains', mat.select)) owner[d] = mat.id;
  return Array.from(m.cells.domain, (d) => owner[d]!);
}

/**
 * Solid cells of the photoelastic integral: photoelastic solid cells outside the optical (emw-axisym) domain have no
 * eps_r and no optical field, so they are skipped with a note (audit FE item 5; before, they made g0PE NaN).
 */
export function photoelasticCells(sMask: Uint8Array, oMask: Uint8Array, matOf: readonly string[], isPE: (t: number) => boolean, opticalId: string): { mask: Uint8Array; note: string | null } {
  const mask = Uint8Array.from(sMask, (x, c) => (x && oMask[c] ? 1 : 0));
  const out = new Map<string, number>();
  for (let c = 0; c < sMask.length; c++) if (sMask[c] && !oMask[c] && isPE(c)) out.set(matOf[c]!, (out.get(matOf[c]!) ?? 0) + 1);
  const note = out.size ? `optomechanical: ${[...out].map(([id, n]) => `${n} cells of photoelastic '${id}'`).join(', ')} lie outside the optical domain '${opticalId}'; skipped in the photoelastic integral (the optical mode is solved only inside its closed window, so E = 0 there in this model)` : null;
  return { mask, note };
}

export function optomechReadiness(spec: Spec, node: CouplingNode): string[] {
  const out: string[] = [];
  try {
    const el = physicsNode(spec, node.from), op = physicsNode(spec, node.to);
    if (!(spec.geometry as { axisym?: boolean }).axisym) out.push('optomechanical: needs an axisymmetric geometry (emw-axisym); 3D is not implemented (DevLog-034 s.3)');
    for (const b of el.bcs ?? []) if (!['fixed', 'roller', 'free'].includes(b.type)) out.push(`${node.from}: condition '${b.type}' not supported in an optomechanical run (fixed, roller, free)`);
    for (const b of op.bcs ?? []) if (b.type !== 'pec') out.push(`${node.to}: condition '${b.type}' not supported (pec; other boundaries are PMC)`);
    const az = ((op as { settings?: { azimuthal?: number[] } }).settings ?? {}).azimuthal;
    if (!az?.length) out.push(`${node.to}: settings.azimuthal (list of azimuthal orders m) is required`);
    const r = optomechSettings.safeParse(node.settings ?? {});
    if (!r.success) out.push(`settings: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    else for (const p of r.data.photoelastic ?? []) {
      if ((p.frame ?? 'crystal-avg') === 'crystal-avg' && az?.includes(2)) out.push(`photoelastic '${p.material}': frame crystal-avg is exact for azimuthal orders m != 2 only`);
      if (!(spec.materials ?? []).some((m) => m.id === p.material)) out.push(`photoelastic: no material '${p.material}' in the spec`);
    }
    const st = (spec.studies ?? []).filter((s) => s.physics.includes(node.from) && s.physics.includes(node.to));
    if (!st.length || st.some((s) => s.type !== 'eigen')) out.push('optomechanical: eigen studies only');
  } catch (e) { out.push((e as Error).message); }
  return out;
}

const modeOpts = (spec: Spec, base: { nModes: number; shiftHz: number | null }, s?: z.infer<typeof modeSet>) => {
  let shiftHz = base.shiftHz;
  if (s?.shift !== undefined) { const r = resolveQuantity(s.shift, specScope(spec)); if (r.na) throw new Error('optomechanical: shift is N/A'); shiftHz = r.si; }
  return { nModes: s?.nModes ?? base.nModes, shiftHz };
};

const optomechanical: CouplingImpl & { readiness(spec: Spec, node: CouplingNode): string[] } = {
  type: 'optomechanical', from: 'elastic', to: 'emw-axisym', kind: 'monolithic',
  readiness: optomechReadiness,
  async run(a) {
    const cM = a.ctx[a.node.from], cO = a.ctx[a.node.to];
    if (!cM || !cO) throw new Error(`coupling '${a.node.id}': run contexts of '${a.node.from}' and '${a.node.to}' required`);
    const spec = cM.spec, mesh = cM.mesh, node = a.node, nc = nCells(mesh);
    const bad = optomechReadiness(spec, node);
    if (bad.length) throw new Error(`optomechanical '${node.id}' not ready: ${bad.join('; ')}`);
    const set = optomechSettings.parse(node.settings ?? {}) as Settings;
    const timer = new StageTimer();
    const notes: string[] = [];

    // ---- optical modes (emw-axisym, per azimuthal order)
    timer.start('optical');
    const { mask: oMask, values: oVals } = cellProps(cO, ['eps_r']);
    const mu = optionalCellProp(cO, 'mu_r', oMask);
    for (let c = 0; c < nc; c++) if (oMask[c] && !Number.isFinite(mu[c]!)) mu[c] = 1;
    const epsR = oVals.eps_r!;
    const os = (physicsNode(spec, node.to).settings ?? {}) as { azimuthal: number[]; order?: 1 | 2 };
    const order = os.order ?? 2;
    const oOpt = modeOpts(spec, eigenStudy(cO), set.optical);
    if (oOpt.shiftHz === null) throw new Error('optomechanical: the optical modes need a shift (Hz): settings.optical.shift or the study shift');
    const mesh3 = toTri3(mesh);
    const optical: Array<OpticalMode & { f: number; ez: number }> = [];
    const pec = bcSelections(spec, node.to, 'pec');
    let oDof = 0;
    for (const m of os.azimuthal) {
      const r = await solveAxisymModes({ mesh: mesh3, m, order, epsR, muR: mu, mask: oMask, pec, nModes: oOpt.nModes, shiftHz: oOpt.shiftHz, signal: cO.signal });
      oDof += r.stats.dof;
      r.steps!.values.forEach((f, k) => optical.push({ mesh: mesh3, space: r.space, order, x: r.x[k]!, omega: 2 * Math.PI * f, m, f, ez: r.detail.ezFraction[k]! }));
    }
    optical.sort((p, q) => p.f - q.f);
    timer.stop('optical');
    checkAbort(cM.signal);

    // ---- mechanical modes (axisym, azimuthal order 0)
    timer.start('mechanical');
    const { mask: sMask, values: sVals } = cellProps(cM, ['rho']);
    const matOf = materialIds(spec, mesh);
    const Dof = new Map<string, Float64Array>();
    const stiffNote = new Set<string>();
    const D = (e: number): Float64Array => {
      const id = matOf[e]!;
      let d = Dof.get(id);
      if (d) return d;
      const Ct = materialTensor(spec, cM.materials, id, 'C', STIFFNESS_COMPONENTS);
      const rec = cM.materials[id] ?? {};
      if (Ct) {
        if (Ct.sym !== 'cubic') throw new Error(`optomechanical: stiffness tensor of '${id}' has symmetry ${Ct.sym}; axisymmetric runs take cubic (azimuthally averaged) or isotropic E, nu`);
        d = axisymD(azimuthalAverage(cubicT4(Ct.c.C11!, Ct.c.C12!, Ct.c.C44!)));
        stiffNote.add(`optomechanical: '${id}' stiffness = azimuthal average of the cubic tensor (crystal [001] on the axis; the 4 phi part is dropped, an approximation)`);
      } else if (typeof rec.E === 'number' && typeof rec.nu === 'number') d = isoD('axisym', rec.E, rec.nu);
      else throw new Error(`optomechanical: material '${id}' has neither a cubic stiffness tensor C nor E, nu`);
      Dof.set(id, d);
      return d;
    };
    const mOpt = modeOpts(spec, { nModes: eigenStudy(cM).nModes, shiftHz: null }, set.mechanical);
    const sm = solidModesAxisym({ mesh, mask: sMask, D, rho: sVals.rho!, bcs: solidBcsOf(spec, node.from, mesh), nModes: mOpt.nModes, shiftHz: mOpt.shiftHz, signal: cM.signal });
    notes.push(...stiffNote);
    timer.stop('mechanical');
    checkAbort(cM.signal);

    // ---- photoelastic tensors per material, in the (r, phi, z) frame
    const peOf = new Map<string, T4>();
    for (const p of set.photoelastic ?? []) {
      const t = cubicT4(p.p11, p.p12, p.p44);
      peOf.set(p.material, (p.frame ?? 'crystal-avg') === 'crystal-avg' ? azimuthalAverage(t) : t);
    }
    const P = (t: number) => peOf.get(matOf[t]!) ?? null;
    const { mask: peMask, note: peNote } = photoelasticCells(sMask, oMask, matOf, (t) => !!P(t), node.to);
    if (peNote) notes.push(peNote);

    // ---- pairs
    timer.start('overlap');
    const { edges, open } = interfaceEdges(mesh3, oMask, sMask, epsR);
    if (open) notes.push(`optomechanical: ${open} solid boundary edges lie on the edge of the optical domain; they are not part of the moving-boundary integral`);
    const W = optical.map((o) => opticalEnergy(o, epsR, oMask));
    const scalars: Solution['scalars'] = {};
    const mech = sm.u.map((u0, j) => {
      const u = Float64Array.from(u0);
      const mm = modalMass(mesh, u, sMask, sVals.rho!);
      fixSign(u, mm.at);
      for (let i = 0; i < u.length; i++) u[i] = u[i]! / mm.umax;   // max |Q| = 1 m
      const Om = 2 * Math.PI * sm.freqs[j]!;
      const meff = mm.mass / (mm.umax * mm.umax);
      const xzpf = Om > 0 ? Math.sqrt(HBAR / (2 * meff * Om)) : NaN;
      return { u, f: sm.freqs[j]!, meff, xzpf };
    });
    optical.forEach((o, i) => {
      scalars[`${node.to}.f_${i}`] = { value: o.f, unit: 'Hz' };
      scalars[`${node.to}.m_${i}`] = { value: o.m, unit: '1' };
      scalars[`${node.to}.ezFraction_${i}`] = { value: o.ez, unit: '1' };
    });
    mech.forEach((q, j) => {
      scalars[`${node.from}.f_${j}`] = { value: q.f, unit: 'Hz' };
      scalars[`${node.from}.meff_${j}`] = { value: q.meff, unit: 'kg' };
      scalars[`${node.from}.xzpf_${j}`] = { value: q.xzpf, unit: 'm' };
    });
    optical.forEach((o, i) => mech.forEach((q, j) => {
      if (!(q.f > 0)) return;
      const qf = (t: number, r: number, zz: number): [number, number] => { const v = evalU(mesh, q.u, t, r, zz); return [v[0]!, v[1]!]; };
      const gMB = (-o.omega / 2) * movingBoundaryIntegral(o, edges, epsR, qf) / W[i]!;
      const gPE = peOf.size ? (-o.omega / 2) * photoelasticIntegral(o, mesh, q.u, peMask, epsR, P) / W[i]! : 0;
      const tp = 2 * Math.PI;
      scalars[`gOMMB_${i}_${j}`] = { value: gMB / tp, unit: 'Hz/m' };
      scalars[`gOMPE_${i}_${j}`] = { value: gPE / tp, unit: 'Hz/m' };
      scalars[`gOM_${i}_${j}`] = { value: (gMB + gPE) / tp, unit: 'Hz/m' };
      scalars[`g0MB_${i}_${j}`] = { value: (gMB * q.xzpf) / tp, unit: 'Hz' };
      scalars[`g0PE_${i}_${j}`] = { value: (gPE * q.xzpf) / tp, unit: 'Hz' };
      scalars[`g0_${i}_${j}`] = { value: ((gMB + gPE) * q.xzpf) / tp, unit: 'Hz' };
    }));
    timer.stop('overlap');

    // ---- solution: optical steps then mechanical steps
    const six = mesh.cells.type === 'tri6';
    const fields: FieldData[] = [];
    optical.forEach((o, i) => fields.push({ name: 'E_rphiz', unit: 'V/m', space: six ? 'H1P2' : 'H1P1', components: 3, data: nodalFields(mesh3, o.space as Parameters<typeof nodalFields>[1], order, o.x, six ? mesh.cells.conn : undefined), step: i, physics: node.to }));
    mech.forEach((q, j) => fields.push({ name: 'u', unit: 'm', space: six ? 'H1P2' : 'H1P1', components: 2, data: q.u, step: optical.length + j, physics: node.from }));
    const sol = await makeSolution({
      mesh, spec, fields, scalars, timer,
      steps: { kind: 'eigen', values: Float64Array.from([...optical.map((o) => o.f), ...mech.map((q) => q.f)]), unit: 'Hz' },
      stats: { dof: oDof + sm.dof, nnz: sm.nnz, residual: sm.residual, solver: `${node.to}: axisym per m (${os.azimuthal.join(', ')}); ${node.from}: ${sm.solver}`,
        byPhysics: { [node.to]: { dof: oDof, solver: 'emw-axisym shift-invert' }, [node.from]: { dof: sm.dof, solver: sm.solver, nnz: sm.nnz } } },
    });
    const out = sol as Solution & { notes?: string[]; normalization?: string };
    out.normalization = OPTOMECH_NORMALIZATION;
    out.notes = [
      `optomechanical '${node.id}': steps 0..${optical.length - 1} are optical modes (${node.to}), steps ${optical.length}..${optical.length + mech.length - 1} mechanical modes (${node.from})`,
      ...notes,
    ];
    attachMesh(out, mesh);
    return out;
  },
};

export const OPTOMECH_COUPLINGS: CouplingImpl[] = [optomechanical];
/** Material properties of the coupling (readiness / prepareRun): density of the solid (m_eff, modal mass). */
export const OPTOMECH_NEEDS: Record<string, { to?: string[]; from?: string[] }> = { optomechanical: { from: ['rho'], to: ['eps_r'] } };

const own = { owner: '@amp/physics' } as const;
export const OPTOMECH_REGISTRATIONS: Registration[] = [
  { kind: 'coupling', type: 'optomechanical', ...own, for: ['elastic', 'emw-axisym'],
    description: 'Vacuum optomechanical coupling g0 per optical x mechanical mode pair: moving boundary (Johnson 2002) + photoelastic (cubic p tensor); axisymmetric, mechanical azimuthal order 0',
    settings: optomechSettings },
];

