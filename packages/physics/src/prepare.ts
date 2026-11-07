// SPDX-License-Identifier: GPL-3.0-or-later
// prepareRun: amp-spec/0 model (+ optional eval case) -> C4 RunContext (validated spec, mesh at a level, resolved
// materials, study). L8 harness hook (DevLog-009 contract request 2; CONTRACTS-v0 changelog). Accepts the harness form
// prepareRun({case, spec, physicsId, level, hFactor, signal, library}) and the form prepareRun(spec, caseCtx).
// Mesh levels (Follow-up 2): hFactor = 2^-k gives a NESTED sequence: the hFactor = 1 mesh refined k times by
// @amp/mesh refineUniform (new boundary nodes on the exact curves / cylinder), so Richardson sees a fixed refinement
// ratio 2. Other hFactors re-mesh with hmax, hmin, refine.h and grading scaled by hFactor (non-nested; noted).
// Materials: override values; `ref: materials/<id>` through an injected library (`library`, the @amp/materials Library
// shape; in Node the default library is loaded lazily when none is given); N/A values are filled from the eval
// case's `materials` block when it names the property, and written into the returned spec (notes say so). No property
// is defaulted. The context carries `timing` (validate, geometry_mesh, materials, ms) and `notes`.

import type { Mesh, RunContext, Spec, StudyNode } from '@amp/spec/types';
import { validateSpec, resolveParams, resolveQuantity } from '@amp/spec';
import { meshFromSpec } from '@amp/mesh/spec';
import { refineUniform, meshCylinder, cylinderSideProjector } from '@amp/mesh';
import { makeResolver, geometryFromSpec } from '@amp/geom/spec';
import { physicsRegistry } from './registrations.ts';
import { boxMesh } from './common/mesh.ts';
import { hexToTet10 } from './elastic/hex2tet.ts';
import { COUPLING_NEEDS } from './couplings/index.ts';

const NEEDS: Record<string, string[]> = {
  heat: ['k', 'rho', 'cp'], elastic: ['E', 'nu', 'alpha'], electrostatics: ['eps_r'], magnetostatics: ['mu_r'],
  'em-modes': ['n', 'eps_r'], emw: ['eps_r', 'tan_delta', 'mu_r'], 'emw-axisym': ['eps_r', 'mu_r'], acoustics: ['c', 'rho'],
  currents: ['sigma'],
};
/** Case-file property names per spec property (the eval cases use 'c' for the specific heat in heat cases). */
const CASE_ALIAS: Record<string, Record<string, string[]>> = { heat: { cp: ['cp', 'c'] } };

/** The part of the @amp/materials Library that prepareRun uses (inject it in the browser). */
export interface MaterialLibrary { getProperty(id: string, prop: string, o?: { T?: number; lambda?: number }): { value: number | Record<string, number> } }

export interface CaseCtx {
  case?: Record<string, unknown>; physicsId?: string; level?: number; hFactor?: number; signal?: AbortSignal;
  /** time-step factor of this level (L8 convergence.dt_with_h: hFactor^(space_order / time_order)) */
  dtFactor?: number;
  /** temperature for T-dependent material tables (K) */
  T?: number;
  library?: MaterialLibrary | null;
  /** study to prepare (default: the first study of the physics, or the eval case's study type) */
  studyId?: string;
}
export interface PrepareArgs extends CaseCtx { spec: Record<string, unknown> }
export interface Prepared extends RunContext { notes: string[]; timing: Record<string, number> }

let nodeLibrary: MaterialLibrary | null | undefined;
async function defaultLibrary(): Promise<MaterialLibrary | null> {
  if (nodeLibrary !== undefined) return nodeLibrary;
  const isNode = typeof (globalThis as { process?: { versions?: { node?: string } } }).process?.versions?.node === 'string';
  if (!isNode) return (nodeLibrary = null);
  try {
    const spec = '@amp/materials/node';   // not a static import: browsers inject `library` instead
    nodeLibrary = (await import(/* @vite-ignore */ spec)).defaultLibrary() as MaterialLibrary;
  } catch { nodeLibrary = null; }
  return nodeLibrary;
}

