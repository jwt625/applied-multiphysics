// SPDX-License-Identifier: GPL-3.0-or-later
// em-modes with photonic coupled inputs (C11, lane MO, DevLog-032): thermo-optic (heat -> em-modes) and electro-optic
// (electrostatics -> em-modes, linear Pockels effect). Runs only when RunContext.inputs holds such an input; the plain
// em-modes path (modes/index.ts) is unchanged otherwise.
//
// Frames and conventions (eo-modulator-atlas eo-overlap E2 conventions, kept):
//   lab x lateral, y film normal (up), z propagation; crystal axes 1,2,3 = x,y,z, c = z; v_lab = A v_crystal
//   (modes/crystal.mjs labFromCrystal(cut, propagation, rotation)).
//   Thermo-optic: n_i(T) = n_i + (dn/dT)_i (T - Tref) along each principal (crystal) axis; isotropic materials have
//   one n and one dn/dT. Direct: eps = A diag(n_i(T)^2) A^T per triangle (triangle mean of T - Tref).
//   First order: d eps = A diag(2 n_i (dn/dT)_i dT) A^T at each of the 6 quadrature points of the kernel.
//   Pockels: delta(1/eps)_I = r_Ij E_j (crystal frame, Voigt I = xx, yy, zz, yz, xz, xy), d eps = -eps d(1/eps) eps
//   (lab); E = -grad V of the electrostatics solution, V/m per volt of the terminal voltage V_t.
//   V_t: 1 V for a terminal solve; max(V) - min(V) of the applied-potential solve unless settings.voltage gives it.
//   Arm phase: phi = k0 n_eff L. Arm A = the waveguide of this em-modes physics. MZM phase difference
//   delta_phi = k0 L (dn_A - dn_B) per volt; V_pi L = lambda / (2 |dn_A/dV - dn_B/dV|), DC, lossless.
//   armB: 'none' -> dn_B = 0 (single-arm drive); 'mirror' -> arm B is the mirror image of arm A about x = mirrorX,
//   dn_B = overlap of the arm-A mode with M dEps(E(2 x0 - x, y)) M, M = diag(-1, 1, 1) (field-resolved; needs mirror
//   symmetric optical tensors, checked); 'ideal' -> dn_B = -dn_A (idealised, labelled).
//   d eps_xz, d eps_yz: no first-order contribution for a lossless mode (E_z in quadrature with E_t); dropped in the
//   direct re-solve (the kernel takes eps_xz = eps_yz = 0), a second-order effect.
// Outputs (scalars per mode k; unprefixed copies for mode 0): see RESULT_NAMES_COUPLED.

import type { CoupledInput, Mesh, RunContext, Solution, Spec } from '@amp/spec/types';
import { resolveQuantity, resolveParams } from '@amp/spec';
import { TRI_Q4 } from '@amp/core/fem/quadrature';
import { vectorPerturbation } from './vector-mode.mjs';
import { labFromCrystal, pockelsVoigt, deltaEpsLab, mat3, type Mat3 } from './crystal.mjs';
import { NPC, nCells, nNodes, selectEntities } from '../common/mesh.ts';
import { scalar } from '../common/solution.ts';
import type { ModesProblem, ModesOutput } from './index.ts';

export const PHOTONIC_KINDS = ['thermo-optic', 'electro-optic'] as const;
const UM = 1e6;
const NQ = TRI_Q4.length;

/** Result names added to the em-modes solution by the coupled path (k = mode index). */
export const RESULT_NAMES_COUPLED = {
  thermo: ['neff0_<k>', 'dneff_<k>', 'dneffPert_<k>', 'dphidz_<k>', 'Ppi_<k>', 'dneff', 'dphidz', 'Ppi'],
  eo: ['dneffdV_<k>', 'dneffdVdirect_<k>', 'dneffdVB_<k>', 'VpiL_<k>', 'VpiLsingle_<k>', 'dneffdV', 'VpiL'],
};

// ------------------------------------------------------------------------------------------------- crystals, optics

