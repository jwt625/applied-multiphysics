// SPDX-License-Identifier: GPL-3.0-or-later
// Monolithic two-way couplings of lane MT (C11, DevLog-033):
//   piezoelectric       elastic -> electrostatics   coupled u-V, eigen (short / open circuit) and stationary
//   acoustic-structure  elastic -> acoustics        coupled u-p eigenfrequencies (unsymmetric u-p form)
// and their spec registrations (couplings; provisional tensor material properties C and e_piezo, uniaxial eps_r).
// Material tensors are read from the spec materials (override tensor objects {symmetry, unit, components}) or from
// flattened keys '<prop>.<component>' in RunContext.materials (if the material resolver provides them); a solid
// material without C uses its isotropic E, nu. Crystal orientation: settings.crystals (per material, the em-modes /
// electrostatics form) or settings.euler (ZXZ, every material; advanced). Solvers: coupled/piezo.ts, coupled/fsi.ts.

import * as z from 'zod';
import { resolveQuantity, vector, quantity, type Registration } from '@amp/spec';
import type { CouplingNode, Mesh, RunContext, Solution, Spec } from '@amp/spec/types';
import type { CouplingImpl } from './core.ts';
import { cellMask, nCells, selectEntities } from '../common/mesh.ts';
import { bcsOf, cellProps, eigenStudy, physicsNode, q, qVec, specScope } from '../common/ctx.ts';
import { compileField, evalField, spaceOf } from '../common/field.ts';
import { EPS0 } from '../electrostatics/index.ts';
import { electrostaticsCrystals } from '../electrostatics/aniso.ts';
import { crystalsSchema } from './photonic.ts';
import type { SolidBc, SolidModel } from '../coupled/assemble.ts';
import { solvePiezo, PIEZO_NORMALIZATION, type PiezoCellMaterial } from '../coupled/piezo.ts';
import { solveAcousticStructure, FSI_NORMALIZATION } from '../coupled/fsi.ts';
import {
  stiffnessMatrix, piezoMatrix, permittivityMatrix, isotropicStiffness, eulerZXZ, rotateStiffness, rotatePiezo, rotate2,
  STIFFNESS_COMPONENTS, PIEZO_COMPONENTS, PERMITTIVITY_COMPONENTS, type Mat,
} from '../coupled/tensors.ts';

export { PIEZO_NORMALIZATION, FSI_NORMALIZATION };

// ------------------------------------------------------------------------------------------------ spec helpers

type Tensor = { sym: string; c: Record<string, number> };

/** Tensor property of a material: override tensor object, else flattened '<prop>.<component>' keys of ctx.materials. */
export function materialTensor(spec: Spec, materials: RunContext['materials'], matId: string, prop: string, comps: Record<string, readonly string[]>): Tensor | null {
  const mat = (spec.materials ?? []).find((m) => m.id === matId);
  const ov = ((mat as { override?: Record<string, unknown> } | undefined)?.override ?? {})[prop] as { symmetry?: string; unit?: string; components?: Record<string, unknown> } | undefined;
  if (ov && typeof ov === 'object' && typeof ov.symmetry === 'string' && ov.components) {
    const scope = specScope(spec), c: Record<string, number> = {};
    for (const [k, v] of Object.entries(ov.components)) {
      const r = resolveQuantity(typeof v === 'number' ? (ov.unit ? { value: v, unit: ov.unit } : v) : v, scope);
      if (r.na) throw new Error(`materials.${matId}.override.${prop}.${k} is N/A`);
      c[k] = r.si;
    }
    return { sym: ov.symmetry, c };
  }
  const rec = materials[matId] ?? {};
  // flattened keys carry no symmetry: it is inferred from the exact component key set (audit FE item 7), e.g. stiffness
  // with C14 -> trigonal-3m, with C66 -> tetragonal-4mm, both or neither of a 6-key set -> error. Symmetries with the
  // same key set (piezo e15, e31, e33: hexagonal-6mm and tetragonal-4mm) have the same tensor form in coupled/tensors.ts.
  const pre = `${prop}.`;
  const keys = new Set(Object.keys(rec).filter((k) => k.startsWith(pre) && typeof rec[k] === 'number').map((k) => k.slice(pre.length)));
  if (!keys.size) return null;
  const hit = Object.entries(comps).find(([, names]) => names.length === keys.size && names.every((n) => keys.has(n)));
  if (!hit) throw new Error(`material '${matId}': ${prop} components {${[...keys].sort().join(', ')}} match no supported symmetry exactly (${Object.entries(comps).map(([sy, n]) => `${sy}: ${n.join(' ')}`).join('; ')}); the symmetry is ambiguous, give ${prop} as a tensor override {symmetry, components}`);
  return { sym: hit[0], c: Object.fromEntries(hit[1].map((n) => [n, rec[`${pre}${n}`]!])) };
}