export async function prepareRun(a: PrepareArgs | Record<string, unknown>, b?: CaseCtx): Promise<Prepared> {
  // (spec, caseCtx) when a second argument is given or `a` is itself a spec; else the harness object form
  const args: PrepareArgs = b !== undefined || 'schema' in a ? { ...(b ?? {}), spec: a as Record<string, unknown> } : (a as PrepareArgs);
  const notes: string[] = [];
  const timing: Record<string, number> = {};
  const tick = <T>(k: string, f: () => T): T => { const t0 = performance.now(); try { return f(); } finally { timing[k] = (timing[k] ?? 0) + performance.now() - t0; } };
  const raw = structuredClone(args.spec) as Record<string, unknown>;
  const v = tick('validate', () => validateSpec(raw, physicsRegistry()));
  const errs = v.issues.filter((i) => i.severity !== 'notice');
  if (!v.ok || !v.spec) throw new Error(`spec invalid: ${errs.slice(0, 5).map((i) => `${i.dotted}: ${i.message}`).join('; ')}`);
  const spec = structuredClone(v.spec) as Spec;
  const phys = spec.physics ?? [];
  const ph = args.physicsId ? phys.find((p) => p.id === args.physicsId) : phys[0];
  if (!ph) throw new Error(`no physics ${args.physicsId ?? ''} in spec`);
  const f = args.hFactor ?? 1;
  let study = pickStudy(spec, ph.id, args.case, args.studyId);
  // hex8 -> tet10 split only when the selected study solves an elastic physics (audit FE item 8, DevLog-031 s.9)
  const listed = (study as { physics?: string[] }).physics;
  const elasticInStudy = listed?.length ? listed.some((pid) => phys.find((p) => p.id === pid)?.type === 'elastic') : ph.type === 'elastic';
  const mesh = tick('geometry_mesh', () => levelMesh(raw, spec, ph.type, f, notes, elasticInStudy));
  for (const w of (mesh as Mesh & { warnings?: string[] }).warnings ?? []) notes.push(`mesh warning: ${w}`);
  const lib = args.library !== undefined ? args.library : await defaultLibrary();
  // materials for every physics the study solves (multiphysics, C11). The property list of a single physics without
  // couplings is unchanged, but a mode study evaluates library n and dndT at its wavelength (MatContext.lambda), so
  // wavelength-dependent library values can differ from the earlier lambda-free evaluation
  const types = [ph.type];
  for (const pid of (study as { physics?: string[] }).physics ?? []) {
    const t = phys.find((p) => p.id === pid)?.type;
    if (t && !types.includes(t)) types.push(t);
  }
  const t0 = performance.now();
  const mctx = couplingMaterialContext(spec, study, scopeOf(spec));
  // elastic mass density only where a mass matrix is assembled (eigen study, acoustic-structure group; DevLog-031 MT R4b):
  // a stationary single-physics elastic run resolves exactly as before
  const fsi = ((spec as { couplings?: Array<{ type: string; to: string }> }).couplings ?? []).some((c) => c.type === 'acoustic-structure' && ((study as { physics?: string[] }).physics ?? []).includes(c.to));
  if (types.includes('elastic') && (study.type === 'eigen' || fsi) && !mctx.props.includes('rho')) mctx.props.push('rho');
  const materials = resolveMaterials(spec, types, args.case, args.T, lib, notes, mctx);
  timing.materials = performance.now() - t0;
  if (args.dtFactor !== undefined && args.dtFactor !== 1 && study.type === 'time') study = scaleDt(spec, study, args.dtFactor, notes);
  return {
    spec, physicsId: ph.id, mesh, materials, study, notes, timing,
    progress: () => {}, signal: args.signal ?? new AbortController().signal,
  };
}

