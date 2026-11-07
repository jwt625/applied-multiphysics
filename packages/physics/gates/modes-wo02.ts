// SPDX-License-Identifier: GPL-3.0-or-later
// Gate WO-02 (R3 s.3.5, class b): Hadley 2002 benchmark as re-tabulated in femwell docs/benchmarks (GPL-3.0),
// fetched 2026-11-06 via the GitHub contents API (no eval case file filed yet):
//   rib: github.com/HelgeGehring/femwell/blob/main/docs/benchmarks/mode_solver.py (last commit 6154df58, 2024-05-01)
//   box: github.com/HelgeGehring/femwell/blob/main/docs/benchmarks/mode_solver_rectangle.py (37c2885e, 2024-05-01)
//   default boundaries: femwell/maxwell/waveguide.py compute_modes(metallic_boundaries=False), i.e. natural (PMC)
// Rib setup (from mode_solver.py): lambda 1.15 um; core n 3.44 = rib 3 x 1 um (x in [-1.5, 1.5], y in [0, 1]) plus a
// full-width slab y in [0, t] (t = 0 .. 0.7 um); substrate ("box") n 3.40, x in [-9, 9], y in [-10, 0]; cover n 1,
// y in [0, 3]; outer boundary natural; mode = highest n_eff (num_modes 1, shift above max eps). Reference n_eff
// (Hadley, "+-3e-6"): 3.412022, 3.412126, 3.412279, 3.412492, 3.412774, 3.413132, 3.413571, 3.414100.
// Box setup (mode_solver_rectangle.py): unit square, core [0, 0.5]^2 at the corner (quarter of a symmetric guide),
// lambda 1.5 (same length unit), PEC on the listed sides, natural elsewhere; references 1.27627404 (eps core/clad
// 2.25/1, PEC left+right), 2.65679692 (8/1, left+right), 1.387926425 (1/2.25, left+top), 2.761465320 (1/8, left+top).
// Here: the rib is solved on the half window x in [0, 9] with x = 0 as a symmetry plane, once PEC and once PMC; the
// full-window spectrum is the union, so the top mode is the larger of the two. Gate tolerances (set before the run):
// rib abs 3e-6 (the stated reference accuracy, R3); box abs 1e-6 after Richardson (the references claim 1e-8).
// Usage: nice -n 10 node --max-old-space-size=1536 packages/physics/gates/modes-wo02.ts [--rib-only|--box-only] [--t 0.3]

import type { Mesh } from '@amp/spec/types';
import { buildGeometry2D } from '@amp/geom';
import { mesh2d } from '@amp/mesh';
import { solveModes } from '../src/modes/index.ts';
import { rectTriMesh } from '../src/common/mesh.ts';
import { GateLog, extrapolate, hFromDof, stagesOf, waitForLoad, type LevelRow } from './modes-common.ts';

const UM = 1e-6;
export const RIB = {
  lambda: 1.15 * UM, nCore: 3.44, nBox: 3.40, nClad: 1,
  t: [0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7],
  ref: [3.412022, 3.412126, 3.412279, 3.412492, 3.412774, 3.413132, 3.413571, 3.414100],
  tolAbs: 3e-6,
};
export const BOX = {
  lambda: 1.5, cases: [
    { eps: [2.25, 1], pec: ['left', 'right'], ref: 1.27627404 },
    { eps: [8, 1], pec: ['left', 'right'], ref: 2.65679692 },
    { eps: [1, 2.25], pec: ['left', 'top'], ref: 1.387926425 },
    { eps: [1, 8], pec: ['left', 'top'], ref: 2.761465320 },
  ], tolAbs: 1e-6,
};

/** Boundary ids whose facets all lie on x = x0 (within tol). */
function boundariesOnX(mesh: Mesh, x0: number, tol: number): string[] {
  const k = mesh.facets.type === 'line3' ? 3 : 2;
  const nb = mesh.entities.boundaries.length;
  const all = new Uint8Array(nb).fill(1), seen = new Uint8Array(nb);
  for (let f = 0; f < mesh.facets.boundary.length; f++) {
    const b = mesh.facets.boundary[f]!;
    seen[b] = 1;
    for (let a = 0; a < 2; a++) if (Math.abs(mesh.nodes[2 * mesh.facets.conn[k * f + a]!]! - x0) > tol) all[b] = 0;
  }
  return mesh.entities.boundaries.filter((_, i) => seen[i] && all[i]).map((e) => e.id);
}