export interface CrystalSpec { material: string; cut: string; propagation: string; rotation?: unknown }
export interface Crystal { A: Mat3; rotDeg: number }

type Props = Record<string, number>;

/** Merge crystal definitions (physics settings, coupling settings); one definition per material. */
export function mergeCrystals(spec: Spec, lists: Array<{ from: string; list: unknown }>): Map<string, Crystal> {
  const out = new Map<string, Crystal & { key: string; from: string }>();
  const { scope } = resolveParams(spec.params ?? {});
  for (const { from, list } of lists) {
    if (list === undefined) continue;
    if (!Array.isArray(list)) throw new Error(`${from}: crystals must be a list`);
    for (const c of list as CrystalSpec[]) {
      let rotDeg = 0;
      if (c.rotation !== undefined) {
        const r = resolveQuantity(c.rotation, scope);
        if (r.na) throw new Error(`${from}: crystal rotation of '${c.material}' is N/A`);
        rotDeg = (r.si * 180) / Math.PI;
      }
      const key = `${c.cut}|${c.propagation}|${rotDeg}`;
      const prev = out.get(c.material);
      if (prev && prev.key !== key) throw new Error(`crystal orientation of material '${c.material}' differs between ${prev.from} and ${from}`);
      out.set(c.material, { A: labFromCrystal(c.cut, c.propagation, rotDeg), rotDeg, key, from });
    }
  }
  return out;
}

/** Principal-axis optics of one material: indices along crystal x, y, z and the lab rotation (identity if isotropic). */
export interface MatOptics { id: string; n: [number, number, number]; A: Mat3; aniso: boolean; props: Props }

export function materialOptics(id: string, props: Props, crystals: Map<string, Crystal>): MatOptics | null {
  const iso = (n: number): MatOptics => ({ id, n: [n, n, n], A: mat3.identity(), aniso: false, props });
  if (props.n !== undefined && Number.isFinite(props.n)) return iso(props.n);
  const po = props['n.perp'], pe = props['n.par'];
  if (po !== undefined && pe !== undefined) {
    const c = crystals.get(id);
    if (!c) throw new Error(`em-modes: material '${id}' has a uniaxial index (n.perp, n.par) but no crystal orientation (settings.crystals: [{material: ${id}, cut, propagation}])`);
    return { id, n: [po, po, pe], A: c.A, aniso: true, props };
  }
  if (props.eps_r !== undefined && Number.isFinite(props.eps_r) && props.eps_r > 0) return iso(Math.sqrt(props.eps_r));
  return null;
}

/** Lab tensor A diag(d) A^T as kernel [xx, xy, yy, zz]; throws when xz / yz are not zero (kernel limitation). */
export function kernelTensor(A: Mat3, d: [number, number, number], what: string): [number, number, number, number] {
  const T = mat3.mul(mat3.mul(A, mat3.diag(d[0], d[1], d[2])), mat3.T(A));
  const big = Math.max(Math.abs(d[0]), Math.abs(d[1]), Math.abs(d[2]), 1e-300);
  if (Math.abs(T[2]!) > 1e-12 * big || Math.abs(T[5]!) > 1e-12 * big) throw new Error(`em-modes: ${what} has eps_xz / eps_yz components in the lab frame; the mode solver supports tensors with the propagation axis as a principal axis only`);
  return [T[0]!, 0.5 * (T[1]! + T[3]!), T[4]!, T[8]!];
}

/** Optics per domain index of the mesh (null where no material is assigned). */
export function domainOptics(spec: Spec, mesh: Mesh, materials: Record<string, Props>, crystals: Map<string, Crystal>): Array<MatOptics | null> {
  const out: Array<MatOptics | null> = new Array(mesh.entities.domains.length).fill(null);
  for (const m of spec.materials ?? []) {
    const props = materials[m.id];
    if (!props) continue;
    const o = materialOptics(m.id, props, crystals);
    if (!o) continue;
    for (const d of selectEntities(mesh.entities, 'domains', m.select)) out[d] = o;
  }
  return out;
}

// ------------------------------------------------------------------------------------------------- sampling