// ------------------------------------------------------------------------------------------------------ meshes

function scaleSpecMesh(raw: Record<string, unknown>, f: number): Record<string, unknown> {
  if (f === 1) return raw;
  const out = structuredClone(raw);
  const scope = resolveParams(out.params ?? {}).scope;
  const mb = (out.mesh ?? {}) as { size?: Record<string, unknown>; refine?: Array<{ h: unknown }> };
  const si = (q: unknown) => { const r = resolveQuantity(q, scope); if (r.na) throw new Error('mesh size is N/A'); return r.si; };
  if (mb.size?.hmax !== undefined) mb.size.hmax = { value: si(mb.size.hmax) * f, unit: 'm' };
  if (mb.size?.hmin !== undefined) mb.size.hmin = { value: si(mb.size.hmin) * f, unit: 'm' };
  // grading is a size growth per unit distance: scaled so the whole size field shrinks by f (DevLog-010 s.3, 16:12)
  mb.size = mb.size ?? {};
  if (mb.size.grading !== undefined) mb.size.grading = si(mb.size.grading) * f;
  for (const r of mb.refine ?? []) r.h = { value: si(r.h) * f, unit: 'm' };
  out.mesh = mb;
  return out;
}

const chains = new Map<string, { meshes: Mesh[]; refine: (m: Mesh) => Mesh }>();
const lastHash = new Map<string, { hash: string; f: number }>();
const MAX_CHAINS = 8;

function baseMesh(raw: Record<string, unknown>, spec: Spec, type: string, notes: string[], elastic: boolean): { m: Mesh; refine: (m: Mesh) => Mesh } {
  const ph = (spec.physics ?? []).find((p) => p.type === type) as { settings?: { order?: 1 | 2 } } | undefined;
  // element order: settings.order of acoustics / emw / em-modes (default 2); heat, elastic, statics: P2
  const order: 1 | 2 = ph?.settings?.order ?? 2;
  const scope = resolveParams(spec.params ?? {}).scope;
  const R = makeResolver(scope);
  const G = geometryFromSpec(spec.geometry as Parameters<typeof geometryFromSpec>[0], R);
  if (G.dim === 3 && G.solids.length === 1 && G.solids[0]!.type === 'box' && order === 2) {
    // P2 on a structured Kuhn-split tet10 box (common/mesh.ts boxMesh; @amp/mesh meshes boxes as hex8 only)
    const s = G.solids[0]!;
    const hmax = R.q(((raw.mesh ?? {}) as { size?: { hmax?: unknown } }).size?.hmax);
    const n = (r: [number, number]) => Math.max(1, Math.ceil((r[1] - r[0]) / hmax - 1e-9));
    // the Kuhn split of the doubled grid is a nested refinement of the Kuhn split (every fine tet lies in one coarse
    // tet; checked 2026-11-06, DevLog-010 s.9), and building it directly is about 100x cheaper than refineUniform
    let nn = [n(s.x), n(s.y), n(s.z)];
    const mk = () => boxMesh({ x: s.x, y: s.y, z: s.z, nx: nn[0]!, ny: nn[1]!, nz: nn[2]!, cell: 'tet10', id: s.id });
    const m = mk();
    notes.push('mesh: tet10 Kuhn box (packages/physics common/mesh.ts boxMesh), nested levels by doubling the grid');
    return { m, refine: () => { nn = nn.map((v) => 2 * v); return mk(); } };
  }
  if (G.dim === 3 && G.solids.length === 1 && G.solids[0]!.type === 'cylinder') {
    const c = G.solids[0]!;
    const hmax = R.q(((raw.mesh ?? {}) as { size?: { hmax?: unknown } }).size?.hmax);
    const m = meshCylinder(c, { mesh2d: { hmax }, dz: hmax, cell: 'tet4', order });
    return { m, refine: (x) => refineUniform(x, { project: cylinderSideProjector(x, c) }) };
  }
  const m0 = meshFromSpec(raw, { order });
  // elasticity on box-union grids: hex8 split into conforming tet10 (trilinear hexes lock in bending; lane MT R7, DevLog-033)
  const toTets = G.dim === 3 && m0.cells.type === 'hex8' && elastic;
  const m = toTets ? hexToTet10(m0) : m0;
  if (toTets) notes.push('mesh: hex8 box grid split into tet10 for elasticity (elastic/hex2tet.ts; trilinear hexes lock in bending)');
  if (G.dim === 2) return { m, refine: (x) => refineUniform(x, { geometry: G.geometry }) };
  notes.push(`mesh: ${m.cells.type} levels are re-meshed (refineUniform supports simplices only)`);
  return { m, refine: () => { throw new Error('no nested refinement for this cell type'); } };
}