/** Cell -> spec material index (cells without a material: -1). */
function materialOfCell(spec: Spec, m: Mesh): Int32Array {
  const owner = new Int32Array(m.entities.domains.length).fill(-1);
  (spec.materials ?? []).forEach((mat, k) => { for (const d of selectEntities(m.entities, 'domains', mat.select)) owner[d] = k; });
  return Int32Array.from(m.cells.domain, (d) => owner[d]!);
}

/** Elastic BCs of the spec as solver BCs (fixed, roller, free, pressure, boundary-load), as elastic/index.ts reads them. */
export function solidBcsOf(spec: Spec, physicsId: string, mesh: Mesh): SolidBc[] {
  const out: SolidBc[] = [], sp = spaceOf(mesh);
  for (const b of bcsOf(spec, physicsId)) {
    const s = b.settings ?? {};
    switch (b.type) {
      case 'fixed': out.push({ type: 'fixed', select: b.select }); break;
      case 'roller': out.push({ type: 'roller', select: b.select }); break;
      case 'displacement': (['ux', 'uy', 'uz'] as const).slice(0, mesh.dim).forEach((k, c) => { if (s[k] !== undefined) out.push({ type: 'displacement', select: b.select, component: c, value: q(spec, s[k], `${b.id}.${k}`) }); }); break;
      case 'free': break;
      case 'pressure': { const pf = compileField(spec, s.p, sp, `${b.id}.p`, 'space'); out.push({ type: 'pressure', select: b.select, p: typeof pf === 'number' ? pf : (x) => pf(x, 0) }); break; }
      case 'boundary-load': {
        const tr = s.traction as unknown;
        const comps = Array.isArray(tr) ? tr : tr && typeof tr === 'object' && Array.isArray((tr as { value: unknown[] }).value)
          ? (tr as { value: number[]; unit: string }).value.map((v) => ({ value: v, unit: (tr as { unit: string }).unit })) : null;
        if (!comps) throw new Error(`${b.id}.traction: expected a vector`);
        const fs = comps.map((c, i) => compileField(spec, c, sp, `${b.id}.traction[${i}]`, 'space'));
        out.push({ type: 'traction', select: b.select, t: fs.every((v) => typeof v === 'number') ? (fs as number[]) : (x) => fs.map((f) => evalField(f, x)) });
        break;
      }
      default: throw new Error(`elastic: unsupported condition '${b.type}' in a coupled run`);
    }
  }
  return out;
}

function solidModel(spec: Spec, physicsId: string, mesh: Mesh): SolidModel {
  const s = (physicsNode(spec, physicsId) as { settings?: { model?: SolidModel } }).settings ?? {};
  const model = s.model ?? (mesh.dim === 3 ? '3d' : mesh.axisym ? 'axisym' : undefined);
  if (!model) throw new Error(`elastic '${physicsId}': settings.model (plane-stress | plane-strain) required in 2D`);
  return model;
}

/**
 * Crystal rotation per material (R maps crystal-frame to model-frame components). Two forms, exactly one per coupling:
 * settings.crystals (the user-facing form shared with em-modes and electrostatics: per material cut = crystal axis
 * along model y, propagation = crystal axis along model z, rotation about z; modes/crystal.mjs labFromCrystal, merged
 * with the electrostatics physics' and its couplings' crystals as electrostatics/aniso.ts does), or settings.euler
 * (advanced: ZXZ angles applied to every material). Materials without an entry keep the crystal frame = model frame.
 */
function rotationsOf(spec: Spec, node: CouplingNode): (matId: string) => Mat | null {
  const s = (node.settings ?? {}) as { euler?: unknown; crystals?: unknown };
  if (s.euler !== undefined && s.crystals !== undefined) throw new Error(`couplings.${node.id}: give settings.crystals or settings.euler, not both`);
  if (s.euler !== undefined) {
    const v = qVec(spec, s.euler, `couplings.${node.id}.settings.euler`);
    if (v.length !== 3) throw new Error(`couplings.${node.id}.settings.euler: three angles (ZXZ)`);
    const R = eulerZXZ(v[0]!, v[1]!, v[2]!);
    return () => R;
  }
  const cr = electrostaticsCrystals(spec, node.to);
  return (matId) => { const c = cr.get(matId); return c ? [0, 1, 2].map((i) => [c.A[3 * i]!, c.A[3 * i + 1]!, c.A[3 * i + 2]!]) : null; };
}

