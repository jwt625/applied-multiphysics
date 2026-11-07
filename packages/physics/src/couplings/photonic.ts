// SPDX-License-Identifier: GPL-3.0-or-later
// Photonic couplings of lane MO (C11, DevLog-032), sequential, into the 2D full-vector mode solver (em-modes):
//   thermo-optic   heat -> em-modes            nodal T, settings.Tref; dn/dT per material (property dndT, 1/K)
//   electro-optic  electrostatics -> em-modes  nodal V of one terminal solve (1 V) or of the applied potentials;
//                                              Pockels tensor per material (property r_eo, m/V, crystal frame)
// The map functions only carry the upstream nodal field (same study mesh) and the settings; em-modes
// (modes/coupled.ts) evaluates T and E = -grad V at its quadrature points, builds the permittivity change and reports
// dneff, dphidz, Ppi (thermo-optic) and dneffdV, VpiL (electro-optic). Conventions: modes/coupled.ts header.

import * as z from 'zod';
import { quantity, type Registration } from '@amp/spec';
import type { CouplingNode, Solution } from '@amp/spec/types';
import { NPC, nCells, nNodes, cellMask } from '../common/mesh.ts';
import { physicsNode, q as qty } from '../common/ctx.ts';
import type { CouplingImpl } from './core.ts';

/** The last step of a nodal field (or the stationary one). */
function nodalField(up: Solution, name: string, nn: number, what: string, step?: number): { data: Float64Array; space: string; stepped: boolean } {
  const all = up.fields.filter((f) => f.name === name);
  if (!all.length) throw new Error(`${what}: upstream solution has no field '${name}'`);
  const f = step !== undefined ? all.find((x) => (x.step ?? 0) === step) : all.reduce((a, b) => ((b.step ?? -1) > (a.step ?? -1) ? b : a));
  if (!f) throw new Error(`${what}: upstream field '${name}' has no step ${step}`);
  if ((f.space !== 'H1P1' && f.space !== 'H1P2') || f.components !== 1 || f.data.length !== nn) throw new Error(`${what}: field '${name}' is not nodal on the study mesh`);
  return { data: f.data, space: f.space, stepped: all.length > 1 };
}

/** Nodes of the cells of a physics selection. */
function nodesOf(m: Parameters<typeof nCells>[0], select: string[]): Uint8Array {
  const k = NPC[m.cells.type], nc = nCells(m), inside = cellMask(m, select), out = new Uint8Array(nNodes(m));
  for (let c = 0; c < nc; c++) if (inside[c]) for (let a = 0; a < k; a++) out[m.cells.conn[k * c + a]!] = 1;
  return out;
}

const settingsOf = (node: CouplingNode) => (node.settings ?? {}) as Record<string, unknown>;

const thermoOptic: CouplingImpl = {
  type: 'thermo-optic', from: 'heat', to: 'em-modes', kind: 'sequential',
  map({ up, upId, down, node }) {
    const what = `thermo-optic '${node.id}'`;
    const m = down.mesh, nn = nNodes(m);
    const s = settingsOf(node);
    if (s.Tref === undefined) throw new Error(`${what}: settings.Tref is required`);
    const Tref = qty(down.spec, s.Tref, `couplings.${node.id}.settings.Tref`);
    const f = nodalField(up, 'T', nn, what);
    // nodes outside the heat domain carry no temperature: Tref there (no index change)
    const inHeat = nodesOf(m, physicsNode(down.spec, upId).select ?? []);
    const T = Float64Array.from(f.data, (v, i) => (inHeat[i] ? v : Tref));
    const cells = cellMask(m, physicsNode(down.spec, upId).select ?? []);
    const notes: string[] = [];
    if (f.stepped) notes.push(`${what}: the heat solution has several steps; the last one is used`);
    const data: Record<string, unknown> = { T, space: f.space, Tref, cells, notes };
    if (s.power !== undefined) { data.power = qty(down.spec, s.power, `couplings.${node.id}.settings.power`); data.powerSource = `couplings.${node.id}.settings.power`; }
    if (s.crystals !== undefined) data.crystals = s.crystals;
    return { coupling: node.id, from: upId, kind: 'thermo-optic', data };
  },
};