/** Half-window rib mesh (x >= 0) through @amp/geom + @amp/mesh; sizes in m. */
export function ribMesh(t: number, h: { core: number; max: number; corner: number; grade: number; cornerGrade: number }): Mesh {
  const feats: any[] = [
    { id: 'box', type: 'rect', x: [0, 9 * UM], y: [-10 * UM, 0] },
    { id: 'cl', type: 'rect', x: [0, 9 * UM], y: [0, 3 * UM] },
    { id: 'rib', type: 'rect', x: [0, 1.5 * UM], y: [0, 1 * UM] },
  ];
  if (t > 0) feats.push({ id: 'slab', type: 'rect', x: [0, 9 * UM], y: [0, t] }, { id: 'core', type: 'union', inputs: ['rib', 'slab'] });
  feats.push({ id: 'clad', type: 'difference', target: 'cl', tools: [t > 0 ? 'core' : 'rib'], keepTools: true });
  const g = buildGeometry2D({ features: feats });
  // graded point refinement at the rib corners (field singularities at dielectric corners)
  const corners = [[1.5 * UM, 1 * UM], [1.5 * UM, t]];
  const pts = g.entities.points!.filter((_, i) => {
    const v = g.pointVertex[i]!;
    const x = g.vertices[2 * v]!, y = g.vertices[2 * v + 1]!;
    return corners.some(([cx, cy]) => Math.hypot(x - cx!, y - cy!) < 1e-12);
  }).map((p) => p.id);
  const coreDom = g.entities.domains.filter((d) => d.id === 'dom:core' || d.id === 'dom:rib').map((d) => d.id);
  return mesh2d(g, { hmax: h.max, grade: h.grade, refine: [{ select: coreDom, h: h.core }, ...(pts.length ? [{ select: pts, h: h.corner, grade: h.cornerGrade }] : [])], order: 1 });
}

function ribEps(mesh: Mesh): number[] {
  return mesh.entities.domains.map((d) => (d.id === 'dom:box' ? RIB.nBox ** 2 : d.id === 'dom:core' || d.id === 'dom:rib' ? RIB.nCore ** 2 : RIB.nClad ** 2));
}

export async function ribTop(t: number, s: number) {
  // every size, and the size growth per unit distance, scale with s: a geometrically similar mesh family (Richardson)
  const tm = performance.now();
  const mesh = ribMesh(t, { core: 0.2 * s * UM, max: 0.6 * s * UM, corner: 0.05 * s * UM, grade: 0.3 * s, cornerGrade: 0.2 * s });
  const meshMs = performance.now() - tm;
  const sym = boundariesOnX(mesh, 0, 1e-12);
  const out: any[] = [];
  let wall = meshMs;
  for (const plane of ['pec', 'pmc'] as const) {
    const t0 = performance.now();
    const r = await solveModes({ mesh, eps: ribEps(mesh), pec: plane === 'pec' ? sym : [], wavelength: RIB.lambda, nModes: 1, fields: false, order: 2 });
    wall += performance.now() - t0;
    out.push({ plane, neff: r.result.modes[0].neff, te: r.result.modes[0].teFraction, dof: r.solution.stats.dof, stages: { mesh: Math.round(meshMs * 10) / 10, ...stagesOf(r.solution) } });
  }
  const top = out[0].neff >= out[1].neff ? out[0] : out[1];
  return { top, both: out, wall_ms: wall, cells: mesh.cells.conn.length / 3 };
}