// ------------------------------------------------------------------------------------------------ piezoelectric

function piezoContexts(a: { ctx: Record<string, RunContext>; node: CouplingNode }): { E: RunContext; V: RunContext } {
  const E = a.ctx[a.node.from], V = a.ctx[a.node.to];
  if (!E || !V) throw new Error(`coupling '${a.node.id}': run contexts of '${a.node.from}' and '${a.node.to}' required`);
  return { E, V };
}

export function piezoReadiness(spec: Spec, node: CouplingNode): string[] {
  const out: string[] = [];
  try {
    const el = physicsNode(spec, node.from), es = physicsNode(spec, node.to);
    const okE = new Set(['fixed', 'roller', 'free', 'boundary-load', 'pressure', 'displacement']), okV = new Set(['ground', 'potential', 'terminal', 'zero-charge']);
    for (const b of el.bcs ?? []) if (!okE.has(b.type)) out.push(`${node.from}: condition '${b.type}' not supported in a piezoelectric run`);
    for (const b of es.bcs ?? []) if (!okV.has(b.type)) out.push(`${node.to}: condition '${b.type}' not supported in a piezoelectric run`);
    if (!(es.bcs ?? []).some((b) => b.type === 'ground' || b.type === 'potential')) out.push(`${node.to}: a ground or potential electrode is required (the potential is otherwise undetermined)`);
    if ((el as { settings?: { model?: string } }).settings?.model === 'plane-stress') out.push(`${node.from}: piezoelectric runs support plane-strain and 3d (not plane-stress)`);
    if ((spec.geometry as { axisym?: boolean }).axisym) out.push('piezoelectric: axisymmetric geometry is not supported');
  } catch (e) { out.push((e as Error).message); }
  return out;
}