function levelMesh(raw: Record<string, unknown>, spec: Spec, type: string, f: number, notes: string[], elastic: boolean): Mesh {
  const k = Math.round(-Math.log2(f));
  const nested = k >= 0 && Math.abs(2 ** -k - f) <= 1e-12 * f;
  const feats = (spec.geometry as { features: Array<{ type: string }> }).features;
  const ord = ((spec.physics ?? []).find((p) => p.type === type) as { settings?: { order?: number } } | undefined)?.settings?.order ?? 2;
  const simplexOk = (spec.geometry as { dim: number }).dim === 2 || (feats.length === 1 && (feats[0]!.type === 'cylinder' || (feats[0]!.type === 'box' && ord === 2)));
  if (nested && simplexOk) {
    const key = JSON.stringify({ g: raw.geometry, m: raw.mesh, p: raw.params, type, elastic });
    let entry = chains.get(key);
    if (!entry) {
      const bm = baseMesh(raw, spec, type, notes, elastic);
      entry = { meshes: [bm.m], refine: bm.refine };
      chains.set(key, entry);
      while (chains.size > MAX_CHAINS) chains.delete(chains.keys().next().value!);
    }
    const chain = entry.meshes;
    while (chain.length <= k) chain.push(entry.refine(chain[chain.length - 1]!));
    if (k > 0) notes.push(`mesh: level ${k} = ${k} nested uniform refinement(s) of the hFactor = 1 mesh`);
    return chain[k]!;
  }
  if (f !== 1) notes.push(`mesh: hFactor ${f} is not a power of 1/2 (or no nested refinement for this cell type): re-meshed with scaled sizes, levels are not nested`);
  const m = baseMesh(scaleSpecMesh(raw, f), spec, type, notes, elastic).m;
  // a level identical to the previous one is reported (L8 'no_change'; I1 bug report)
  const key = JSON.stringify({ g: raw.geometry, m: raw.mesh, p: raw.params, type, elastic });
  const prev = lastHash.get(key);
  if (prev && prev.hash === m.hash && prev.f !== f) notes.push(`mesh warning: hFactor ${f} gives the same mesh as hFactor ${prev.f} (hash ${m.hash.slice(0, 12)})`);
  lastHash.set(key, { hash: m.hash, f });
  return m;
}

// --------------------------------------------------------------------------------------------------- materials

const scopeOf = (spec: Spec) => resolveParams(spec.params ?? {}).scope;

/**
 * Property context of the study's couplings (DevLog-031 R1): the properties the couplings need (COUPLING_NEEDS, incl.
 * PHOTONIC_NEEDS), optional ones (r_eo with an electro-optic coupling: absent = not electro-optic, no note), the mode
 * study wavelength (library n and dndT are wavelength tables / fits) and the thermo-optic Tref (library dndT at T).
 */
