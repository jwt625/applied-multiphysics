// SPDX-License-Identifier: GPL-3.0-or-later
// Coupling implementations of lane MC (C11, DevLog-031): the CouplingImpl interface, the sequential core couplings
//   joule-heating      currents -> heat     per-cell Q = cell mean of sigma |grad V|^2 (W/m^3), the currents 'Q' field
//   thermal-expansion  heat -> elastic      nodal T, alpha per elastic cell (material property 'alpha'), settings.Tref
// and their spec registrations (kind 'coupling', for [from type, to type]). The downstream modules read the mapped data
// from RunContext.inputs (heat: into its per-cell source Q; elastic: its `thermal` input).

import * as z from 'zod';
import { quantity, type Registration } from '@amp/spec';
import type { CoupledInput, CouplingNode, RunContext, Solution, Spec } from '@amp/spec/types';
import { nCells, nNodes, NPC, cellMask } from '../common/mesh.ts';
import { cellProps, physicsNode, q as qty } from '../common/ctx.ts';

export interface CouplingImpl {
  /** coupling type (spec `couplings[].type`) */
  type: string;
  /** physics types of `from` and `to` */
  from: string; to: string;
  kind: 'sequential' | 'monolithic';
  /** sequential: map the upstream solution to an input of the downstream run context */
  map?(a: { up: Solution; upId: string; down: RunContext; node: CouplingNode }): CoupledInput;
  /** monolithic: solve both physics as one system; fields should carry `physics` tags (untagged ones get node.from) */
  run?(a: { ctx: Record<string, RunContext>; node: CouplingNode }): Promise<Solution>;
  /** readiness reasons of the coupling itself (monolithic groups: replaces the single-module readiness of its physics) */
  readiness?(spec: Spec, node: CouplingNode): string[];
}

/** The last step of a field (or the stationary one) and whether the solution had several steps. */
function lastField(up: Solution, name: string): { data: Float64Array; space: string; components: number; stepped: boolean } {
  const all = up.fields.filter((f) => f.name === name);
  if (!all.length) throw new Error(`upstream solution has no field '${name}'`);
  const f = all.reduce((a, b) => ((b.step ?? -1) > (a.step ?? -1) ? b : a));
  return { data: f.data, space: f.space, components: f.components, stepped: all.length > 1 };
}

const jouleHeating: CouplingImpl = {
  type: 'joule-heating', from: 'currents', to: 'heat', kind: 'sequential',
  map({ up, upId, down, node }) {
    const f = lastField(up, 'Q');
    const nc = nCells(down.mesh);
    if (f.space !== 'DG0' || f.data.length !== nc) throw new Error(`joule-heating '${node.id}': currents field Q is not per cell on the study mesh`);
    // cells outside the currents domain carry NaN: no Joule heat there
    const Q = Float64Array.from(f.data, (v) => (Number.isFinite(v) ? v : 0));
    return { coupling: node.id, from: upId, kind: 'joule-heating', data: { Q } };
  },
};

const thermalExpansion: CouplingImpl = {
  type: 'thermal-expansion', from: 'heat', to: 'elastic', kind: 'sequential',
  map({ up, upId, down, node }) {
    const f = lastField(up, 'T');
    const m = down.mesh, nn = nNodes(m), nc = nCells(m);
    if ((f.space !== 'H1P1' && f.space !== 'H1P2') || f.components !== 1 || f.data.length !== nn) throw new Error(`thermal-expansion '${node.id}': heat field T is not nodal on the study mesh`);
    const s = (node.settings ?? {}) as { Tref?: unknown };
    if (s.Tref === undefined) throw new Error(`thermal-expansion '${node.id}': settings.Tref is required`);
    const Tref = qty(down.spec, s.Tref, `couplings.${node.id}.settings.Tref`);
    const { mask, values } = cellProps(down, ['alpha']);
    // thermal strain only where the heat physics computed a temperature (its domain selection)
    const heatSel = physicsNode(down.spec, upId).select ?? [];
    const inHeat = cellMask(m, heatSel);
    const alpha = Float64Array.from(values.alpha!, (v, c) => (mask[c] ? (inHeat[c] ? v : 0) : NaN));
    // nodal T for the elastic cells: nodes outside the heat domain take Tref (zero thermal strain)
    const k = NPC[m.cells.type];
    const heatNode = new Uint8Array(nn);
    for (let c = 0; c < nc; c++) if (inHeat[c]) for (let a = 0; a < k; a++) heatNode[m.cells.conn[k * c + a]!] = 1;
    const T = Float64Array.from(f.data, (v, i) => (heatNode[i] ? v : Tref));
    const notes: string[] = [];
    if (f.stepped) notes.push(`thermal-expansion '${node.id}': the heat solution has several steps; the last one is used`);
    let outside = 0; for (let c = 0; c < nc; c++) if (mask[c] && !inHeat[c]) outside++;
    if (outside) notes.push(`thermal-expansion '${node.id}': ${outside} elastic cells lie outside the heat domain; no thermal strain there`);
    return { coupling: node.id, from: upId, kind: 'thermal-expansion', data: { alpha, T, Tref, notes } };
  },
};

export const CORE_COUPLINGS: CouplingImpl[] = [jouleHeating, thermalExpansion];

const own = { owner: '@amp/physics' } as const;
export const CORE_REGISTRATIONS: Registration[] = [
  { kind: 'coupling', type: 'joule-heating', ...own, for: ['currents', 'heat'], description: 'Joule heat Q = J . E of the currents physics as a volume source of the heat physics (per cell)' },
  { kind: 'coupling', type: 'thermal-expansion', ...own, for: ['heat', 'elastic'], description: 'Thermal strain alpha (T - Tref) from the heat temperature in the elastic physics; alpha from the materials',
    settings: z.strictObject({ Tref: quantity('K', { ge: 0 }) }) },
];

/** Material properties a core coupling type needs on the materials of its `to` / `from` physics. */
export const CORE_NEEDS: Record<string, { to?: string[]; from?: string[] }> = {
  'thermal-expansion': { to: ['alpha'] },
  'joule-heating': { from: ['sigma'] },
};