const piezoelectric: CouplingImpl & { readiness(spec: Spec, node: CouplingNode): string[] } = {
  type: 'piezoelectric', from: 'elastic', to: 'electrostatics', kind: 'monolithic',
  readiness: piezoReadiness,
  async run(a) {
    const { E: cE, V: cV } = piezoContexts(a);
    const spec = cE.spec, m = cE.mesh, nc = nCells(m);
    const bad = piezoReadiness(spec, a.node);
    if (bad.length) throw new Error(`piezoelectric '${a.node.id}' not ready: ${bad.join('; ')}`);
    const model = solidModel(spec, a.node.from, m);
    if (model !== '3d' && model !== 'plane-strain') throw new Error(`piezoelectric: model ${model} not supported`);
    const solid = cellMask(m, physicsNode(spec, a.node.from).select), dielectric = cellMask(m, physicsNode(spec, a.node.to).select);
    const rotOf = rotationsOf(spec, a.node);
    const matIdx = materialOfCell(spec, m);
    const specMats = spec.materials ?? [];
    const used = new Set<number>();
    for (let c = 0; c < nc; c++) if (solid[c] || dielectric[c]) { if (matIdx[c]! < 0) throw new Error(`piezoelectric: cell ${c} has no material`); used.add(matIdx[c]!); }
    const eigen = cE.study.type === 'eigen';
    const mats: PiezoCellMaterial[] = specMats.map((mt, k) => {
      if (!used.has(k)) return { rho: NaN };
      const rec = cE.materials[mt.id] ?? {};
      const inSolid = Array.from(solid).some((s, c) => s && matIdx[c] === k), inDiel = Array.from(dielectric).some((s, c) => s && matIdx[c] === k);
      const out: PiezoCellMaterial = { rho: typeof rec.rho === 'number' ? rec.rho : NaN };
      const R = rotOf(mt.id);
      if (inSolid) {
        if (eigen && !(out.rho > 0)) throw new Error(`piezoelectric: material '${mt.id}' has no density rho`);
        const Ct = materialTensor(spec, cE.materials, mt.id, 'C', STIFFNESS_COMPONENTS);
        let C: Mat;
        if (Ct) C = stiffnessMatrix(Ct.sym, Ct.c);
        else if (typeof rec.E === 'number' && typeof rec.nu === 'number') C = isotropicStiffness(rec.E, rec.nu);
        else throw new Error(`piezoelectric: material '${mt.id}' has neither a stiffness tensor C nor E, nu`);
        out.C = R ? rotateStiffness(C, R) : C;
        const et = materialTensor(spec, cE.materials, mt.id, 'e_piezo', PIEZO_COMPONENTS);
        if (et) { const e = piezoMatrix(et.sym, et.c); out.e = R ? rotatePiezo(e, R) : e; }
      }
      if (inDiel) {
        const recV = cV.materials[mt.id] ?? rec;
        // permittivity eps_r: uniaxial tensor (crystal frame) or scalar; a piezoelectric needs the clamped eps^S values
        const pt = materialTensor(spec, cV.materials, mt.id, 'eps_r', PERMITTIVITY_COMPONENTS);
        let er: Mat;
        if (pt) er = permittivityMatrix(pt.sym, pt.c);
        else if (typeof recV.eps_r === 'number') er = [[recV.eps_r, 0, 0], [0, recV.eps_r, 0], [0, 0, recV.eps_r]];
        else throw new Error(`piezoelectric: material '${mt.id}' has no permittivity eps_r`);
        const eps = er.map((r) => r.map((v) => v * EPS0));
        out.eps = R ? rotate2(eps, R) : eps;
      }
      return out;
    });
    const ground: string[] = [], potentials: Array<{ id: string; select: string[]; V: number }> = [], floating: Array<{ id: string; select: string[] }> = [];
    for (const b of bcsOf(spec, a.node.to)) {
      if (b.type === 'ground') ground.push(...b.select);
      else if (b.type === 'potential') potentials.push({ id: b.id, select: b.select, V: q(spec, (b.settings ?? {}).V, `${b.id}.V`) });
      else if (b.type === 'terminal') floating.push({ id: b.id, select: b.select });
    }
    const study = eigen ? { kind: 'eigen' as const, ...eigenStudy(cE) } : { kind: 'stationary' as const };
    if (!eigen && cE.study.type !== 'stationary') throw new Error(`piezoelectric: study type '${cE.study.type}' not supported (eigen, stationary)`);
    const sol = await solvePiezo({
      mesh: m, model, solid, dielectric, matOf: Int32Array.from(matIdx, (v) => Math.max(v, 0)), mats, solidBcs: solidBcsOf(spec, a.node.from, m),
      ground, potentials, floating, study, spec, signal: cE.signal, tags: { u: a.node.from, V: a.node.to },
    });
    return sol as Solution;
  },
};

// ------------------------------------------------------------------------------------------------ acoustic-structure

export function fsiReadiness(spec: Spec, node: CouplingNode): string[] {
  const out: string[] = [];
  try {
    const el = physicsNode(spec, node.from), ac = physicsNode(spec, node.to);
    const okE = new Set(['fixed', 'roller', 'free', 'boundary-load', 'pressure', 'displacement']);
    for (const b of el.bcs ?? []) if (!okE.has(b.type)) out.push(`${node.from}: condition '${b.type}' not supported in an acoustic-structure run`);
    for (const b of ac.bcs ?? []) if (b.type !== 'sound-hard' && b.type !== 'pressure') out.push(`${node.to}: condition '${b.type}' not supported (sound-hard, pressure p = 0)`);
    const st = (spec.studies ?? []).filter((s) => s.physics.includes(node.from) && s.physics.includes(node.to));
    if (!st.length || st.some((s) => s.type !== 'eigen')) out.push('acoustic-structure: eigen studies only (driven response not implemented)');
  } catch (e) { out.push((e as Error).message); }
  return out;
}

