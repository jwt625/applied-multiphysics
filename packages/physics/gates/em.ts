// SPDX-License-Identifier: GPL-3.0-or-later
// H3 and static EM gates on NESTED level sequences (base CDT mesh + refineUniform, new boundary nodes on the exact
// curves): EM-04 Helmholtz coil (axisym A_phi), EM-03 Palace rings (inductance matrix), EM-01 coax (2D C', L', Z0),
// EM-02 Lekner spheres (axisym Maxwell capacitance matrix). Inputs and references come from the eval case files
// (eval/cases/{a,c}) and expected files; verdicts by the shared harness rule (gates/common.ts).
// Theoretical orders (P2): energy-type quantities (C, L, M) 4; field values from the gradient of A (B) 2.
// Usage: nice -n 10 node --max-old-space-size=1536 gates/em.ts [EM-04 EM-03 EM-01 EM-02]

import { buildGeometry2D, type Feature } from '@amp/geom';
import { mesh2d, refineUniform, type MeshOptions2D } from '@amp/mesh';
import { sample } from '../../post/src/index.ts';
import type { Mesh } from '@amp/spec/types';
import { nCells } from '../src/common/mesh.ts';
import { solveMagnetostatics } from '../src/magnetostatics/index.ts';
import { solveElectrostatics, MU0 } from '../src/electrostatics/index.ts';
import { gaussLegendre01 } from '../src/common/quad.ts';
import { readCase, caseTarget, expectedValue, GateLog, waitForLoad, evaluate, printTable, speedLine, ExitCode, type Level, type Target } from './common.ts';

const only = process.argv.slice(2);
const want = (id: string) => !only.length || only.includes(id);
const log = new GateLog('em');
const exit = new ExitCode();
const fin = (id: string, levels: Level[], targets: Target[]) => {
  const res = evaluate(levels, targets);
  printTable(id, levels, res, log);
  speedLine(id, levels, targets, res, log);
  exit.add(res);
  return res;
};
const stages = (t: Record<string, number>, extra: Record<string, number> = {}) => ({ ...extra, ...Object.fromEntries(Object.entries(t).map(([k, v]) => [k, +v.toFixed(1)])) });

/** Nested sequence: CDT base mesh then k uniform refinements; ms = time to build that level from the previous one. */
function nested(g: ReturnType<typeof buildGeometry2D>, o: MeshOptions2D, n: number): Array<{ m: Mesh; ms: number }> {
  let t0 = performance.now();
  const out = [{ m: mesh2d(g, o), ms: 0 }];
  out[0]!.ms = performance.now() - t0;
  for (let k = 1; k < n; k++) { t0 = performance.now(); out.push({ m: refineUniform(out[k - 1]!.m, { geometry: g }), ms: performance.now() - t0 }); }
  return out;
}

/** Half disk r in [0, Rb] (axis at r = 0) with embedded tool features (kept as domains, or subtracted). */
function halfDisk(Rb: number, tools: Feature[], keep: boolean) {
  return buildGeometry2D({ axisym: true, features: [
    { id: 'box', type: 'rect', x: [0, Rb], y: [-Rb, Rb] }, { id: 'far', type: 'circle', c: [0, 0], r: Rb },
    { id: 'air', type: 'intersection', inputs: ['box', 'far'] }, ...tools,
    { id: 'all', type: 'difference', target: 'air', tools: tools.map((t) => t.id), ...(keep ? { keepTools: true } : {}) }] });
}
const bndStarting = (m: Mesh, pre: string) => m.entities.boundaries.filter((b) => b.id.startsWith(pre)).map((b) => b.id);

await waitForLoad();

