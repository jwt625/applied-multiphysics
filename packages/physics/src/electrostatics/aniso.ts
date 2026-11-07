// SPDX-License-Identifier: GPL-3.0-or-later
// Anisotropic permittivity for electrostatics (lane MG, DevLog-036 R3; request R3 of DevLog-032 s.4).
// Per cell: scalar eps_r (isotropic), or a uniaxial tensor eps_r.perp / eps_r.par (crystal frame, c axis = crystal z)
// rotated to the lab frame with the material's crystal orientation: eps_lab = A diag(perp, perp, par) A^T,
// v_lab = A v_crystal (modes/crystal.mjs labFromCrystal; lab x lateral, y film normal, z propagation).
// 2D (per unit length, fields invariant along z): only the in-plane block [xx, xy, yy] enters div(eps grad V); the
// xz / yz components give D_z, which has no z derivative, so any crystal orientation is admissible.
// Crystal orientations: physics settings.crystals and the settings.crystals of every spec coupling whose from or to
// is this physics (e.g. the electro-optic coupling), merged by modes/coupled.ts mergeCrystals (one orientation per
// material; conflicting definitions are an error).

import type { Mesh, RunContext, Spec } from '@amp/spec/types';
import { resolveQuantity, resolveParams } from '@amp/spec';
import { elementSlots } from '@amp/core/la/sparse';
import { NPC, nCells, nNodes, selectEntities } from '../common/mesh.ts';
import { cellPattern, cellOrder, type Assembled } from '../common/scalar.ts';
import { defaultRule, gatherX, physGrad, shapeTable } from '../common/lagrange.ts';
import { physicsNode } from '../common/ctx.ts';
import { mergeCrystals, type Crystal } from '../modes/coupled.ts';
import { mat3 } from '../modes/crystal.mjs';

type Props = Record<string, number>;

/** Uniaxial eps_r of a material: flattened keys eps_r.perp / eps_r.par, else a spec override tensor object. */
function uniaxialEps(spec: Spec, props: Props | undefined, matId: string): { perp: number; par: number } | null {
  const p = props?.['eps_r.perp'], q = props?.['eps_r.par'];
  if (typeof p === 'number' && typeof q === 'number') return { perp: p, par: q };
  const mat = (spec.materials ?? []).find((m) => m.id === matId) as { override?: Record<string, unknown> } | undefined;
  const ov = mat?.override?.eps_r as { symmetry?: unknown; unit?: string; components?: Record<string, unknown> } | undefined;
  if (!ov || typeof ov !== 'object' || ov.symmetry === undefined) return null;
  if (ov.symmetry !== 'uniaxial' || !ov.components) throw new Error(`electrostatics: materials.${matId}.override.eps_r: symmetry '${String(ov.symmetry)}' not supported (uniaxial perp / par)`);
  const { scope } = resolveParams(spec.params ?? {});
  const get = (k: string): number => {
    const v = ov.components![k];
    if (v === undefined) throw new Error(`electrostatics: materials.${matId}.override.eps_r.components.${k} is missing`);
    const r = resolveQuantity(typeof v === 'number' && ov.unit ? { value: v, unit: ov.unit } : v, scope);
    if (r.na) throw new Error(`electrostatics: materials.${matId}.override.eps_r.components.${k} is N/A`);
    return r.si;
  };
  return { perp: get('perp'), par: get('par') };
}

/** Crystal orientations for an electrostatics physics: its settings.crystals and those of its spec couplings. */
export function electrostaticsCrystals(spec: Spec, physicsId: string): Map<string, Crystal> {
  const ph = physicsNode(spec, physicsId) as { settings?: { crystals?: unknown } };
  const cps = ((spec as { couplings?: Array<{ id: string; from: string; to: string; settings?: { crystals?: unknown } }> }).couplings ?? [])
    .filter((c) => (c.from === physicsId || c.to === physicsId) && c.settings?.crystals !== undefined);
  return mergeCrystals(spec, [
    { from: `physics '${physicsId}' settings`, list: ph.settings?.crystals },
    ...cps.map((c) => ({ from: `coupling '${c.id}' settings`, list: c.settings!.crystals })),
  ]);
}

export interface CellPermittivity {
  mask: Uint8Array;
  /** scalar eps_r per cell (NaN outside the physics and on anisotropic cells) */
  epsR: Float64Array;
  /** in-plane relative tensor per cell [xx, xy, yy] (isotropic cells [e, 0, e]); absent when every cell is isotropic */
  tensor?: Float64Array;
  /** material ids with an anisotropic permittivity */
  aniso: string[];
}

/**
 * Permittivity per cell of the physics domain. Returns undefined when no material of the domain is anisotropic (the
 * caller then keeps the scalar path, cellProps). Scalar eps_r wins over tensor keys when a material has both.
 */