const acousticStructure: CouplingImpl & { readiness(spec: Spec, node: CouplingNode): string[] } = {
  type: 'acoustic-structure', from: 'elastic', to: 'acoustics', kind: 'monolithic',
  readiness: fsiReadiness,
  async run(a) {
    const cE = a.ctx[a.node.from], cA = a.ctx[a.node.to];
    if (!cE || !cA) throw new Error(`coupling '${a.node.id}': run contexts of '${a.node.from}' and '${a.node.to}' required`);
    const spec = cE.spec, m = cE.mesh;
    const bad = fsiReadiness(spec, a.node);
    if (bad.length) throw new Error(`acoustic-structure '${a.node.id}' not ready: ${bad.join('; ')}`);
    const model = solidModel(spec, a.node.from, m);
    const s = cellProps(cE, ['E', 'nu', 'rho']), f = cellProps(cA, ['c', 'rho']);
    const pz: string[] = [];
    for (const b of bcsOf(spec, a.node.to)) if (b.type === 'pressure') {
      if (q(spec, (b.settings ?? {}).p, `${b.id}.p`) !== 0) throw new Error(`acoustic-structure eigen: pressure boundary ${b.id} must be p = 0`);
      pz.push(...b.select);
    }
    const { nModes, shiftHz } = eigenStudy(cE);
    const sol = await solveAcousticStructure({
      mesh: m, model, solid: s.mask, fluid: f.mask, E: s.values.E!, nu: s.values.nu!, rhoS: s.values.rho!, c: f.values.c!, rhoF: f.values.rho!,
      solidBcs: solidBcsOf(spec, a.node.from, m).filter((b) => b.type !== 'traction' && b.type !== 'pressure'), pressureZero: pz,
      nModes, shiftHz, spec, signal: cE.signal, tags: { u: a.node.from, p: a.node.to },
    });
    return sol as Solution;
  },
};

export const TWOWAY_COUPLINGS: CouplingImpl[] = [piezoelectric, acousticStructure];

const own = { owner: '@amp/physics', provisional: true } as const;
export const TWOWAY_REGISTRATIONS: Registration[] = [
  { kind: 'coupling', type: 'piezoelectric', owner: '@amp/physics', for: ['elastic', 'electrostatics'],
    description: 'Monolithic piezoelectric u-V (stress-charge form); eigen with short circuit (grounded electrodes) or open circuit (terminal = floating electrode), and stationary; 3d and plane-strain',
    settings: z.strictObject({
      crystals: crystalsSchema.optional(),
      euler: vector('1', 3).optional().meta({ description: 'advanced alternative to crystals: ZXZ Euler angles (phi, theta, psi), R = Rz(phi) Rx(theta) Rz(psi) maps crystal-frame to model-frame components, applied to every material' }),
    }),
    check: (n) => { const st = (n.settings ?? {}) as { euler?: unknown; crystals?: unknown }; return st.euler !== undefined && st.crystals !== undefined ? [{ path: ['settings'], message: 'give crystals or euler, not both' }] : []; } },
  { kind: 'coupling', type: 'acoustic-structure', owner: '@amp/physics', for: ['elastic', 'acoustics'],
    description: 'Monolithic acoustic-structure eigenfrequencies, unsymmetric u-p form; wet interface = faces shared by elastic and acoustics domains' },
  // elastic prescribed displacement components (lane MT, DevLog-033 E1; kept here so it reaches L4_REGISTRATIONS through
  // COUPLING_REGISTRATIONS; MC may move it to registrations.ts). Point selections (pnt:) also work for 'fixed'.
  { kind: 'bc', type: 'displacement', owner: '@amp/physics', for: ['elastic'], select: ['bnd', 'pnt'],
    description: 'Prescribed displacement components ux, uy (, uz) on boundaries or points (any subset; the others stay free), e.g. to remove rigid-body motion',
    settings: z.strictObject({ ux: quantity('m').optional(), uy: quantity('m').optional(), uz: quantity('m').optional() }),
    check: (n) => { const st = (n.settings ?? {}) as Record<string, unknown>; return ['ux', 'uy', 'uz'].some((k) => st[k] !== undefined) ? [] : [{ path: ['settings'], message: 'give at least one of ux, uy, uz' }]; } },
  // tensor material properties needed by the piezoelectric coupling (provisional until @amp/materials adopts them)
  { kind: 'property', type: 'C', ...own, unit: 'Pa', scalar: false, tensor: STIFFNESS_COMPONENTS, description: 'Elastic stiffness tensor c^E (Voigt, crystal frame; z = c / poling axis)' },
  { kind: 'property', type: 'e_piezo', ...own, unit: 'C/m^2', scalar: false, tensor: PIEZO_COMPONENTS, description: 'Piezoelectric stress constants e (3x6 Voigt, crystal frame)' },
  // eps_r gains the uniaxial tensor form of @amp/materials (properties.ts: eps_r scalar | uniaxial); piezoelectric materials give the clamped eps^S
  { kind: 'property', type: 'eps_r', ...own, unit: '1', tensor: PERMITTIVITY_COMPONENTS, description: 'Relative permittivity (real part); scalar, or uniaxial perp / par in the crystal frame (piezoelectric: clamped eps^S)' },
];

void z;