if (want('EM-04')) {
  const c = readCase('a', 'EM-04');
  const R = c.geometry.spec.loop_radius_m as number, zs = c.geometry.spec.loop_z_m as number[];
  const I = c.bcs[0].value as number, muR = c.materials.air.mu_r as number;
  const s = R / 100;   // coil cross-section side (modelling choice, as sims/helmholtz-coil.yaml)
  const Rb = 100 * R;  // truncation shift -1.398 (R/Rb)^3 = -1.4e-6 (eval/expected/EM-04.json)
  const g = gaussLegendre01(8);
  let Bfin = 0;
  for (const zc of zs) for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) {
    const rho = R - s / 2 + s * g.x[i]!, zeta = zc - s / 2 + s * g.x[j]!;
    Bfin += g.w[i]! * g.w[j]! * (MU0 * I * rho * rho) / (2 * (rho * rho + zeta * zeta) ** 1.5);
  }
  const ref = expectedValue('EM-04', 'B_center').value;
  console.log(`EM-04 finite-section (s = R/100) reference B(0) = ${Bfin.toPrecision(10)} T, filament ${ref.toPrecision(10)} T, rel shift ${((Bfin - ref) / ref).toExponential(3)}`);
  const targets: Target[] = [caseTarget('a', 'EM-04', 'B_center', { order: 2 }), caseTarget('a', 'EM-04', 'Bz_probe', { order: 2 }),
    caseTarget('a', 'EM-04', 'Br_probe'), caseTarget('a', 'EM-04', 'uniformity_sphere_0.1R')];
  const geo = (Rbx: number) => halfDisk(Rbx, [
    ...zs.map((z, k) => ({ id: `coil${k + 1}`, type: 'rect' as const, x: [R - s / 2, R + s / 2] as [number, number], y: [z - s / 2, z + s / 2] as [number, number] })),
    { id: 'core', type: 'rect' as const, x: [0, 0.15 * R] as [number, number], y: [-0.15 * R, 0.15 * R] as [number, number] }], true);
  const opts = (Rbx: number): MeshOptions2D => ({ hmax: Rbx / 4, grade: 0.25, refine: [{ select: ['dom:coil1', 'dom:coil2'], h: s / 2 }, { select: ['dom:core'], h: R / 40 }], order: 2 });
  const run = async (m: Mesh) => solveMagnetostatics({ mesh: m, muR: new Float64Array(nCells(m)).fill(muR), coils: [
    { id: 'c1', select: ['dom:coil1'], turns: 1, current: I }, { id: 'c2', select: ['dom:coil2'], turns: 1, current: I }], insulation: bndStarting(m, 'bnd:far') });
  const seq = nested(geo(Rb), opts(Rb), 3);
  const levels: Level[] = [];
  for (const [i, { m, ms }] of seq.entries()) {
    const t1 = performance.now();
    const sol = await run(m);
    const wall = performance.now() - t1 + ms;
    const B0 = sample(sol, 'Bz', [0, 0])[0]!;
    let unif = 0;
    for (let q = 0; q <= 90; q++) {
      const th = (Math.PI * q) / 90, rr = 0.1 * R, p = [rr * Math.sin(th), rr * Math.cos(th)];
      unif = Math.max(unif, Math.abs(Math.hypot(sample(sol, 'Br', p)[0]!, sample(sol, 'Bz', p)[0]!) - B0) / B0);
    }
    levels.push({ level: i, h: 2 ** -i, dof: sol.stats.dof, wall_ms: wall, stages: stages(sol.timing, { mesh: +ms.toFixed(1) }), values: {
      B_center: B0, Bz_probe: sample(sol, 'Bz', [0.02, 0.01])[0]!, Br_probe: sample(sol, 'Br', [0.02, 0.01])[0]!, 'uniformity_sphere_0.1R': unif } });
  }
  const res = fin('EM-04 Helmholtz coil (R_b = 100 R, s = R/100, nested)', levels, targets);
  const b = res.find((r) => r.target === 'B_center')!;
  console.log(`  B_center vs finite-section reference: rel ${(((b.value ?? b.fine) - Bfin) / Bfin).toExponential(3)}`);
  // truncation check: A = 0 on R_b = 30 R at the same mesh level as the finest, against the dipole image of the case
  const seq30 = nested(geo(30 * R), opts(30 * R), 3);
  const s30 = await run(seq30[2]!.m);
  const s100 = sample(await run(seq[2]!.m), 'Bz', [0, 0])[0]!;
  const sh = (sample(s30, 'Bz', [0, 0])[0]! - s100) / ref;
  const tr = caseTarget('a', 'EM-04', 'truncation.dirichlet_A.Rb30R');
  const pred = tr.ref - expectedValue('EM-04', 'truncation.dirichlet_A.Rb100R').value;
  const ok = Math.abs(sh - pred) <= (tr.abs ?? 0);
  console.log(`  ${ok ? 'PASS' : 'FAIL'} truncation R_b = 30 R: (B30 - B100)/B0 = ${sh.toExponential(4)} vs dipole image ${pred.toExponential(4)}, abs ${tr.abs}`);
  if (!ok && exit.code === 0) exit.code = 2;
  log.write({ kind: 'truncation', id: 'EM-04', shift: sh, ref: pred, pass: ok });
}

if (want('EM-03')) {
  const c = readCase('c', 'EM-03');
  const ra = c.geometry.spec.ring_a.radius_m as number, rb = c.geometry.spec.ring_b.radius_m as number, w = c.geometry.spec.ring_a.width_m as number;
  const muR = c.materials.vacuum.mu_r as number;
  // model: round sections of diameter w, uniform current (DevLog-010 s.4.3); energy-type targets: order 4
  const targets: Target[] = ['M_ab_filament_exact', 'M_ab', 'L_aa', 'L_bb'].map((id) => caseTarget('c', 'EM-03', id, { order: 4 }));
  const Rb = 100 * rb;
  const seq = nested(halfDisk(Rb, [{ id: 'ra', type: 'circle', c: [ra, 0], r: w / 2 }, { id: 'rb', type: 'circle', c: [rb, 0], r: w / 2 }], true),
    { hmax: Rb / 4, grade: 0.25, refine: [{ select: ['dom:ra', 'dom:rb'], h: w / 4 }], order: 2 }, 3);
  const levels: Level[] = [];
  for (const [i, { m, ms }] of seq.entries()) {
    const t1 = performance.now();
    const sol = await solveMagnetostatics({ mesh: m, muR: new Float64Array(nCells(m)).fill(muR), inductance: true, coils: [
      { id: 'a', select: ['dom:ra'], turns: 1, current: 1 }, { id: 'b', select: ['dom:rb'], turns: 1, current: 1 }], insulation: bndStarting(m, 'bnd:far') });
    const L = sol.L!;
    levels.push({ level: i, h: 2 ** -i, dof: sol.stats.dof, wall_ms: performance.now() - t1 + ms, stages: stages(sol.timing, { mesh: +ms.toFixed(1) }),
      values: { M_ab_filament_exact: L[1]!, M_ab: L[1]!, L_aa: L[0]!, L_bb: L[3]! } });
  }
  fin('EM-03 Palace rings (axisym, round section w, nested)', levels, targets);
}