interface TriGeo { x: [number, number, number]; y: [number, number, number]; g: [number, number, number, number, number, number]; area: number }

function triGeo(mesh: Mesh, c: number): TriGeo {
  const k = NPC[mesh.cells.type];
  const v = [mesh.cells.conn[k * c]!, mesh.cells.conn[k * c + 1]!, mesh.cells.conn[k * c + 2]!];
  const x = v.map((i) => mesh.nodes[2 * i]!) as [number, number, number];
  const y = v.map((i) => mesh.nodes[2 * i + 1]!) as [number, number, number];
  const d = (x[1] - x[0]) * (y[2] - y[0]) - (x[2] - x[0]) * (y[1] - y[0]);
  // grad L_i = (y_j - y_k, x_k - x_j) / d (i, j, k cyclic)
  const g: TriGeo['g'] = [(y[1] - y[2]) / d, (x[2] - x[1]) / d, (y[2] - y[0]) / d, (x[0] - x[2]) / d, (y[0] - y[1]) / d, (x[1] - x[0]) / d];
  return { x, y, g, area: Math.abs(d) / 2 };
}

/** Value and gradient of a nodal field (P1 on vertices, or P2 with tri6 order v0 v1 v2 m01 m12 m20) at barycentric L. */
function evalNodal(mesh: Mesh, data: Float64Array, p2: boolean, c: number, G: TriGeo, L: ArrayLike<number>, out: number[]): void {
  const k = NPC[mesh.cells.type];
  const conn = mesh.cells.conn;
  const gx = (i: number) => G.g[2 * i]!, gy = (i: number) => G.g[2 * i + 1]!;
  let v = 0, dx = 0, dy = 0;
  if (!p2) {
    for (let i = 0; i < 3; i++) { const u = data[conn[k * c + i]!]!; v += u * L[i]!; dx += u * gx(i); dy += u * gy(i); }
  } else {
    for (let i = 0; i < 3; i++) {
      const u = data[conn[k * c + i]!]!, li = L[i]!;
      v += u * li * (2 * li - 1); dx += u * (4 * li - 1) * gx(i); dy += u * (4 * li - 1) * gy(i);
    }
    const E = [[0, 1], [1, 2], [2, 0]] as const;
    for (let e = 0; e < 3; e++) {
      const u = data[conn[k * c + 3 + e]!]!, [a, b] = E[e]!, la = L[a]!, lb = L[b]!;
      v += u * 4 * la * lb; dx += u * 4 * (lb * gx(a) + la * gx(b)); dy += u * 4 * (lb * gy(a) + la * gy(b));
    }
  }
  out[0] = v; out[1] = dx; out[2] = dy;
}

/** Value and gradient [v, dv/dx, dv/dy] of a nodal field at barycentric L of cell c (exported for tests). */
export function sampleNodal(mesh: Mesh, data: Float64Array, space: string, c: number, L: ArrayLike<number>): number[] {
  const out = [0, 0, 0];
  evalNodal(mesh, data, isP2(mesh, space, data.length), c, triGeo(mesh, c), L, out);
  return out;
}

function isP2(mesh: Mesh, space: string, n: number): boolean {
  if (n !== nNodes(mesh)) throw new Error(`coupled field has ${n} values, the study mesh ${nNodes(mesh)} nodes (not the same mesh)`);
  if (space === 'H1P2') { if (mesh.cells.type !== 'tri6') throw new Error('H1P2 field on a mesh without tri6 cells'); return true; }
  if (space === 'H1P1') return false;
  throw new Error(`coupled field space ${space}: nodal H1P1 / H1P2 expected`);
}

