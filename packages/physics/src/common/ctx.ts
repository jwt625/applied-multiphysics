// SPDX-License-Identifier: GPL-3.0-or-later
// RunContext helpers shared by the eigen modules (emw, acoustics): physics node lookup, per-cell material properties
// from ctx.materials through spec.materials[].select, BC selections by type, eigen study settings. Values come only
// from the spec / materials; a missing property is an error naming the material and property (no defaults).

import { resolveParams, resolveQuantity, type Spec } from '@amp/spec';
import type { Mesh, RunContext } from '@amp/spec/types';
import { nCells, selectEntities } from './mesh.ts';

type PhysNode = NonNullable<Spec['physics']>[number];

export function physicsNode(spec: Spec, id: string): PhysNode {
  const p = (spec.physics ?? []).find((x) => x.id === id);
  if (!p) throw new Error(`no physics '${id}' in the spec`);
  return p;
}

/** Per-cell values of the listed properties; cells outside the physics selection get NaN and mask 0. */
export function cellProps(ctx: RunContext, props: readonly string[]): { mask: Uint8Array; values: Record<string, Float64Array> } {
  const m = ctx.mesh, nc = nCells(m);
  const phys = physicsNode(ctx.spec, ctx.physicsId);
  const physDoms = new Set(selectEntities(m.entities, 'domains', phys.select));
  const owner = new Int32Array(m.entities.domains.length).fill(-1);
  const mats = ctx.spec.materials ?? [];
  mats.forEach((mat, k) => {
    for (const d of selectEntities(m.entities, 'domains', mat.select)) {
      if (owner[d]! >= 0) throw new Error(`domain ${m.entities.domains[d]!.id} selected by materials '${mats[owner[d]!]!.id}' and '${mat.id}'`);
      owner[d] = k;
    }
  });
  const values: Record<string, Float64Array> = {};
  for (const p of props) values[p] = new Float64Array(nc).fill(NaN);
  const mask = new Uint8Array(nc);
  for (let c = 0; c < nc; c++) {
    const d = m.cells.domain[c]!;
    if (!physDoms.has(d)) continue;
    const k = owner[d]!;
    if (k < 0) throw new Error(`domain ${m.entities.domains[d]!.id} has no material`);
    const id = mats[k]!.id;
    const rec = ctx.materials[id];
    if (!rec) throw new Error(`material '${id}' not resolved in ctx.materials`);
    for (const p of props) {
      const v = rec[p];
      if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`material '${id}' has no value for '${p}'`);
      values[p]![c] = v;
    }
    mask[c] = 1;
  }
  return { mask, values };
}

/** Optional property per cell (NaN where absent). */
export function optionalCellProp(ctx: RunContext, prop: string, mask: Uint8Array): Float64Array {
  const m = ctx.mesh, nc = nCells(m), out = new Float64Array(nc).fill(NaN);
  const mats = ctx.spec.materials ?? [];
  const domVal = new Float64Array(m.entities.domains.length).fill(NaN);
  for (const mat of mats) {
    const v = ctx.materials[mat.id]?.[prop];
    if (typeof v !== 'number') continue;
    for (const d of selectEntities(m.entities, 'domains', mat.select)) domVal[d] = v;
  }
  for (let c = 0; c < nc; c++) if (mask[c]) out[c] = domVal[m.cells.domain[c]!]!;
  return out;
}

export function bcSelections(spec: Spec, physicsId: string, type: string): string[] {
  const p = physicsNode(spec, physicsId);
  return (p.bcs ?? []).filter((b) => b.type === type).flatMap((b) => b.select);
}

export function bcTypes(spec: Spec, physicsId: string): string[] {
  return (physicsNode(spec, physicsId).bcs ?? []).map((b) => b.type);
}

/** Eigen study settings: nModes and optional shift (Hz, SI). */
export function eigenStudy(ctx: RunContext): { nModes: number; shiftHz: number | null } {
  const st = ctx.study;
  if (st.type !== 'eigen') throw new Error(`study '${st.id}' is '${st.type}', the module needs 'eigen'`);
  const s = (st.settings ?? {}) as { nModes?: number; shift?: unknown };
  if (!(typeof s.nModes === 'number' && s.nModes >= 1)) throw new Error('eigen study needs settings.nModes');
  let shiftHz: number | null = null;
  if (s.shift !== undefined) {
    const { scope } = resolveParams(ctx.spec.params);
    const r = resolveQuantity(s.shift, scope);
    if (r.na) throw new Error('eigen study shift is N/A');
    shiftHz = r.si;
  }
  return { nModes: s.nModes, shiftHz };
}