export function cellPermittivity(ctx: RunContext): CellPermittivity | undefined {
  const spec = ctx.spec as Spec, m = ctx.mesh, nc = nCells(m);
  const phys = physicsNode(spec, ctx.physicsId);
  const physDoms = new Set(selectEntities(m.entities, 'domains', phys.select));
  const mats = spec.materials ?? [];
  const owner = new Int32Array(m.entities.domains.length).fill(-1);
  mats.forEach((mat, k) => {
    for (const d of selectEntities(m.entities, 'domains', mat.select)) {
      if (owner[d]! >= 0) throw new Error(`domain ${m.entities.domains[d]!.id} selected by materials '${mats[owner[d]!]!.id}' and '${mat.id}'`);
      owner[d] = k;
    }
  });
  const used = new Set<number>();
  for (const d of physDoms) if (owner[d]! >= 0) used.add(owner[d]!);
  const uni = new Map<number, { perp: number; par: number }>();
  for (const k of used) {
    const id = mats[k]!.id, rec = ctx.materials[id];
    if (typeof rec?.eps_r === 'number' && Number.isFinite(rec.eps_r)) continue;
    const u = uniaxialEps(spec, rec, id);
    if (u) uni.set(k, u);
  }
  if (!uni.size) return undefined;
  if (m.dim !== 2 || m.axisym) throw new Error(`electrostatics: anisotropic eps_r (material ${[...uni.keys()].map((k) => `'${mats[k]!.id}'`).join(', ')}) is supported in 2D (planar) only`);
  const crystals = electrostaticsCrystals(spec, ctx.physicsId);
  const lab = new Map<number, [number, number, number]>();
  for (const [k, u] of uni) {
    const id = mats[k]!.id;
    if (!(u.perp > 0 && u.par > 0) || !Number.isFinite(u.perp) || !Number.isFinite(u.par)) throw new Error(`electrostatics: material '${id}' eps_r perp ${u.perp}, par ${u.par} must be finite and > 0`);
    const c = crystals.get(id);
    if (!c) throw new Error(`electrostatics: material '${id}' has a uniaxial eps_r (perp, par) but no crystal orientation (physics settings.crystals or a coupling's settings.crystals: [{material: ${id}, cut, propagation}])`);
    const T = mat3.mul(mat3.mul(c.A, mat3.diag(u.perp, u.perp, u.par)), mat3.T(c.A));
    lab.set(k, [T[0]!, 0.5 * (T[1]! + T[3]!), T[4]!]);
  }
  const mask = new Uint8Array(nc), epsR = new Float64Array(nc).fill(NaN), tensor = new Float64Array(3 * nc).fill(NaN);
  for (let c = 0; c < nc; c++) {
    const d = m.cells.domain[c]!;
    if (!physDoms.has(d)) continue;
    const k = owner[d]!;
    if (k < 0) throw new Error(`domain ${m.entities.domains[d]!.id} has no material`);
    const t = lab.get(k);
    if (t) tensor.set(t, 3 * c);
    else {
      const id = mats[k]!.id, rec = ctx.materials[id];
      if (!rec) throw new Error(`material '${id}' not resolved in ctx.materials`);
      const v = rec.eps_r;
      if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`material '${id}' has no value for 'eps_r'`);
      epsR[c] = v;
      tensor[3 * c] = v; tensor[3 * c + 1] = 0; tensor[3 * c + 2] = v;
    }
    mask[c] = 1;
  }
  return { mask, epsR, tensor, aniso: [...uni.keys()].map((k) => mats[k]!.id) };
}

/** K_ab = int G_a . (eps0 eps) G_b dA (2D, per unit length) with a 2x2 tensor per cell [xx, xy, yy] (absolute, F/m). */
export function assembleTensor2D(mesh: Mesh, eps: Float64Array, mask: Uint8Array): Assembled {
  if (mesh.dim !== 2) throw new Error('assembleTensor2D: 2D meshes only');
  const type = mesh.cells.type, k = NPC[type], nc = nCells(mesh), nn = nNodes(mesh);
  const pat = cellPattern(mesh);
  const slots = elementSlots(pat, mesh.cells.conn, k) as Int32Array;
  // same rule as assembleCells (degree 2 * order: exact for straight P1 / P2 with a constant coefficient)
  const r = defaultRule(type, 2 * cellOrder(mesh));
  const t = shapeTable(type, r);
  const K = new Float64Array(pat.nnz), active = new Uint8Array(nn);
  const X = new Float64Array(2 * k), G = new Float64Array(2 * k), Ke = new Float64Array(k * k);
  for (let e = 0; e < nc; e++) {
    if (!mask[e]) continue;
    gatherX(mesh.nodes, 2, mesh.cells.conn, e, k, X);
    Ke.fill(0);
    const exx = eps[3 * e]!, exy = eps[3 * e + 1]!, eyy = eps[3 * e + 2]!;
    for (let q = 0; q < r.n; q++) {
      const w = physGrad(t, q, X, 2, G) * r.wts[q]!;
      for (let a = 0; a < k; a++) {
        const gx = G[2 * a]!, gy = G[2 * a + 1]!;
        const dx = exx * gx + exy * gy, dy = exy * gx + eyy * gy;
        for (let b = a; b < k; b++) Ke[k * a + b]! += (dx * G[2 * b]! + dy * G[2 * b + 1]!) * w;
      }
    }
    const base = k * k * e;
    for (let a = 0; a < k; a++) {
      active[mesh.cells.conn[k * e + a]!] = 1;
      for (let b = 0; b < k; b++) K[slots[base + k * a + b]!]! += Ke[a <= b ? k * a + b : k * b + a]!;
    }
  }
  return { pat, K, active };
}