/** Uniform-grid point locator over the mesh triangles (straight). */
class Locator {
  private readonly mesh: Mesh;
  private readonly cells: Int32Array[];
  private readonly x0: number; private readonly y0: number; private readonly hx: number; private readonly hy: number; private readonly n: number;
  constructor(mesh: Mesh) {
    this.mesh = mesh;
    const nc = nCells(mesh), nn = nNodes(mesh);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < nn; i++) { const x = mesh.nodes[2 * i]!, y = mesh.nodes[2 * i + 1]!; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    this.n = Math.max(1, Math.ceil(Math.sqrt(nc / 2)));
    this.x0 = x0; this.y0 = y0; this.hx = (x1 - x0) / this.n || 1; this.hy = (y1 - y0) / this.n || 1;
    const lists: number[][] = Array.from({ length: this.n * this.n }, () => []);
    for (let c = 0; c < nc; c++) {
      const G = triGeo(mesh, c);
      const [i0, j0] = this.cell(Math.min(...G.x), Math.min(...G.y)), [i1, j1] = this.cell(Math.max(...G.x), Math.max(...G.y));
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) lists[j * this.n + i]!.push(c);
    }
    this.cells = lists.map((l) => Int32Array.from(l));
  }
  private cell(x: number, y: number): [number, number] {
    const cl = (v: number) => Math.min(this.n - 1, Math.max(0, Math.floor(v)));
    return [cl((x - this.x0) / this.hx), cl((y - this.y0) / this.hy)];
  }
  /** Cell containing (x, y) and its barycentrics, or null. */
  find(x: number, y: number): { c: number; L: [number, number, number]; G: TriGeo } | null {
    const [i, j] = this.cell(x, y);
    let best: { c: number; L: [number, number, number]; G: TriGeo; m: number } | null = null;
    for (const c of this.cells[j * this.n + i]!) {
      const G = triGeo(this.mesh, c);
      const L: [number, number, number] = [0, 0, 0];
      for (let a = 0; a < 3; a++) {
        const b = (a + 1) % 3;
        L[a] = G.g[2 * a]! * (x - G.x[b]!) + G.g[2 * a + 1]! * (y - G.y[b]!);
      }
      const m = Math.min(...L);
      if (!best || m > best.m) best = { c, L, G, m };
      if (m >= 0) break;
    }
    return best && best.m > -1e-9 ? best : null;
  }
}

// ------------------------------------------------------------------------------------------------- coupled run

interface ThermoData { T: Float64Array; space: string; Tref: number; cells?: Uint8Array; power?: number; powerSource?: string; crystals?: unknown; notes?: string[] }
interface EoData {
  V: Float64Array; space: string; Vt: number; VtSource: string; cells?: Uint8Array; armB: 'none' | 'mirror' | 'ideal'; mirrorX?: number;
  direct: boolean; crystals?: unknown; notes?: string[];
}

export function photonicInputs(ctx: RunContext): CoupledInput[] {
  return (ctx.inputs ?? []).filter((i) => (PHOTONIC_KINDS as readonly string[]).includes(i.kind));
}

/** Crystal definitions of the physics settings and of every photonic input. */
export function crystalsOf(ctx: RunContext): Map<string, Crystal> {
  const ph = (ctx.spec.physics ?? []).find((p) => p.id === ctx.physicsId) as { settings?: { crystals?: unknown } } | undefined;
  return mergeCrystals(ctx.spec, [
    { from: `physics '${ctx.physicsId}' settings`, list: ph?.settings?.crystals },
    ...photonicInputs(ctx).map((i) => ({ from: `coupling '${i.coupling}' settings`, list: (i.data as { crystals?: unknown }).crystals })),
  ]);
}

type SolveFn = (p: ModesProblem) => Promise<ModesOutput>;

/**
 * Coupled em-modes run. `base` is the problem from the materials alone (problemFromContext with the merged crystals);
 * `solve` is solveModes (passed in to avoid an import cycle).
 */