export const meshHasCells = (m: Mesh, types: readonly string[]): boolean => types.includes(m.cells.type);

/** Params scope of the spec (throws on param issues). */
export function specScope(spec: Spec) {
  const P = resolveParams(spec.params ?? {});
  if (P.issues.length) throw new Error(`params: ${P.issues.map((i) => i.message).join('; ')}`);
  return P.scope;
}

/** SI value of a spec quantity (throws on N/A). */
export function q(spec: Spec, v: unknown, what: string): number {
  const r = resolveQuantity(v, specScope(spec));
  if (r.na) throw new Error(`${what} is N/A`);
  return r.si;
}

/** SI values of a vector quantity ({value: [..], unit} or a list of scalar quantities). */
export function qVec(spec: Spec, v: unknown, what: string): number[] {
  if (Array.isArray(v)) return v.map((x, i) => q(spec, x, `${what}[${i}]`));
  if (v && typeof v === 'object' && Array.isArray((v as { value: unknown }).value)) {
    const o = v as { value: number[]; unit: string };
    return o.value.map((x, i) => q(spec, { value: x, unit: o.unit }, `${what}[${i}]`));
  }
  throw new Error(`${what}: not a vector quantity`);
}

export type BcLike = { id: string; type: string; select: string[]; settings?: Record<string, unknown> };
export function bcsOf(spec: Spec, physicsId: string): BcLike[] {
  return (physicsNode(spec, physicsId).bcs ?? []) as BcLike[];
}

// ------------------------------------------------------------------------------------------------- readiness (audit S4)

const isNA = (v: unknown): boolean => v === 'N/A' || (!!v && typeof v === 'object' && (v as { value?: unknown }).value === 'N/A');

export interface ReadinessNeeds {
  /** material properties the module needs on every material of the physics */
  props: string[];
  /** properties needed only when more than one material is present (e.g. acoustic density) */
  propsIfMulti?: string[];
  /** a time study needs physics settings.T0 */
  t0?: boolean;
  /** an eigen study needs settings.nModes */
  eigen?: boolean;
}

/**
 * Spec-level readiness reasons: N/A or absent material values (a `ref:` to materials/ defers the check to prepareRun),
 * N/A BC settings, a missing T0 for time studies, a missing nModes for eigen studies.
 */
export function specReadiness(spec: Spec, physicsId: string, needs: ReadinessNeeds): string[] {
  const out: string[] = [];
  const ph = physicsNode(spec, physicsId);
  const physSel = new Set(ph.select ?? []);
  const touches = (sel: readonly string[]) => sel.some((s) => [...physSel].some((p) => s === p || s.startsWith(`${p}#`) || p.startsWith(`${s}#`)));
  const mats = (spec.materials ?? []).filter((m) => touches(m.select));
  const props = [...needs.props, ...(mats.length > 1 ? needs.propsIfMulti ?? [] : [])];
  for (const m of mats) {
    const ov = (m.override ?? {}) as Record<string, unknown>;
    const ref = (m as { ref?: string }).ref;
    for (const p of props) {
      if (p in ov) { if (isNA(ov[p])) out.push(`materials.${m.id}.override.${p} is N/A`); }
      else if (!ref) out.push(`materials.${m.id} has no ${p} (no override and no materials/ ref)`);
    }
  }
  for (const b of (ph.bcs ?? []) as BcLike[]) for (const [k, v] of Object.entries(b.settings ?? {})) {
    if (isNA(v) || (Array.isArray(v) && v.some(isNA))) out.push(`physics.${physicsId}.bcs.${b.id}.settings.${k} is N/A`);
  }
  const studies = (spec.studies ?? []).filter((s) => !(s as { physics?: string[] }).physics || (s as { physics?: string[] }).physics!.includes(physicsId));
  if (needs.t0 && studies.some((s) => s.type === 'time')) {
    const T0 = ((ph as { settings?: { T0?: unknown } }).settings ?? {}).T0;
    if (T0 === undefined) out.push(`physics.${physicsId}.settings.T0 is required by the time study (initial temperature)`);
    else if (isNA(T0)) out.push(`physics.${physicsId}.settings.T0 is N/A`);
  }
  if (needs.eigen) for (const s of studies.filter((x) => x.type === 'eigen')) {
    const n = ((s as { settings?: { nModes?: unknown } }).settings ?? {}).nModes;
    if (!(typeof n === 'number' && n >= 1)) out.push(`study ${(s as { id: string }).id} needs settings.nModes >= 1`);
  }
  return out;
}