if (want('EM-01')) {
  const c = readCase('a', 'EM-01');
  const a = c.geometry.spec.inner_radius_m as number, b = c.geometry.spec.outer_radius_m as number, er = c.materials.dielectric.eps_r as number;
  const targets: Target[] = ['C_per_m', 'L_per_m', 'Z0'].map((id) => caseTarget('a', 'EM-01', id, { order: 4 }));
  const geo = buildGeometry2D({ features: [{ id: 'outer', type: 'circle', c: [0, 0], r: b }, { id: 'inner', type: 'circle', c: [0, 0], r: a }, { id: 'diel', type: 'difference', target: 'outer', tools: ['inner'] }] });
  const levels: Level[] = [];
  for (const [i, { m, ms }] of nested(geo, { hmax: (b - a) / 3, order: 2 }, 4).entries()) {
    const t1 = performance.now();
    const sol = await solveElectrostatics({ mesh: m, epsR: new Float64Array(nCells(m)).fill(er), terminals: [{ id: 'inner', select: ['bnd:inner.edge'] }], ground: ['bnd:outer.edge'], vacuum: true });
    levels.push({ level: i, h: 2 ** -i, dof: sol.stats.dof, wall_ms: performance.now() - t1 + ms, stages: stages(sol.timing, { mesh: +ms.toFixed(1) }),
      values: { C_per_m: sol.scalars.C_per_m!.value, L_per_m: sol.scalars.L_per_m!.value, Z0: sol.scalars.Z0!.value } });
  }
  fin('EM-01 coax (nested)', levels, targets);
}

if (want('EM-02')) {
  const c = readCase('c', 'EM-02');
  const sa = c.geometry.spec.sphere_a, sb = c.geometry.spec.sphere_b;
  const a = sa.radius_m as number, b = sb.radius_m as number;
  // the axis of symmetry is the line of centres: (r, z) = (0, x of the case centres)
  const za = sa.center_m[0] as number, zb = sb.center_m[0] as number;
  const epsR = c.materials.vacuum.eps_r as number;
  const targets: Target[] = ['C_aa', 'C_bb', 'C_ab'].map((id) => caseTarget('c', 'EM-02', id, { order: 4 }));
  const Rout = 1000;  // grounded outer sphere: C_aa shift ~ a / Rout = 1e-5 (DevLog-010 s.4.3)
  const geo = buildGeometry2D({ axisym: true, features: [
    { id: 'box', type: 'rect', x: [0, Rout], y: [-Rout, Rout] }, { id: 'far', type: 'circle', c: [0, 0], r: Rout },
    { id: 'air', type: 'intersection', inputs: ['box', 'far'] }, { id: 'sa', type: 'circle', c: [0, za], r: a }, { id: 'sb', type: 'circle', c: [0, zb], r: b },
    { id: 'all', type: 'difference', target: 'air', tools: ['sa', 'sb'] }] });
  const levels: Level[] = [];
  for (const [i, { m, ms }] of nested(geo, { hmax: Rout / 4, grade: 0.25, refine: [{ select: ['bnd:sa.edge', 'bnd:sb.edge'], h: a / 4 }], order: 2 }, 3).entries()) {
    const t1 = performance.now();
    const sol = await solveElectrostatics({ mesh: m, epsR: new Float64Array(nCells(m)).fill(epsR), terminals: [{ id: 'a', select: bndStarting(m, 'bnd:sa.') }, { id: 'b', select: bndStarting(m, 'bnd:sb.') }], ground: bndStarting(m, 'bnd:far.') });
    levels.push({ level: i, h: 2 ** -i, dof: sol.stats.dof, wall_ms: performance.now() - t1 + ms, stages: stages(sol.timing, { mesh: +ms.toFixed(1) }), values: { C_aa: sol.C[0]!, C_bb: sol.C[3]!, C_ab: sol.C[1]! } });
  }
  fin('EM-02 Lekner spheres (axisym, R_out = 1000 m grounded, nested)', levels, targets);
}
console.log(`\nlog: ${log.path}`);
exit.set();