export async function runCoupledModes(ctx: RunContext, base: ModesProblem, solve: SolveFn): Promise<Solution> {
  const inputs = (ctx.inputs ?? []);
  const other = inputs.filter((i) => !(PHOTONIC_KINDS as readonly string[]).includes(i.kind));
  if (other.length) throw new Error(`em-modes: coupled inputs of kind ${other.map((i) => i.kind).join(', ')} are not supported (thermo-optic, electro-optic)`);
  const thermo = inputs.filter((i) => i.kind === 'thermo-optic');
  const eo = inputs.filter((i) => i.kind === 'electro-optic');
  if (eo.length > 1) throw new Error('em-modes: at most one electro-optic coupling per mode physics');
  const mesh = ctx.mesh, nT = nCells(mesh);
  const notes: string[] = [];
  const crystals = crystalsOf(ctx);
  const optics = domainOptics(ctx.spec, mesh, ctx.materials, crystals);
  const active = base.cellMask;
  const live = (c: number) => (active ? active[c] === 1 : true);
  const lamUm = base.wavelength * UM;
  const k0 = (2 * Math.PI) / base.wavelength;   // 1/m

  // base permittivity per triangle (as the plain path builds it from the domain tensors)
  const eps0 = new Float64Array(4 * nT);
  for (let c = 0; c < nT; c++) {
    const e = base.eps[mesh.cells.domain[c]!]!;
    eps0.set(typeof e === 'number' ? [e, 0, e, e] : e, 4 * c);
  }
  const geos: TriGeo[] = Array.from({ length: nT }, (_, c) => triGeo(mesh, c));

  // ---- thermo-optic: per triangle direct eps and per quadrature point first-order d eps
  let epsT: Float64Array | null = null;
  let dEpsTq: Float64Array | null = null;
  let power: { value: number; source: string } | null = null;
  if (thermo.length) {
    epsT = Float64Array.from(eps0);
    dEpsTq = new Float64Array(4 * NQ * nT);
    const dT = new Float64Array(NQ * nT);
    for (const inp of thermo) {
      const d = inp.data as unknown as ThermoData;
      const p2 = isP2(mesh, d.space, d.T.length);
      const tmp = [0, 0, 0];
      for (let c = 0; c < nT; c++) {
        if (!live(c) || (d.cells && !d.cells[c])) continue;   // no temperature outside the heat domain
        for (let q = 0; q < NQ; q++) { evalNodal(mesh, d.T, p2, c, geos[c]!, TRI_Q4[q]!, tmp); dT[NQ * c + q]! += tmp[0]! - d.Tref; }
      }
      if (d.power !== undefined) {
        if (power) throw new Error('em-modes: heater power given by more than one thermo-optic coupling');
        power = { value: d.power, source: d.powerSource ?? `coupling '${inp.coupling}'` };
      }
      if (Array.isArray(d.notes)) notes.push(...d.notes.map(String));
    }
    const missing = new Set<string>();
    for (let c = 0; c < nT; c++) {
      if (!live(c)) continue;
      let mean = 0, any = false;
      for (let q = 0; q < NQ; q++) { const v = dT[NQ * c + q]!; mean += TRI_Q4[q]![3]! * v; if (v !== 0) any = true; }
      if (!any) continue;
      const o = optics[mesh.cells.domain[c]!];
      if (!o) throw new Error(`em-modes: domain ${mesh.entities.domains[mesh.cells.domain[c]!]!.id} has no optical material`);
      const dn = dndtOf(o);
      if (!dn) { missing.add(o.id); continue; }
      const nT_ = [0, 1, 2].map((i) => o.n[i]! + dn[i]! * mean) as [number, number, number];
      epsT.set(kernelTensor(o.A, [nT_[0] ** 2, nT_[1] ** 2, nT_[2] ** 2], `material '${o.id}'`), 4 * c);
      for (let q = 0; q < NQ; q++) {
        const v = dT[NQ * c + q]!;
        dEpsTq.set(kernelTensor(o.A, [2 * o.n[0] * dn[0]! * v, 2 * o.n[1] * dn[1]! * v, 2 * o.n[2] * dn[2]! * v], `material '${o.id}'`), 4 * (NQ * c + q));
      }
    }
    if (missing.size) throw new Error(`thermo-optic: material(s) ${[...missing].join(', ')} have no dndT (property dndT, 1/K) where the temperature differs from Tref`);
  }

  // ---- solves: base (only when perturbed by heat), final (with fields)
  const out0 = thermo.length ? await solve({ ...base, fields: false }) : null;
  const fin = await solve({ ...base, ...(epsT ? { epsTri: epsT } : {}), ...(out0 ? { model: out0.model } : {}) });
  const model = fin.model;
  const modes = fin.result.modes as any[];
  const sol = fin.solution;
  const S = sol.scalars;
  const put = (name: string, k: number, v: number, unit: string) => { S[`${name}_${k}`] = scalar(v, unit); if (k === 0) S[name] = scalar(v, unit); };

  if (thermo.length && out0) {
    const m0 = out0.result.modes as any[];
    if (m0.length !== modes.length) notes.push(`thermo-optic: ${m0.length} unheated vs ${modes.length} heated modes; shifts reported for the common count`);
    for (let k = 0; k < modes.length; k++) {
      const b = modes[k], j = matchMode(m0, b);
      if (j < 0) { notes.push(`thermo-optic: heated mode ${k} (TE fraction ${b.teFraction.toFixed(3)}) has no unheated partner; no shift reported`); continue; }
      if (j !== k) notes.push(`thermo-optic: heated mode ${k} matches unheated mode ${j} (order changed)`);
      const a = m0[j];
      const dn = b.neff - a.neff;
      S[`neff0_${k}`] = scalar(a.neff, '1');
      put('dneff', k, dn, '1');
      S[`dneffPert_${k}`] = scalar(vectorPerturbation(out0.model, a, dEpsTq!, lamUm), '1');
      put('dphidz', k, k0 * dn, 'rad/m');
      if (power && dn !== 0) put('Ppi', k, (base.wavelength * power.value) / (2 * Math.abs(dn)), 'W');
    }
    notes.push(power
      ? `thermo-optic: Ppi = lambda P' / (2 |dneff|) with heat input P' = ${power.value} W/m (${power.source}, as given: not checked against the heat solution); assumes T - Tref proportional to P' (linear heat problem, ambient at Tref), a uniform heater along the length and no thermal crosstalk into the other MZM arm`
      : 'thermo-optic: no heater power per length given (coupling settings.power): Ppi not reported');
  }

  // ---- electro-optic
  if (eo.length) {
    const inp = eo[0]!;
    const d = inp.data as unknown as EoData;
    if (Array.isArray(d.notes)) notes.push(...d.notes.map(String));
    const p2 = isP2(mesh, d.space, d.V.length);
    const used = new Set<string>();
    const rOf = new Map<string, Float64Array | null>();
    const pockels = (o: MatOptics): Float64Array | null => {
      if (!rOf.has(o.id)) {
        const c = ['r13', 'r22', 'r33', 'r51'].map((x) => o.props[`r_eo.${x}`]);
        if (c.every((v) => v === undefined)) rOf.set(o.id, null);
        else {
          if (!crystals.has(o.id)) throw new Error(`electro-optic: material '${o.id}' has r_eo but no crystal orientation (settings.crystals)`);
          rOf.set(o.id, pockelsVoigt({ r13: c[0]!, r22: c[1]!, r33: c[2]!, r51: c[3]! }));
        }
      }
      return rOf.get(o.id)!;
    };
    const epsLab = (o: MatOptics): Mat3 => uniaxialLabDiag(o);
    /** kernel-ordered d eps per volt at a point with lab field E (V/m per volt) in material o; mirror flips xy */
    const dEpsAt = (o: MatOptics, E: number[], flip: boolean): [number, number, number, number] | null => {
      const r = pockels(o);
      if (!r) return null;
      used.add(o.id);
      const t = deltaEpsLab(r, crystals.get(o.id)!.A, epsLab(o), E);
      return [t[0]!, (flip ? -1 : 1) * 0.5 * (t[1]! + t[3]!), t[4]!, t[8]!];
    };
    const dA = new Float64Array(4 * NQ * nT);
    const tmp = [0, 0, 0];
    const xyq = (c: number, q: number): [number, number] => {
      const G = geos[c]!, L = TRI_Q4[q]!;
      return [L[0]! * G.x[0] + L[1]! * G.x[1] + L[2]! * G.x[2], L[0]! * G.y[0] + L[1]! * G.y[1] + L[2]! * G.y[2]];
    };
    const inEs = (c: number) => !d.cells || d.cells[c] === 1;   // no static field outside the electrostatics domain
    for (let c = 0; c < nT; c++) {
      if (!live(c) || !inEs(c)) continue;
      const o = optics[mesh.cells.domain[c]!];
      if (!o || !pockels(o)) continue;
      for (let q = 0; q < NQ; q++) {
        evalNodal(mesh, d.V, p2, c, geos[c]!, TRI_Q4[q]!, tmp);
        const v = dEpsAt(o, [-tmp[1]! / d.Vt, -tmp[2]! / d.Vt, 0], false);
        if (v) dA.set(v, 4 * (NQ * c + q));
      }
    }
    if (!used.size) throw new Error(`electro-optic '${inp.coupling}': no material with an r_eo tensor in the domains of '${ctx.physicsId}'`);
    notes.push(`electro-optic: Pockels materials ${[...used].join(', ')}; other materials have no r_eo (no linear EO effect); V_t = ${d.Vt} V (${d.VtSource})`);
    // arm B (mirror image about x = mirrorX)
    let dB: Float64Array | null = null;
    if (d.armB === 'mirror') {
      for (const o of optics) if (o && Math.abs(kernelTensor(o.A, [o.n[0] ** 2, o.n[1] ** 2, o.n[2] ** 2], `material '${o.id}'`)[1]) > 1e-12 * o.n[0] ** 2) throw new Error(`electro-optic armB mirror: material '${o.id}' has an in-plane eps_xy (rotated crystal): the mirrored arm is not the mirror image of arm A`);
      const loc = new Locator(mesh);
      dB = new Float64Array(4 * NQ * nT);
      let miss = 0, other = 0;
      for (let c = 0; c < nT; c++) {
        if (!live(c) || !inEs(c)) continue;
        const oA = optics[mesh.cells.domain[c]!];
        if (!oA || !pockels(oA)) continue;
        for (let q = 0; q < NQ; q++) {
          const [x, y] = xyq(c, q);
          const hit = loc.find(2 * d.mirrorX! - x, y);
          if (!hit) { miss++; continue; }
          const oB = optics[mesh.cells.domain[hit.c]!];
          if (oB !== oA || !inEs(hit.c)) { other++; continue; }   // geometry not mirror symmetric here
          evalNodal(mesh, d.V, p2, hit.c, hit.G, hit.L, tmp);
          const v = dEpsAt(oB, [-tmp[1]! / d.Vt, -tmp[2]! / d.Vt, 0], true);
          if (v) dB.set(v, 4 * (NQ * c + q));
        }
      }
      if (miss) throw new Error(`electro-optic armB mirror: ${miss} mirrored quadrature points fall outside the mesh (mirrorX wrong?)`);
      if (other) throw new Error(`electro-optic armB mirror: ${other} mirrored quadrature points of Pockels cells lie in another material: arm B is not the mirror image of arm A about x = ${d.mirrorX} m`);
      if (thermo.length) notes.push('electro-optic armB mirror with a thermo-optic input: arm B is taken as the mirror image of the heated arm A (same temperature field mirrored); thermal crosstalk asymmetry is not modelled');
    }
    const dnA = modes.map((m) => vectorPerturbation(model, m, dA, lamUm));
    // direct check: central difference at +-Vp, triangle means of d eps per volt; Vp gives |dneff| = 1e-5 for the
    // most sensitive mode at first order (numerical choice)
    const amax = Math.max(0, ...dnA.map(Math.abs));
    if (d.direct && !(amax > 0)) notes.push('electro-optic: first-order dneff/dV is 0 for every mode: direct check skipped');
    if (d.direct && amax > 0) {
      const dTri = new Float64Array(4 * nT);
      for (let c = 0; c < nT; c++) for (let q = 0; q < NQ; q++) for (let j = 0; j < 4; j++) {
        dTri[4 * c + j]! += TRI_Q4[q]![3]! * dA[4 * (NQ * c + q) + j]!;
      }
      const epsBase = epsT ?? eps0;
      const Vp = 1e-5 / amax;
      const sp = Float64Array.from(epsBase, (v, i) => v + Vp * dTri[i]!), sm = Float64Array.from(epsBase, (v, i) => v - Vp * dTri[i]!);
      const rp = (await solve({ ...base, epsTri: sp, model, fields: false })).result.modes as any[];
      const rm = (await solve({ ...base, epsTri: sm, model, fields: false })).result.modes as any[];
      for (let k = 0; k < modes.length; k++) {
        const jp = matchMode(rp, modes[k]), jm = matchMode(rm, modes[k]);
        if (jp < 0 || jm < 0) { notes.push(`electro-optic: mode ${k} not found in the +-Vp re-solves (direct check skipped for it)`); continue; }
        S[`dneffdVdirect_${k}`] = scalar((rp[jp].neff - rm[jm].neff) / (2 * Vp), '1/V');
      }
      notes.push(`electro-optic: direct check = central difference of two re-solves at +-${Vp.toPrecision(4)} V (first-order |dneff| = 1e-5 for the most sensitive mode, numerical choice), triangle-mean d eps, modes matched by TE fraction and n_eff; first order uses d eps at the 6 quadrature points`);
    }
    for (let k = 0; k < modes.length; k++) {
      const a = dnA[k]!;
      put('dneffdV', k, a, '1/V');
      let b = 0;
      if (dB) b = vectorPerturbation(model, modes[k], dB, lamUm);
      else if (d.armB === 'ideal') b = -a;
      if (d.armB !== 'none') S[`dneffdVB_${k}`] = scalar(b, '1/V');
      // no differential phase (|dn_A - dn_B| at round-off of |dn|): VpiL undefined, not reported
      if (Math.abs(a - b) > 1e-9 * Math.max(Math.abs(a), Math.abs(b))) put('VpiL', k, base.wavelength / (2 * Math.abs(a - b)), 'V*m');
      else notes.push(`electro-optic: mode ${k}: dn_A/dV = dn_B/dV (no differential phase), VpiL not defined`);
      if (a !== 0) S[`VpiLsingle_${k}`] = scalar(base.wavelength / (2 * Math.abs(a)), 'V*m');
    }
    notes.push(`electro-optic: VpiL = lambda / (2 |dn_A/dV - dn_B/dV|), V = full terminal voltage V_t; arm B: ${d.armB === 'none' ? 'none (single-arm drive)' : d.armB === 'ideal' ? 'ideal push-pull dn_B = -dn_A (idealised)' : `mirror image of arm A about x = ${d.mirrorX} m, field-resolved`}; VpiLsingle = lambda / (2 |dn_A/dV|)`);
  }
  const ext = sol as Solution & { notes?: string[] };
  ext.notes = [...(ext.notes ?? []), ...notes];
  return sol;
}

