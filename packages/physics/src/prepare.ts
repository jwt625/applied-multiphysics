// SPDX-License-Identifier: GPL-3.0-or-later
// prepareRun: amp-spec/0 model (+ optional eval case) -> C4 RunContext (validated spec, mesh at a level, resolved
// materials, study). L8 harness hook (DevLog-009 contract request 2; CONTRACTS-v0 changelog). Accepts the harness form
// prepareRun({case, spec, physicsId, level, hFactor, signal}) and the form prepareRun(spec, caseCtx).
// Mesh levels: hmax, refine.h and grading are all scaled by hFactor, so a level is a uniform refinement of the size
// field (scaling hmax alone leaves the graded region unrefined; DevLog-010 s.4.1).
// Materials: override values; `ref: materials/<id>` through @amp/materials; N/A values are filled from the eval case's
// `materials` block when it names the property (case values carry their source), else left out so the module reports
// the missing property. No property is defaulted.

import type { Mesh, RunContext, Spec, StudyNode } from '@amp/spec/types';
import { validateSpec, resolveParams, resolveQuantity } from '@amp/spec';
import { meshFromSpec } from '@amp/mesh/spec';
import { physicsRegistry } from './registrations.ts';
import { cylinderTetMesh } from './common/fixtures3d.ts';

const NEEDS: Record<string, string[]> = {
  heat: ['k', 'rho', 'cp'], elastic: ['E', 'nu', 'alpha'], electrostatics: ['eps_r'], magnetostatics: ['mu_r'],
  'em-modes': ['n', 'eps_r'], emw: ['eps_r', 'tan_delta', 'mu_r'], acoustics: ['c', 'rho'],
};
/** Case-file property names per spec property (the eval cases use 'c' for the specific heat in heat cases). */
const CASE_ALIAS: Record<string, Record<string, string[]>> = { heat: { cp: ['cp', 'c'] } };

export interface CaseCtx { case?: Record<string, unknown>; physicsId?: string; level?: number; hFactor?: number; signal?: AbortSignal; T?: number }
export interface PrepareArgs extends CaseCtx { spec: Record<string, unknown> }

let library: { getProperty(id: string, p: string, o?: { T?: number }): { value: number | Record<string, number> } } | null | undefined;
async function lib() {
  if (library !== undefined) return library;
  try { library = (await import('@amp/materials/node')).defaultLibrary(); } catch { library = null; }
  return library;
}

export interface Prepared extends RunContext { notes: string[] }

export async function prepareRun(a: PrepareArgs | Record<string, unknown>, b?: CaseCtx): Promise<Prepared> {
  // (spec, caseCtx) when a second argument is given or `a` is itself a spec; else the harness object form
  const args: PrepareArgs = b !== undefined || 'schema' in a ? { ...(b ?? {}), spec: a as Record<string, unknown> } : (a as PrepareArgs);
  const notes: string[] = [];
  const raw = structuredClone(args.spec) as Record<string, unknown>;
  const reg = physicsRegistry();
  const v = validateSpec(raw, reg);
  const errs = v.issues.filter((i) => i.severity !== 'notice');
  if (!v.ok || !v.spec) throw new Error(`spec invalid: ${errs.slice(0, 5).map((i) => `${i.dotted}: ${i.message}`).join('; ')}`);
  const spec = v.spec as Spec;
  const phys = spec.physics ?? [];
  const ph = args.physicsId ? phys.find((p) => p.id === args.physicsId) : phys[0];
  if (!ph) throw new Error(`no physics ${args.physicsId ?? ''} in spec`);
  const f = args.hFactor ?? 1;
  const mesh = buildMesh(raw, spec, ph.type, f, notes);
  for (const w of (mesh as Mesh & { warnings?: string[] }).warnings ?? []) notes.push(`mesh warning: ${w}`);
  const materials = await resolveMaterials(spec, ph.type, args.case, args.T, notes);
  const study = pickStudy(spec, ph.id, args.case);
  return {
    spec, physicsId: ph.id, mesh, materials, study, notes,
    progress: () => {}, signal: args.signal ?? new AbortController().signal,
  };
}

function scaleSpecMesh(raw: Record<string, unknown>, f: number): Record<string, unknown> {
  if (f === 1) return raw;
  const out = structuredClone(raw);
  const scope = resolveParams(out.params ?? {}).scope;
  const mb = (out.mesh ?? {}) as { size?: Record<string, unknown>; refine?: Array<{ h: unknown }> };
  const si = (q: unknown) => { const r = resolveQuantity(q, scope); if (r.na) throw new Error('mesh size is N/A'); return r.si; };
  if (mb.size?.hmax !== undefined) mb.size.hmax = { value: si(mb.size.hmax) * f, unit: 'm' };
  if (mb.size?.hmin !== undefined) mb.size.hmin = { value: si(mb.size.hmin) * f, unit: 'm' };
  // grading is dimensionless (size growth per unit distance): scaled so the whole size field shrinks by f
  mb.size = mb.size ?? {};
  mb.size.grading = si(mb.size.grading ?? 0.3) * f;
  for (const r of mb.refine ?? []) r.h = { value: si(r.h) * f, unit: 'm' };
  out.mesh = mb;
  return out;
}