interface MatContext { props: string[]; optional: string[]; lambda?: number; Tref?: number }
function couplingMaterialContext(spec: Spec, study: StudyNode, scope: ReturnType<typeof scopeOf>): MatContext {
  const inStudy = new Set((study as { physics?: string[] }).physics ?? []);
  const nodes = ((spec as { couplings?: Array<{ type: string; from: string; to: string; settings?: Record<string, unknown> }> }).couplings ?? []).filter((c) => inStudy.has(c.to));
  const ctx: MatContext = { props: [], optional: [] };
  for (const c of nodes) {
    const nd = COUPLING_NEEDS[c.type];
    for (const pr of [...(nd?.to ?? []), ...(nd?.from ?? [])]) if (!ctx.props.includes(pr)) ctx.props.push(pr);
    if (c.type === 'electro-optic' && !ctx.optional.includes('r_eo')) ctx.optional.push('r_eo');
    // piezoelectric (lane MT): library tensors where a material has them (absent = isotropic / non-piezo solid, no note)
    if (c.type === 'piezoelectric') for (const pr of ['C', 'e_piezo', 'rho']) if (!ctx.optional.includes(pr)) ctx.optional.push(pr);
    if (c.type === 'thermo-optic' && c.settings?.Tref !== undefined) { const r = resolveQuantity(c.settings.Tref, scope); if (!r.na) ctx.Tref = r.si; }
  }
  const wl = study.type === 'mode' ? (study.settings as { wavelength?: unknown } | undefined)?.wavelength : undefined;
  if (wl !== undefined) { const r = resolveQuantity(wl, scope); if (!r.na) ctx.lambda = r.si; }
  return ctx;
}

const isTensor = (v: unknown): v is { symmetry: string; unit?: string; components: Record<string, unknown> } =>
  !!v && typeof v === 'object' && 'symmetry' in v && 'components' in v;