/**
 * Index of the mode of `list` matching `m`: same polarisation family (|TE fraction difference| <= 0.1), nearest n_eff;
 * -1 when none. Used between solves that differ by a small permittivity perturbation.
 */
function matchMode(list: any[], m: any): number {
  let best = -1, dist = Infinity;
  list.forEach((x, j) => {
    if (Math.abs(x.teFraction - m.teFraction) > 0.1) return;
    const dd = Math.abs(x.neff - m.neff);
    if (dd < dist) { dist = dd; best = j; }
  });
  return best;
}

function dndtOf(o: MatOptics): [number, number, number] | null {
  const p = o.props;
  if (p.dndT !== undefined && Number.isFinite(p.dndT)) return [p.dndT, p.dndT, p.dndT];
  if (p['dndT.perp'] !== undefined && p['dndT.par'] !== undefined) return [p['dndT.perp'], p['dndT.perp'], p['dndT.par']];
  return null;
}

function uniaxialLabDiag(o: MatOptics): Mat3 {
  // principal values along crystal x, y, z (perp, perp, par for uniaxial; equal for isotropic)
  return mat3.mul(mat3.mul(o.A, mat3.diag(o.n[0] ** 2, o.n[1] ** 2, o.n[2] ** 2)), mat3.T(o.A));
}

