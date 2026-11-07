// SPDX-License-Identifier: GPL-3.0-or-later
// Lane MT gates (DevLog-033 s.4): solid modal, axisymmetric elasticity, piezoelectric, acoustic-structure; numbers vs
// closed forms / benchmark targets, with dof and wall time per run (Node). Writes logs/MT-gates-<ts>.jsonl.
// Run: nice -n 10 node --max-old-space-size=1536 packages/physics/gates/mt-gates.ts [--quick]
// Test inputs labelled "test numbers" are arbitrary coefficients, not material data.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as z from 'zod';
import { validateSpec, parseYaml, quantity } from '@amp/spec';
import { meshFromSpec } from '@amp/mesh/spec';
import { meshCylinder } from '@amp/mesh';
import type { Mesh, RunContext, Spec, Solution } from '@amp/spec/types';
import { boxMesh, rectTriMesh, nCells, nNodes } from '../src/common/mesh.ts';
import { solveElasticModes } from '../src/elastic/modal.ts';
import { solveElasticAxisym } from '../src/elastic/axisym.ts';
import { physicsRegistry, runStudy } from '../src/index.ts';
import { cantileverRoot, le11Spec } from './mt-common.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const quick = process.argv.includes('--quick');
const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7);
const want = (k: string) => !only || only.split(',').includes(k);
const rows: Record<string, unknown>[] = [];
const fill = (n: number, v: number) => new Float64Array(n).fill(v);
const rel = (a: number, b: number) => (a - b) / b;
function rec(r: Record<string, unknown>) { rows.push(r); console.log(JSON.stringify(r)); }
async function timed<T>(f: () => Promise<T>): Promise<[T, number]> { const t0 = performance.now(); const v = await f(); return [v, performance.now() - t0]; }

/** Registry with the registration changes requested from MC (DevLog-033 s.5): elastic 2d-axisym + model axisym; electrostatics 3d. */
function requestedRegistry() {
  const reg = physicsRegistry();
  const el = reg.get('physics', 'elastic')!;
  if (!el.dims?.includes('2d-axisym')) reg.register({ ...el, dims: ['2d', '2d-axisym', '3d'], settings: z.strictObject({ model: z.enum(['plane-stress', 'plane-strain', '3d', 'axisym']).optional(), thickness: quantity('m', { gt: 0 }).optional() }) }, { replace: true });
  const es = reg.get('physics', 'electrostatics')!;
  if (!es.dims?.includes('3d')) reg.register({ ...es, dims: ['2d', '2d-axisym', '3d'] }, { replace: true });
  return reg;
}

/**
 * sims/pzt4-cube.yaml with its material as explicit overrides: a `ref: materials/<id>` material is materialized from
 * the @amp/materials library (rho, C, e_piezo, eps_r, SI, with the library's symmetry), so the gates can edit the
 * tensors (C66 variant, +1 % sensitivity) and build the run context by hand. Returns the spec data and the density.
 */