function resolveMaterials(spec: Spec, types: string[], cs: Record<string, unknown> | undefined, T: number | undefined, lib: MaterialLibrary | null, notes: string[], mc: MatContext = { props: [], optional: [] }) {
  const scope = resolveParams(spec.params ?? {}).scope;
  const out: Record<string, Record<string, number>> = {};
  const caseMats = (cs?.materials ?? {}) as Record<string, Record<string, unknown>>;
  const need = [...new Set([...types.flatMap((t) => NEEDS[t] ?? []), ...mc.props, ...mc.optional])];
  const optional = new Set(mc.optional);
  /** library options per property: n and dndT at the mode wavelength, dndT at the thermo-optic Tref */
  const libOpts = (p: string): { T?: number; lambda?: number } => {
    const o: { T?: number; lambda?: number } = T !== undefined ? { T } : {};
    if ((p === 'n' || p === 'dndT') && mc.lambda !== undefined) o.lambda = mc.lambda;
    if (p === 'dndT' && mc.Tref !== undefined) o.T = mc.Tref;
    return o;
  };
  const has = (rec: Record<string, number>, p: string) => p in rec || Object.keys(rec).some((k) => k.startsWith(`${p}.`));
  const fromCase = (matId: string, prop: string): number | undefined => {
    const names = types.map((t) => CASE_ALIAS[t]?.[prop]).find((x) => x) ?? [prop];
    const direct = caseMats[matId];
    for (const nm of names) if (direct && typeof direct[nm] === 'number') return direct[nm] as number;
    for (const nm of names) {
      const hits = Object.values(caseMats).filter((m) => typeof m[nm] === 'number');
      if (hits.length === 1) return hits[0]![nm] as number;
    }
    return undefined;
  };
  for (const m of spec.materials ?? []) {
    const rec: Record<string, number> = {};
    const ov = ((m as { override?: Record<string, unknown> }).override ??= {});
    const fill = (k: string, c: number, why: string) => {
      rec[k] = c;
      ov[k] = { value: c, unit: unitOf(spec, k) ?? '1' };
      notes.push(`materials.${m.id}.${k}: ${why}, ${c} from the eval case (written into the prepared spec)`);
    };
    for (const [k, q] of Object.entries(ov)) {
      if (isTensor(q)) {
        // tensor override {symmetry, unit?, components}: rec['<prop>.<component>'] in SI (N/A components left out)
        for (const [c, x] of Object.entries(q.components)) {
          const r = resolveQuantity(typeof x === 'number' ? { value: x, unit: q.unit ?? '1' } : x, scope);
          if (!r.na) rec[`${k}.${c}`] = r.si;
        }
        continue;
      }
      const r = resolveQuantity(q, scope);
      if (!r.na) { rec[k] = r.si; continue; }
      const c = fromCase(m.id, k);
      if (c !== undefined) fill(k, c, 'N/A in the spec');
    }
    const ref = (m as { ref?: string }).ref;
    if (ref) {
      const id = ref.replace(/^materials\//, '');
      if (!lib) notes.push(`materials.${m.id}: no material library available for ${ref} (inject one with prepareRun({library}))`);
      for (const p of need) {
        if (has(rec, p) || !lib) continue;
        try {
          const pv = lib.getProperty(id, p, libOpts(p));
          if (typeof pv.value === 'number') rec[p] = pv.value;
          else for (const [c, v] of Object.entries(pv.value)) if (typeof v === 'number') rec[`${p}.${c}`] = v;   // tensor: '<prop>.<component>'
        } catch (e) { if (!optional.has(p)) notes.push(`materials.${m.id} (${ref}).${p}: ${(e as Error).message.slice(0, 160)}`); }
      }
    }
    for (const p of need) if (!(p in rec)) { const c = fromCase(m.id, p); if (c !== undefined) fill(p, c, 'not in the spec'); }
    out[m.id] = rec;
  }
  return out;
}

/** SI reference unit of a property from the registry (for the values written into the prepared spec). */
function unitOf(_spec: Spec, prop: string): string | undefined {
  return (physicsRegistry().get('property', prop) as { unit?: string } | undefined)?.unit;
}

function pickStudy(spec: Spec, physicsId: string, cs: Record<string, unknown> | undefined, studyId?: string): StudyNode {
  if (studyId !== undefined) {
    const s = (spec.studies ?? []).find((x) => x.id === studyId);
    if (!s) throw new Error(`no study '${studyId}' in spec`);
    return s;
  }
  const st = (spec.studies ?? []).filter((s) => !(s as { physics?: string[] }).physics || (s as { physics?: string[] }).physics!.includes(physicsId));
  const want = ((cs?.study as { type?: string } | undefined)?.type ?? '').replace('transient', 'time');
  const hit = st.find((s) => s.type === want) ?? st.find((s) => s.type !== 'parametric') ?? st[0];
  if (!hit) throw new Error(`no study for physics ${physicsId}`);
  return hit;
}

/** Time study with dt scaled by dtFactor, rounded so that (stop - start) / dt is an integer (the step count rounds). */
function scaleDt(spec: Spec, st: StudyNode, f: number, notes: string[]): StudyNode {
  const scope = resolveParams(spec.params ?? {}).scope;
  const set = (st.settings ?? {}) as { start: unknown; stop: unknown; dt: unknown };
  const si = (q: unknown) => { const r = resolveQuantity(q, scope); if (r.na) throw new Error('time study value is N/A'); return r.si; };
  const t0 = si(set.start), t1 = si(set.stop), dt = si(set.dt) * f;
  const n = Math.max(1, Math.round((t1 - t0) / dt));
  const dtR = (t1 - t0) / n;
  notes.push(`time: dt scaled by dtFactor ${f}: ${si(set.dt)} s -> ${dtR} s (${n} steps${Math.abs(dtR - dt) > 1e-12 * dt ? `, rounded from ${dt} s` : ''})`);
  return { ...st, settings: { ...(st.settings as Record<string, unknown>), dt: { value: dtR, unit: 's' } } } as StudyNode;
}