function buildMesh(raw: Record<string, unknown>, spec: Spec, type: string, f: number, notes: string[]): Mesh {
  const g = spec.geometry as { dim: number; features: Array<{ type: string; settings?: Record<string, unknown> }> };
  const scaled = scaleSpecMesh(raw, f);
  if (f !== 1 && (raw.mesh as { size?: { grading?: unknown } } | undefined)?.size?.grading === undefined) notes.push('mesh grading: the @amp/mesh default 0.3 scaled by hFactor');
  if (type === 'emw' && g.dim === 3 && g.features.length === 1 && g.features[0]!.type === 'cylinder') {
    const s = g.features[0]!.settings!;
    const scope = resolveParams(spec.params ?? {}).scope;
    const si = (q: unknown) => { const r = resolveQuantity(q, scope); if (r.na) throw new Error('N/A geometry'); return r.si; };
    const hmax = si(((scaled.mesh as { size: { hmax: unknown } }).size.hmax));
    const base = (s.base as { value?: number[] } | undefined)?.value;
    if (s.axis !== 'z' || (base && (base[0] !== 0 || base[1] !== 0))) throw new Error('emw cylinder: wave 1 fixture needs axis z through the origin');
    notes.push('mesh: curved tet10 cylinder fixture (src/common/fixtures3d.ts), L3 tier-1 cylinder mesher is tet4 only');
    const id = (g.features[0] as { id?: string }).id ?? 'cav';
    return cylinderTetMesh({ radius: si(s.radius), height: si(s.height), h: hmax, cell: 'tet10', id, disk: 'rings', ...(base ? { z0: base[2] ?? 0 } : {}) });
  }
  const order: 1 | 2 = type === 'acoustics' ? 1 : 2;
  return meshFromSpec(scaled, { order });
}

async function resolveMaterials(spec: Spec, type: string, cs: Record<string, unknown> | undefined, T: number | undefined, notes: string[]) {
  const scope = resolveParams(spec.params ?? {}).scope;
  const out: Record<string, Record<string, number>> = {};
  const caseMats = (cs?.materials ?? {}) as Record<string, Record<string, unknown>>;
  const need = NEEDS[type] ?? [];
  const fromCase = (matId: string, prop: string): number | undefined => {
    const names = CASE_ALIAS[type]?.[prop] ?? [prop];
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
    const ov = (m.override ?? {}) as Record<string, unknown>;
    for (const [k, q] of Object.entries(ov)) {
      const r = resolveQuantity(q, scope);
      if (!r.na) { rec[k] = r.si; continue; }
      const c = fromCase(m.id, k);
      if (c !== undefined) { rec[k] = c; notes.push(`materials.${m.id}.${k}: N/A in the spec, ${c} from the eval case`); }
    }
    const ref = (m as { ref?: string }).ref;
    if (ref) {
      const id = ref.replace(/^materials\//, '');
      const L = await lib();
      for (const p of need) {
        if (p in rec) continue;
        try {
          const pv = L?.getProperty(id, p, T !== undefined ? { T } : {});
          if (pv && typeof pv.value === 'number') rec[p] = pv.value;
        } catch (e) { notes.push(`materials.${m.id} (${ref}).${p}: ${(e as Error).message.slice(0, 160)}`); }
      }
    }
    for (const p of need) if (!(p in rec)) { const c = fromCase(m.id, p); if (c !== undefined) { rec[p] = c; notes.push(`materials.${m.id}.${p}: from the eval case`); } }
    out[m.id] = rec;
  }
  return out;
}

function pickStudy(spec: Spec, physicsId: string, cs: Record<string, unknown> | undefined): StudyNode {
  const st = (spec.studies ?? []).filter((s) => !(s as { physics?: string[] }).physics || (s as { physics?: string[] }).physics!.includes(physicsId));
  const want = ((cs?.study as { type?: string } | undefined)?.type ?? '').replace('transient', 'time');
  const hit = st.find((s) => s.type === want) ?? st.find((s) => s.type !== 'parametric') ?? st[0];
  if (!hit) throw new Error(`no study for physics ${physicsId}`);
  return hit;
}