async function pztCube(): Promise<{ raw: { mesh: { size: { hmax: unknown } }; materials: Array<{ id: string; ref?: string; override: Record<string, { symmetry: string; unit?: string; components: Record<string, number> }> }> }; rho: number }> {
  const raw = parseYaml(readFileSync(resolve(root, 'sims/pzt4-cube.yaml'), 'utf8')).data as Awaited<ReturnType<typeof pztCube>>['raw'];
  const m = raw.materials[0]!;
  if (m.ref) {
    const { defaultLibrary } = await import('@amp/materials/node');
    const lib = defaultLibrary(), id = m.ref.replace(/^materials\//, '');
    const ov: Record<string, unknown> = { ...(m.override ?? {}) };
    for (const [prop, unit] of [['C', 'Pa'], ['e_piezo', 'C/m^2'], ['eps_r', '1']] as const) if (!(prop in ov)) {
      const pv = lib.getProperty(id, prop);
      if (typeof pv.value === 'number' || !pv.symmetry) throw new Error(`pztCube: ${id}.${prop} is not a tensor in the library`);
      ov[prop] = { symmetry: pv.symmetry, unit, components: pv.value };
    }
    if (!('rho' in ov)) ov.rho = { value: lib.getProperty(id, 'rho').value as number, unit: 'kg/m^3' };
    delete m.ref;
    m.override = ov as typeof m.override;
    // the sim's provenance entry for the ref no longer resolves in this materialized copy
    const pv = (raw as unknown as { provenance?: { values?: Record<string, unknown> } }).provenance?.values;
    if (pv) for (const k of Object.keys(pv)) if (k === `materials.${m.id}.ref` || k.startsWith(`materials.${m.id}.ref.`)) delete pv[k];
  }
  const r = (m.override as unknown as { rho: { value: number; unit: string } }).rho;
  if (r.unit !== 'kg/m^3') throw new Error(`pztCube: rho unit ${r.unit}`);
  return { raw, rho: r.value };
}

const E = 1.0e11, nu = 0.25, rho = 5000;   // test numbers

// 1. cantilever 2D plane stress, L/h = 50, vs Euler-Bernoulli
if (want('modal')) {
  const L = 1, h = 0.02, m = rectTriMesh({ x: [0, L], y: [0, h], nx: 100, ny: 2, order: 2 }), nc = nCells(m);
  const [s, ms] = await timed(() => solveElasticModes({ mesh: m, model: 'plane-stress', E: fill(nc, E), nu: fill(nc, nu), rho: fill(nc, rho), bcs: [{ type: 'fixed', select: ['bnd:rect.left'] }], nModes: 3 }));
  for (let n = 1; n <= 3; n++) { const x = cantileverRoot(n), ref = (x * x * Math.sqrt((E * h ** 3 / 12) / (rho * h * L ** 4))) / (2 * Math.PI), f = s.scalars[`f_${n - 1}`]!.value; rec({ gate: 'modal-cantilever-2d', mode: n, f, ref, rel: rel(f, ref), dof: s.stats.dof, ms: Math.round(ms) }); }
}
// 2. 3D tet10 cantilever and free-free bar
if (want('modal')) {
  const L = 1, a = 0.05, m = boxMesh({ x: [0, L], y: [0, a], z: [0, a], nx: 40, ny: 2, nz: 2, cell: 'tet10' }), nc = nCells(m), nn = nNodes(m);
  const [s, ms] = await timed(() => solveElasticModes({ mesh: m, model: '3d', E: fill(nc, E), nu: fill(nc, nu), rho: fill(nc, rho), bcs: [{ type: 'fixed', select: ['bnd:box.xmin'] }], nModes: 2 }));
  const x = cantileverRoot(1), ref = (x * x * Math.sqrt((E * a ** 4 / 12) / (rho * a * a * L ** 4))) / (2 * Math.PI);
  rec({ gate: 'modal-cantilever-3d', f0: s.scalars.f_0!.value, f1: s.scalars.f_1!.value, ref, rel0: rel(s.scalars.f_0!.value, ref), rel1: rel(s.scalars.f_1!.value, ref), dof: s.stats.dof, ms: Math.round(ms) });
  const fAx = Math.sqrt(E / rho) / (2 * L);
  const [b, ms2] = await timed(() => solveElasticModes({ mesh: m, model: '3d', E: fill(nc, E), nu: fill(nc, nu), rho: fill(nc, rho), bcs: [], nModes: 4, shiftHz: fAx }));
  let best = 0, share = 0;
  b.fields.forEach((f, i) => { let ax = 0, all = 0; for (let v = 0; v < nn; v++) { ax += f.data[3 * v]! ** 2; all += f.data[3 * v]! ** 2 + f.data[3 * v + 1]! ** 2 + f.data[3 * v + 2]! ** 2; } if (ax / all > share) { share = ax / all; best = i; } });
  rec({ gate: 'modal-bar-axial-3d', f: b.scalars[`f_${best}`]!.value, ref: fAx, rel: rel(b.scalars[`f_${best}`]!.value, fAx), axialShare: share, dof: b.stats.dof, ms: Math.round(ms2) });
}
// 3. axisym vs 3D free cylinder
if (want('axisym')) {
  const R = 0.1, H = 0.3, ma = rectTriMesh({ x: [0, R], y: [0, H], nx: 8, ny: 24, order: 2, axisym: true }), nca = nCells(ma);
  const [sa, msa] = await timed(() => solveElasticModes({ mesh: ma, model: 'axisym', E: fill(nca, E), nu: fill(nca, nu), rho: fill(nca, rho), bcs: [], nModes: 3 }));
  const m3 = meshCylinder({ id: 'cyl', radius: R, height: H, base: [0, 0, 0], axis: 'z' }, { mesh2d: { hmax: quick ? 0.035 : 0.025 }, dz: quick ? 0.035 : 0.025, cell: 'tet4', order: 2 } as Parameters<typeof meshCylinder>[1]) as Mesh, nc3 = nCells(m3);
  for (const k of [1, 2]) {
    const fa = sa.scalars[`f_${k}`]!.value;
    const [s3, ms3] = await timed(() => solveElasticModes({ mesh: m3, model: '3d', E: fill(nc3, E), nu: fill(nc3, nu), rho: fill(nc3, rho), bcs: [], nModes: 4, shiftHz: fa }));
    const near = Object.values(s3.scalars).map((x) => x.value).reduce((p, c) => (Math.abs(c - fa) < Math.abs(p - fa) ? c : p));
    rec({ gate: 'modal-axisym-vs-3d', mode: k, fAxisym: fa, f3d: near, rel: rel(near, fa), dofAxisym: sa.stats.dof, msAxisym: Math.round(msa), dof3d: s3.stats.dof, ms3d: Math.round(ms3) });
  }
}
// 4. LE11 direct (thermal input set from T = r + z) and through runStudy (heat -> thermal-expansion -> axisym)
for (const hmax of want('le11') ? (quick ? [0.05] : [0.1, 0.05, 0.025]) : []) {
  const raw = le11Spec(hmax), m = meshFromSpec(raw, { order: 2 }) as Mesh, nc = nCells(m), nn = nNodes(m);
  const T = Float64Array.from({ length: nn }, (_, v) => 273.15 + m.nodes[2 * v]! + m.nodes[2 * v + 1]!);
  const [s, ms] = await timed(() => solveElasticAxisym({ mesh: m, model: 'axisym', E: fill(nc, 210e9), nu: fill(nc, 0.3), thermal: { alpha: fill(nc, 2.3e-4), T, Tref: 273.15 }, bcs: [{ type: 'roller', select: ['bnd:low.bottom'] }, { type: 'roller', select: ['bnd:top.e3'] }] }));
  let vA = -1; for (let v = 0; v < nn; v++) if (Math.hypot(m.nodes[2 * v]! - 1, m.nodes[2 * v + 1]!) < 1e-9) vA = v;
  const szz = s.fields.find((f) => f.name === 'szz')!.data[vA]!;
  const v = validateSpec(structuredClone(raw), requestedRegistry());
  const prep: RunContext = { spec: v.spec as Spec, physicsId: 'ht', mesh: m, materials: { steel: { E: 210e9, nu: 0.3, alpha: 2.3e-4, k: 1 } }, study: (v.spec as Spec).studies![0]!, progress: () => {}, signal: new AbortController().signal };
  const [c, msc] = await timed(() => runStudy(prep));
  const szzC = c.fields.find((f) => f.name === 'szz' && f.physics === 'solid')!.data[vA]!;
  rec({ gate: 'LE11-CP-02', hmax, szzA_direct_MPa: szz / 1e6, szzA_coupled_MPa: szzC / 1e6, ref_MPa: -105, rel: rel(szzC, -105e6), dof: s.stats.dof, msDirect: Math.round(ms), msCoupled: Math.round(msc) });
}
// 4b. lane MX's sims/nafems-le11.yaml through runStudy (registry with the requested elastic axisym registration)
if (want('le11')) {
  const raw = parseYaml(readFileSync(resolve(root, 'sims/nafems-le11.yaml'), 'utf8')).data as Record<string, unknown>;
  const v = validateSpec(structuredClone(raw), requestedRegistry());
  if (!v.ok || !v.spec) rec({ gate: 'LE11-sim-MX', error: v.issues.filter((i) => i.severity !== 'notice').map((i) => `${i.dotted}: ${i.message}`).slice(0, 4) });
  else {
    const spec = v.spec as Spec, m = meshFromSpec(raw, { order: 2 }) as Mesh, nn = nNodes(m);
    const prep: RunContext = { spec, physicsId: 'ht', mesh: m, materials: { steel: { E: 210e9, nu: 0.3, alpha: 2.3e-4, k: 1 } }, study: spec.studies![0]!, progress: () => {}, signal: new AbortController().signal };
    const [c, ms] = await timed(() => runStudy(prep));
    let vA = -1; for (let i = 0; i < nn; i++) if (Math.hypot(m.nodes[2 * i]! - 1, m.nodes[2 * i + 1]!) < 1e-6) vA = i;
    const szz = vA >= 0 ? c.fields.find((f) => f.name === 'szz' && f.physics === 'solid')!.data[vA]! : NaN;
    rec({ gate: 'LE11-sim-MX', szzA_MPa: szz / 1e6, ref_MPa: -105, rel: rel(szz, -105e6), nodeAtA: vA >= 0, dof: c.stats.dof, ms: Math.round(ms) });
  }
}
// 5. CP-06 PZT-4 cube (sims/pzt4-cube.yaml of lane MX, VM175 listing values), short and open circuit
if (want('cp06')) {
  const { raw: raw0, rho: rhoP } = await pztCube();
  const targets = { short: [66560, 88010], open: [81590, 93410] };
  for (const variant of ['6mm', '4mm'] as const) for (const nDiv of quick ? [4] : variant === '6mm' ? [4, 6, 8] : [8]) {
    const raw = structuredClone(raw0);
    raw.mesh.size.hmax = `L/${nDiv}`;
    // 6mm: C66 derived as (C11 - C12) / 2; 4mm: the listed C66 (3.0e10 Pa, VM175 listing, as materials/pzt-4)
    const C = raw.materials[0]!.override.C!;
    if (variant === '6mm') { C.symmetry = 'hexagonal-6mm'; delete C.components.C66; }
    else { C.symmetry = 'tetragonal-4mm'; C.components.C66 ??= 3.0e10; }
    for (const t of ['e_piezo']) raw.materials[0]!.override[t]!.symmetry = variant === '6mm' ? 'hexagonal-6mm' : 'tetragonal-4mm';
    const v = validateSpec(structuredClone(raw), requestedRegistry());
    if (!v.ok || !v.spec) { rec({ gate: 'CP-06', variant, error: v.issues.filter((i) => i.severity !== 'notice').map((i) => `${i.dotted}: ${i.message}`).slice(0, 4) }); continue; }
    const spec = v.spec as Spec;
    const mesh = boxMesh({ x: [0, 0.01], y: [0, 0.01], z: [0, 0.02], nx: nDiv, ny: nDiv, nz: 2 * nDiv, cell: 'tet10', id: 'cube' });
    const spectra: Record<string, number[]> = {};
    const vTop: number[] = [];
    let dof = 0, msAll = 0;
    for (const kind of ['short', 'open'] as const) {
      // MX's study ids (sims/pzt4-cube.yaml): the eigen study whose physics list holds es_sc (short) or es_oc (open)
      const study = spec.studies!.find((s) => s.physics.includes(kind === 'short' ? 'es_sc' : 'es_oc'))!;
      const prep: RunContext = { spec, physicsId: 'solid', mesh, materials: { pzt4: { rho: rhoP } }, study, progress: () => {}, signal: new AbortController().signal };
      const [sol, ms] = await timed(() => runStudy(prep, { studyId: study.id }));
      spectra[kind] = Array.from((sol as Solution).steps!.values);
      if (kind === 'open') spectra.open!.forEach((_, k) => { const key = Object.keys(sol.scalars).find((x) => x.endsWith(`V_top_oc_${k}`)); vTop.push(key ? sol.scalars[key]!.value : NaN); });
      dof = sol.stats.dof; msAll += ms;
    }
    // electrically active modes: the open-circuit modes with a floating-electrode potential (|V_top| > 1 % of the
    // largest), and the short-circuit modes absent from the open spectrum (rel. distance > 1e-4); the others have no
    // net electrode charge and are identical in both
    const vmax = Math.max(...vTop.map(Math.abs));
    const openAct = spectra.open!.filter((f, k) => f > 0 && Math.abs(vTop[k]!) > 0.01 * vmax);
    const shortAct = spectra.short!.filter((f) => f > 0 && !spectra.open!.some((g) => Math.abs(g - f) <= 1e-4 * f));
    rec({ gate: 'CP-06', variant, nDiv, f_short: spectra.short!.map(Math.round), f_open: spectra.open!.map(Math.round), V_top_open: vTop.map((x) => Number(x.toPrecision(3))),
      short_active: shortAct.map((x) => Number(x.toFixed(1))), open_active: openAct.map((x) => Number(x.toFixed(1))), ref_short: targets.short, ref_open: targets.open,
      rel_short: shortAct.slice(0, 2).map((f, i) => Number(rel(f, targets.short[i]!).toFixed(5))), rel_open: openAct.slice(0, 2).map((f, i) => Number(rel(f, targets.open[i]!).toFixed(5))),
      index_short: shortAct.slice(0, 2).map((f) => spectra.short!.indexOf(f)), index_open: openAct.slice(0, 2).map((f) => spectra.open!.indexOf(f)), dof, msPerStudy: Math.round(msAll / 2) });
  }
}
// 5c. CP-06 sensitivity (bounded check of the f1 offset, no fitting): d ln f / d ln X for +1 % on each constant, n = 4
if (want('cp06sens')) {
  const { raw: raw0, rho: rhoP } = await pztCube();
  const mesh = boxMesh({ x: [0, 0.01], y: [0, 0.01], z: [0, 0.02], nx: 4, ny: 4, nz: 8, cell: 'tet10', id: 'cube' });
  const active = async (raw: unknown) => {
    const v = validateSpec(structuredClone(raw), requestedRegistry());
    const spec = v.spec as Spec, f: Record<string, number[]> = {}, vt: number[] = [];
    for (const kind of ['short', 'open'] as const) {
      const study = spec.studies!.find((s) => s.physics.includes(kind === 'short' ? 'es_sc' : 'es_oc'))!;
      const sol = await runStudy({ spec, physicsId: 'solid', mesh, materials: { pzt4: { rho: rhoP } }, study, progress: () => {}, signal: new AbortController().signal }, { studyId: study.id });
      f[kind] = Array.from(sol.steps!.values);
      if (kind === 'open') f.open!.forEach((_, k) => { const key = Object.keys(sol.scalars).find((x) => x.endsWith(`V_top_oc_${k}`)); vt.push(key ? Math.abs(sol.scalars[key]!.value) : 0); });
    }
    const vmax = Math.max(...vt);
    const o = f.open!.filter((x, k) => x > 0 && vt[k]! > 0.01 * vmax), sc = f.short!.filter((x) => x > 0 && !f.open!.some((g) => Math.abs(g - x) <= 1e-4 * x));
    return [sc[0]!, sc[1]!, o[0]!, o[1]!];
  };
  const base = await active(raw0);
  rec({ gate: 'CP-06-sens', base: base.map(Math.round), ratio_open_short_f1: base[2]! / base[0]!, ratio_open_short_f1_ref: 81590 / 66560, ratio_open_short_f2: base[3]! / base[1]!, ratio_open_short_f2_ref: 93410 / 88010 });
  const perturb: Array<[string, string]> = [['C', 'C11'], ['C', 'C12'], ['C', 'C13'], ['C', 'C33'], ['C', 'C44'], ['e_piezo', 'e15'], ['e_piezo', 'e31'], ['e_piezo', 'e33'], ['eps_r', 'perp'], ['eps_r', 'par']];
  for (const [prop, comp] of perturb) {
    const raw = structuredClone(raw0);
    raw.materials[0]!.override[prop]!.components[comp]! *= 1.01;
    const f = await active(raw);
    rec({ gate: 'CP-06-sens', prop, comp, dlnf_dlnX: f.map((x, i) => Number(((Math.log(x) - Math.log(base[i]!)) / Math.log(1.01)).toFixed(3))), order: ['short f1', 'short f2', 'open f1', 'open f2'] });
  }
}
// 5b. orientation forms on lane MX's sims/ln-fbar-2d.yaml: settings.euler (as in the sim) vs the equivalent settings.crystals
if (want('orient')) {
  const { prepareRun } = await import('../src/index.ts');
  const raw0 = parseYaml(readFileSync(resolve(root, 'sims/ln-fbar-2d.yaml'), 'utf8')).data as { couplings: Array<{ type: string; settings?: Record<string, unknown> }>; materials: Array<{ id: string; override?: { C?: unknown } }> };
  const pz = raw0.couplings.find((c) => c.type === 'piezoelectric')!;
  const ln = raw0.materials.find((m) => m.override?.C)!.id;
  const out: Record<string, number[]> = {};
  for (const form of ['euler', 'crystals'] as const) {
    const raw = structuredClone(raw0);
    const c = raw.couplings.find((x) => x.type === 'piezoelectric')!;
    if (form === 'crystals') {
      c.settings = { crystals: [{ material: ln, cut: 'x', propagation: 'z' }] };
      // the sim's provenance entry for settings.euler no longer resolves: drop it in this scratch copy
      const pv = (raw as unknown as { provenance?: { values?: Record<string, unknown> } }).provenance?.values;
      if (pv) for (const k of Object.keys(pv)) if (k.endsWith('.settings.euler')) delete pv[k];
    }
    const prep = await prepareRun(raw as unknown as Record<string, unknown>, {});
    const [sol, ms] = await timed(() => runStudy(prep));
    out[form] = Array.from(sol.steps!.values);
    rec({ gate: 'orient-ln-fbar-2d', form, settings: c.settings, dof: sol.stats.dof, ms: Math.round(ms), f: out[form]!.slice(0, 6).map((x) => Math.round(x)) });
  }
  const maxRel = Math.max(...out.euler!.map((f, i) => Math.abs(f - out.crystals![i]!) / Math.abs(f)));
  rec({ gate: 'orient-ln-fbar-2d', eulerInSim: pz.settings?.euler, crystals: [{ material: ln, cut: 'x', propagation: 'z' }], maxRelDiff: maxRel, nModes: out.euler!.length });
}
// 7. lane MX's thermal-stress sims that needed E1 (pnt: constraints) / E2 (hex8 box meshes -> tet10 for elastic)
if (want('mpsims')) {
  const { prepareRun } = await import('../src/index.ts');
  const { hexToTet10 } = await import('../src/elastic/hex2tet.ts');
  const { sample } = await import('../../post/src/index.ts');
  const { resolveParams, resolveQuantity } = await import('@amp/spec');
  const refs = JSON.parse(readFileSync(resolve(root, 'validation/mp/references.json'), 'utf8')) as Record<string, Record<string, number>>;
  for (const id of ['bimetal-strip', 'chip-warpage-2d', 'hot-arm-actuator']) {
    const raw = parseYaml(readFileSync(resolve(root, `sims/${id}.yaml`), 'utf8')).data as Record<string, unknown>;
    const v = validateSpec(structuredClone(raw), physicsRegistry());
    const issues = v.issues.filter((i) => i.severity !== 'notice').map((i) => `${i.dotted}: ${i.message}`);
    try {
      const prep = await prepareRun(raw, {});
      const hex = prep.mesh.cells.type === 'hex8';
      if (hex) prep.mesh = hexToTet10(prep.mesh);   // E2: what prepare.ts should do for studies with elastic (request to MC)
      const [sol, ms] = await timed(() => runStudy(prep));
      const scope = resolveParams(prep.spec.params ?? {}).scope;
      const si = (x: unknown) => (resolveQuantity(x, scope) as { si: number }).si;
      const uy = (pt: number[]) => sample(sol, 'solid.u', [pt], { component: 1 })[0]!;
      const base = { gate: 'mp-sim', id, validates: v.ok, issues: issues.slice(0, 3), mesh: `${prep.mesh.cells.domain.length} ${prep.mesh.cells.type}${hex ? ' (from hex8)' : ''}`, dof: sol.stats.dof, ms: Math.round(ms) };
      if (id === 'bimetal-strip') {
        const xq = si('L') / 4, d = uy([xq, 0]) - uy([0, 0]), kappa = (2 * d) / (xq * xq), r = refs[id]!;
        rec({ ...base, uy0_m: uy([0, 0]), uyQ_m: uy([xq, 0]), dw_m: d, ref_dw_m: r.dw_centre_to_quarter_m, kappa, ref_kappa: r.kappa_1_per_m, rel: rel(kappa, r.kappa_1_per_m!) });
      } else if (id === 'chip-warpage-2d') {
        const xi = si('W_int') / 2, xs = si('W_sub') / 2, u0 = uy([0, 0]), ui = uy([xi, 0]), us = uy([xs, 0]), r = refs[id]!;
        rec({ ...base, bow_int_m: u0 - ui, ref_bow_int_m: r.bow_over_interposer_length_m, rel_int: rel(u0 - ui, r.bow_over_interposer_length_m!), bow_sub_m: u0 - us, ref_bow_sub_m: r.bow_over_substrate_length_m, rel_sub: rel(u0 - us, r.bow_over_substrate_length_m!), kappa_int: (2 * (u0 - ui)) / (xi * xi), ref_kappa: r.kappa_1_per_m });
      } else {
        const pt = [si('D8 + D4 + D5'), si('-(D7 + D2)'), si('D11')];
        const u = [0, 1, 2].map((c) => sample(sol, 'solid.u', [pt], { component: c })[0]!);
        const sc = (k: string) => Object.entries(sol.scalars).find(([n]) => n === k || n.endsWith(`.${k}`))?.[1]?.value;
        rec({ ...base, tip_m: pt, tip_u_um: u.map((x) => x * 1e6), tip_usum_um: Math.hypot(...u) * 1e6, T_max_K: sc('T_max'), P_W: sc('P'), ref_tip_um: 27, note: 'CP-04 target informative: constant 300 K properties, no NLGEOM, no radiation (sim assumptions)' });
      }
    } catch (e) { rec({ gate: 'mp-sim', id, validates: v.ok, issues: issues.slice(0, 3), error: (e as Error).message.slice(0, 300) }); }
  }
}
// 6. piezo 3D thickness column and acoustic-structure column timings come from the unit tests (small); see DevLog-033 s.4

const d0 = new Date(), pad = (x: number) => String(x).padStart(2, '0');
const ts = `${d0.getFullYear()}${pad(d0.getMonth() + 1)}${pad(d0.getDate())}T${pad(d0.getHours())}${pad(d0.getMinutes())}${pad(d0.getSeconds())}`;   // local time, as the other logs
mkdirSync(resolve(root, 'logs'), { recursive: true });
writeFileSync(resolve(root, `logs/MT-gates-${ts}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
console.log(`records: logs/MT-gates-${ts}.jsonl`);