export async function runWO02(opts: { rib?: boolean; box?: boolean; tList?: number[]; scales?: number[]; quiet?: boolean } = {}) {
  const log = new GateLog('modes-wo02');
  const load = await waitForLoad();
  log.write({ kind: 'meta', case: 'WO-02', source: 'femwell docs/benchmarks mode_solver.py 6154df58, mode_solver_rectangle.py 37c2885e (accessed 2026-11-06)', load1: load, RIB, BOX });
  const say = (s: string) => { if (!opts.quiet) console.log(s); };
  const res: any = { rib: [], box: [], log: log.path };
  if (opts.box !== false) {
    for (const [ci, c] of BOX.cases.entries()) {
      const rows: LevelRow[] = [];
      for (const N of [8, 16, 32, 64]) {
        const m0 = rectTriMesh({ x: [0, 1], y: [0, 1], nx: 2 * N, ny: 2 * N });
        const nc = m0.cells.conn.length / 3, dom = new Int32Array(nc);
        for (let e = 0; e < nc; e++) {
          let xc = 0, yc = 0;
          for (let a = 0; a < 3; a++) { const n = m0.cells.conn[3 * e + a]!; xc += m0.nodes[2 * n]! / 3; yc += m0.nodes[2 * n + 1]! / 3; }
          dom[e] = xc < 0.5 && yc < 0.5 ? 1 : 0;
        }
        const mesh: Mesh = { ...m0, cells: { ...m0.cells, domain: dom }, entities: { ...m0.entities, domains: [{ id: 'dom:clad' }, { id: 'dom:core' }] } };
        // lengths in the benchmark's unit: pass coordinates as metres and the wavelength in the same unit (ratio only)
        const t0 = performance.now();
        const r = await solveModes({ mesh, eps: [c.eps[1]!, c.eps[0]!], pec: c.pec.map((s) => `bnd:rect.${s}`), wavelength: BOX.lambda, nModes: 1, fields: false, order: 2 });
        const wall = performance.now() - t0;
        const v = r.result.modes[0].neff;
        rows.push({ level: N, dof: r.solution.stats.dof, h: hFromDof(r.solution.stats.dof, 2), value: v, err: v - c.ref, stages: stagesOf(r.solution), wall_ms: wall });
        log.write({ kind: 'level', target: `box${ci}`, ...rows.at(-1)! });
      }
      const rich = extrapolate(rows.slice(-3));
      const err = rich.f_ext !== null ? rich.f_ext - c.ref : NaN;
      const pass = Math.abs(err) <= BOX.tolAbs;
      const rec = { kind: 'target', target: `box${ci}`, eps: c.eps, ref: c.ref, f_ext: rich.f_ext, p_obs: rich.p_obs, err_ext: err, tolAbs: BOX.tolAbs, pass, wall_ms_levels: rows.map((x) => x.wall_ms) };
      log.write(rec);
      res.box.push({ rows, ...rec });
      say(`WO-02 box eps ${c.eps.join('/')} PEC ${c.pec.join('+')}: ref ${c.ref}`);
      for (const x of rows) say(`  N ${x.level}  dof ${x.dof}  n_eff ${x.value.toFixed(9)}  err ${x.err.toExponential(2)}  wall ${x.wall_ms.toFixed(0)} ms`);
      say(`  Richardson: f_ext ${rich.f_ext?.toFixed(9)}  p_obs ${rich.p_obs?.toFixed(2)}  err ${err.toExponential(2)}  tol ${BOX.tolAbs}  ${pass ? 'PASS' : 'FAIL'}`);
    }
  }
  if (opts.rib !== false) {
    const tList = opts.tList ?? RIB.t;
    for (const t of tList) {
      const i = RIB.t.findIndex((v) => Math.abs(v - t) < 1e-12);
      const ref = RIB.ref[i]!;
      const rows: LevelRow[] = [];
      for (const s of opts.scales ?? [1 / Math.SQRT2, 0.5, 0.5 / Math.SQRT2]) {
        const r = await ribTop(t * UM, s);
        rows.push({ level: s, dof: r.top.dof, h: hFromDof(r.top.dof, 2), value: r.top.neff, err: r.top.neff - ref, stages: r.top.stages, wall_ms: r.wall_ms });
        log.write({ kind: 'level', target: `rib_t${t}`, ...rows.at(-1)!, plane: r.top.plane, teFraction: r.top.te, other: r.both.find((b: any) => b !== r.top) });
      }
      const rich = extrapolate(rows.slice(-3));
      const err = rich.f_ext !== null ? rich.f_ext - ref : NaN;
      const finestErr = rows.at(-1)!.err;
      const pass = Math.abs(err) <= RIB.tolAbs;
      const raw = rows.find((x) => Math.abs(x.err) <= RIB.tolAbs);
      const rec = { kind: 'target', target: `rib_t${t}`, ref, f_ext: rich.f_ext, p_obs: rich.p_obs, err_ext: err, err_finest: finestErr, tolAbs: RIB.tolAbs, pass,
        first_level_within_tol: raw ? { level: raw.level, wall_ms: raw.wall_ms } : null, wall_ms_levels: rows.map((x) => x.wall_ms) };
      log.write(rec);
      res.rib.push({ rows, ...rec });
      say(`WO-02 rib t = ${t} um: ref ${ref}`);
      for (const x of rows) say(`  s ${x.level.toFixed(3)}  dof ${x.dof}  n_eff ${x.value.toFixed(7)}  err ${x.err.toExponential(2)}  wall ${x.wall_ms.toFixed(0)} ms (mesh + 2 symmetry solves)  ${JSON.stringify(x.stages)}`);
      say(`  Richardson: f_ext ${rich.f_ext?.toFixed(7)}  p_obs ${rich.p_obs?.toFixed(2)}  err ${err.toExponential(2)}  tol ${RIB.tolAbs}  ${pass ? 'PASS' : 'FAIL'}`);
    }
  }
  say(`log ${log.path}`);
  return res;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const a = process.argv.slice(2);
  const ti = a.indexOf('--t');
  const si = a.indexOf('--scales');
  const r = await runWO02({ rib: !a.includes('--box-only'), box: !a.includes('--rib-only'), ...(ti >= 0 ? { tList: [Number(a[ti + 1])] } : {}),
    ...(si >= 0 ? { scales: a[si + 1]!.split(',').map(Number) } : {}) });
  process.exitCode = [...r.rib, ...r.box].every((x: any) => x.pass) ? 0 : 2;
}