const electroOptic: CouplingImpl = {
  type: 'electro-optic', from: 'electrostatics', to: 'em-modes', kind: 'sequential',
  map({ up, upId, down, node }) {
    const what = `electro-optic '${node.id}'`;
    const m = down.mesh, nn = nNodes(m);
    const s = settingsOf(node);
    const armB = s.armB as 'none' | 'mirror' | 'ideal' | undefined;
    if (armB !== 'none' && armB !== 'mirror' && armB !== 'ideal') throw new Error(`${what}: settings.armB is required (none | mirror | ideal): the push-pull convention is stated, never assumed`);
    const data: Record<string, unknown> = { armB, direct: s.direct !== false };
    if (armB === 'mirror') {
      if (s.mirrorX === undefined) throw new Error(`${what}: armB mirror needs settings.mirrorX (x of the mirror line, the signal centre)`);
      data.mirrorX = qty(down.spec, s.mirrorX, `couplings.${node.id}.settings.mirrorX`);
    }
    const es = physicsNode(down.spec, upId);
    data.cells = cellMask(m, es.select ?? []);
    if (s.terminal !== undefined) {
      const terms = (es.bcs ?? []).filter((b) => b.type === 'terminal').map((b) => b.id);
      const i = terms.indexOf(String(s.terminal));
      if (i < 0) throw new Error(`${what}: settings.terminal '${String(s.terminal)}' is not a terminal condition of '${upId}' (${terms.join(', ') || 'none'})`);
      if (s.voltage !== undefined) throw new Error(`${what}: settings.voltage applies to the applied-potential solve only; a terminal solve is 1 V by definition`);
      const f = nodalField(up, 'V', nn, what, i);
      Object.assign(data, { V: f.data, space: f.space, Vt: 1, VtSource: `terminal '${String(s.terminal)}' at 1 V, other terminals and ground at 0 V` });
    } else {
      const f = nodalField(up, 'V_applied', nn, what);
      let Vt: number, src: string;
      if (s.voltage !== undefined) { Vt = qty(down.spec, s.voltage, `couplings.${node.id}.settings.voltage`); src = `couplings.${node.id}.settings.voltage`; }
      else {
        const inside = nodesOf(m, es.select ?? []);
        let lo = Infinity, hi = -Infinity;
        for (let i = 0; i < nn; i++) if (inside[i]) { lo = Math.min(lo, f.data[i]!); hi = Math.max(hi, f.data[i]!); }
        Vt = hi - lo; src = `max(V) - min(V) of the applied potentials (${hi} V, ${lo} V)`;
      }
      if (!(Vt > 0)) throw new Error(`${what}: terminal voltage V_t = ${Vt} V must be > 0`);
      Object.assign(data, { V: f.data, space: f.space, Vt, VtSource: src });
    }
    if (s.crystals !== undefined) data.crystals = s.crystals;
    return { coupling: node.id, from: upId, kind: 'electro-optic', data };
  },
};

export const PHOTONIC_COUPLINGS: CouplingImpl[] = [thermoOptic, electroOptic];

const AXES = ['x', 'y', 'z', '+x', '+y', '+z', '-x', '-y', '-z'] as const;
/** Crystal orientation per material: film normal (cut) = lab y, propagation = lab z, optional rotation about z. */
export const crystalsSchema = z.array(z.strictObject({
  material: z.string().min(1),
  cut: z.enum(AXES),
  propagation: z.enum(AXES),
  rotation: quantity('1').optional(),
}).meta({ description: 'Crystal axes of a material: cut = crystal axis along the film normal (lab y), propagation = crystal axis along lab z; rotation = CCW rotation of the lab frame about z (angle with unit, e.g. "10 deg"; a bare number is radians)' })).min(1);

const own = { owner: '@amp/physics' } as const;
export const PHOTONIC_REGISTRATIONS: Registration[] = [
  { kind: 'coupling', type: 'thermo-optic', ...own, for: ['heat', 'em-modes'],
    description: 'Thermo-optic index change n + dn/dT (T - Tref) of the heat temperature in the mode solver; dneff, phase per length, Ppi (with the heater power per length)',
    settings: z.strictObject({
      Tref: quantity('K', { ge: 0 }).meta({ description: 'temperature at which the material indices n hold (no index change)' }),
      power: quantity('W/m', { gt: 0 }).optional().meta({ description: 'heat input per unit length of the 2D heat solution; enables Ppi = lambda P / (2 |dneff|)' }),
      crystals: crystalsSchema.optional(),
    }) },
  { kind: 'coupling', type: 'electro-optic', ...own, for: ['electrostatics', 'em-modes'],
    description: 'Linear Pockels effect of the electrostatic field in the mode solver: dneff/dV (first order, with a direct re-solve check) and VpiL in a stated push-pull convention',
    settings: z.strictObject({
      armB: z.enum(['none', 'mirror', 'ideal']).meta({ description: 'second MZM arm: none = single-arm drive; mirror = mirror image of this arm about x = mirrorX (field-resolved); ideal = dn_B = -dn_A' }),
      mirrorX: quantity('m').optional(),
      terminal: z.string().min(1).optional().meta({ description: 'electrostatics terminal condition id: its 1 V solve gives E per volt; absent = the applied-potential solve. The electrostatics physics must have exactly one terminal condition (several terminals give one solve per terminal, which the coupling cannot use)' }),
      voltage: quantity('V', { gt: 0 }).optional().meta({ description: 'terminal voltage V_t of the applied-potential solve (default max(V) - min(V))' }),
      direct: z.boolean().optional().meta({ description: 'also compute dneff/dV by two direct re-solves (default true)' }),
      crystals: crystalsSchema.optional(),
    }) },
];

/** Material properties the photonic couplings need on the downstream (em-modes) materials (for COUPLING_NEEDS, MC). */
export const PHOTONIC_NEEDS: Record<string, { to?: string[]; from?: string[] }> = {
  'thermo-optic': { to: ['dndT'] },
  // electro-optic: r_eo only on electro-optic materials (absent = no linear EO effect); checked at run time
};
