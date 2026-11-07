// SPDX-License-Identifier: GPL-3.0-or-later
// H3 and static EM gates: EM-04 Helmholtz coil (axisym A_phi), EM-03 Palace rings (inductance matrix), EM-01 coax
// (2D electrostatics: C', L', Z0), EM-02 Lekner spheres (axisym Maxwell capacitance matrix).
// Tolerances of EM-02 / EM-03 (class c, no case file yet) are fixed in DevLog-010 s.4.3 before the run.
// Usage: nice -n 10 node --max-old-space-size=1536 gates/em.ts [EM-04 EM-03 EM-01 EM-02]

import { buildGeometry2D, type Feature } from '@amp/geom';
import { mesh2d } from '@amp/mesh';
import { sample } from '@amp/post';
import { nCells } from '../src/common/mesh.ts';
import { solveMagnetostatics } from '../src/magnetostatics/index.ts';
import { solveElectrostatics, EPS0, MU0 } from '../src/electrostatics/index.ts';
import { gaussLegendre01 } from '../src/common/quad.ts';
import { readCase, expectedValue, GateLog, waitForLoad, evaluate, printTable, timeToAccuracy, type Level, type Target } from './common.ts';

const only = process.argv.slice(2);
const want = (id: string) => !only.length || only.includes(id);
const log = new GateLog('em');
const fin = (id: string, levels: Level[], targets: Target[]) => {
  const res = evaluate(levels, targets);
  printTable(id, levels, res, log);
  const tta = timeToAccuracy(levels, targets);
  const tot = levels.reduce((s, l) => s + l.wall_ms, 0);
  console.log(`  time to accuracy (single level): ${tta.level === null ? 'not reached' : `L${tta.level} ${tta.wall_ms!.toFixed(1)} ms`}; all levels ${tot.toFixed(1)} ms; <5 s ${tot < 5000 ? 'yes' : 'no'}`);
  log.write({ kind: 'speed', id, tta, total_ms: tot });
  return res;
};
const stages = (t: Record<string, number>, extra: Record<string, number> = {}) => ({ ...extra, ...Object.fromEntries(Object.entries(t).map(([k, v]) => [k, +v.toFixed(1)])) });

/** Complete elliptic integrals K(k), E(k) (modulus k) by the arithmetic-geometric mean. */
export function ellipKE(k: number): { K: number; E: number } {
  let a = 1, b = Math.sqrt(1 - k * k), c = k, sum = 0.5 * c * c, p = 1;
  for (let i = 0; i < 40 && Math.abs(c) > 1e-17; i++) { const an = (a + b) / 2; c = (a - b) / 2; b = Math.sqrt(a * b); a = an; p *= 2; sum += 0.5 * p * c * c; }
  const K = Math.PI / (2 * a);
  return { K, E: K * (1 - sum) };
}
/** Mutual inductance of two coaxial filament loops (Maxwell): mu0 sqrt(a b) [(2/k - k) K - (2/k) E]. */
export const loopMutual = (a: number, b: number, dz: number) => {
  const k = Math.sqrt((4 * a * b) / ((a + b) ** 2 + dz * dz));
  const { K, E } = ellipKE(k);
  return MU0 * Math.sqrt(a * b) * ((2 / k - k) * K - (2 / k) * E);
};

/** Half disk r in [0, Rb] (axis at r = 0) with embedded tool features kept as domains. */
function halfDisk(Rb: number, tools: Feature[]) {
  return buildGeometry2D({ axisym: true, features: [
    { id: 'box', type: 'rect', x: [0, Rb], y: [-Rb, Rb] }, { id: 'far', type: 'circle', c: [0, 0], r: Rb },
    { id: 'air', type: 'intersection', inputs: ['box', 'far'] }, ...tools,
    { id: 'all', type: 'difference', target: 'air', tools: tools.map((t) => t.id), keepTools: true }] });
}

await waitForLoad();

if (want('EM-04')) {
  const c = readCase('a', 'EM-04');
  const R = c.geometry.spec.loop_radius_m as number, zs = c.geometry.spec.loop_z_m as number[];
  const I = c.bcs[0].value as number, muR = c.materials.air.mu_r as number;
  const s = R / 100;   // coil cross-section side (sims/helmholtz-coil.yaml: s = R/100, modelling choice)
  const Rb = 100 * R;  // truncation shift -1.398 (R/Rb)^3 = -1.4e-6 (eval/expected/EM-04.json)
  // finite square section reference: average of the filament B_z(0) over the section (uniform J), Gauss 8 x 8
  const g = gaussLegendre01(8);
  let Bfin = 0;
  for (const zc of zs) for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) {
    const rho = R - s / 2 + s * g.x[i]!, zeta = zc - s / 2 + s * g.x[j]!;
    Bfin += g.w[i]! * g.w[j]! * (MU0 * I * rho * rho) / (2 * (rho * rho + zeta * zeta) ** 1.5);
  }
  const ref = expectedValue('EM-04', 'B_center').value;
  console.log(`EM-04 finite-section (s = R/100) reference B(0) = ${Bfin.toPrecision(10)} T, filament ${ref.toPrecision(10)} T, rel shift ${((Bfin - ref) / ref).toExponential(3)}`);
  const ids = ['B_center', 'Bz_probe', 'Br_probe', 'uniformity_sphere_0.1R'];
  const tolOf = (id: string) => { const r = (c.references as Array<{ metric_id: string; tolerance: { rel?: number; abs?: number } }>).find((x) => x.metric_id === id)!; return { ...(r.tolerance.rel !== undefined ? { rel: r.tolerance.rel } : {}), ...(r.tolerance.abs !== undefined ? { abs: r.tolerance.abs } : {}) }; };
  const targets: Target[] = ids.map((id, j) => ({ id, ref: expectedValue('EM-04', id).value, unit: '', ...tolOf(id), richardson: j < 2 }));
  const levels: Level[] = [];
  const coilGeo = (Rbx: number) => halfDisk(Rbx, [
    ...zs.map((z, k) => ({ id: `coil${k + 1}`, type: 'rect' as const, x: [R - s / 2, R + s / 2] as [number, number], y: [z - s / 2, z + s / 2] as [number, number] })),
    // probe region around the centre (same air), for mesh refinement only
    { id: 'core', type: 'rect' as const, x: [0, 0.15 * R] as [number, number], y: [-0.15 * R, 0.15 * R] as [number, number] }]);
  const coilMesh = (Rbx: number, f: number) => mesh2d(coilGeo(Rbx), { hmax: Rbx / 4, grade: 0.25 * f, refine: [{ select: ['dom:coil1', 'dom:coil2'], h: (s / 2) * f, grade: 0.25 * f }, { select: ['dom:core'], h: (R / 40) * f, grade: 0.25 * f }], order: 2 });
  for (const [i, f] of [1, 0.5, 0.25].entries()) {
    const t0 = performance.now();
    const m = coilMesh(Rb, f);
    const tm = performance.now() - t0;
    const nc = nCells(m);
    const t1 = performance.now();
    const sol = await solveMagnetostatics({ mesh: m, muR: new Float64Array(nc).fill(muR), coils: [
      { id: 'c1', select: ['dom:coil1'], turns: 1, current: I }, { id: 'c2', select: ['dom:coil2'], turns: 1, current: I }],
      insulation: m.entities.boundaries.filter((b) => b.id.startsWith('bnd:far')).map((b) => b.id) });
    const wall = performance.now() - t1 + tm;
    const B0 = sample(sol, 'Bz', [0, 0])[0]!;
    let unif = 0;
    for (let q = 0; q <= 90; q++) {
      const th = (Math.PI * q) / 90, rr = 0.1 * R;
      const p = [rr * Math.sin(th), rr * Math.cos(th)];
      const B = Math.hypot(sample(sol, 'Br', p)[0]!, sample(sol, 'Bz', p)[0]!);
      unif = Math.max(unif, Math.abs(B - B0) / B0);
    }
    levels.push({ level: i, h: f, dof: sol.stats.dof, wall_ms: wall, stages: stages(sol.timing, { mesh: +tm.toFixed(1) }), values: {
      B_center: B0, Bz_probe: sample(sol, 'Bz', [0.02, 0.01])[0]!, Br_probe: sample(sol, 'Br', [0.02, 0.01])[0]!, 'uniformity_sphere_0.1R': unif } });
  }
  const res = fin('EM-04 Helmholtz coil (R_b = 100 R, s = R/100)', levels, targets);
  const b = res.find((r) => r.target === 'B_center')!;
  console.log(`  B_center vs finite-section reference: rel ${(((b.ext ?? b.fine) - Bfin) / Bfin).toExponential(3)}`);
  // truncation check: A = 0 on R_b = 30 R, finest level settings, vs the dipole-image shift of the case
  const m30 = coilMesh(30 * R, 0.25);
  const s30 = await solveMagnetostatics({ mesh: m30, muR: new Float64Array(nCells(m30)).fill(muR), coils: [
    { id: 'c1', select: ['dom:coil1'], turns: 1, current: I }, { id: 'c2', select: ['dom:coil2'], turns: 1, current: I }],
    insulation: m30.entities.boundaries.filter((x) => x.id.startsWith('bnd:far')).map((x) => x.id) });
  const sh = (sample(s30, 'Bz', [0, 0])[0]! - (b.ext ?? b.fine)) / ref;
  const trRef = expectedValue('EM-04', 'truncation.dirichlet_A.Rb30R').value;
  console.log(`  truncation R_b = 30 R: (B30 - B100)/B0 = ${sh.toExponential(4)} vs dipole image ${trRef.toExponential(4)} (+ 1.4e-6 at 100 R): ${Math.abs(sh - (trRef - expectedValue('EM-04', 'truncation.dirichlet_A.Rb100R').value)) <= 1e-5 ? 'PASS' : 'FAIL'} abs 1e-5`);
  log.write({ kind: 'truncation', id: 'EM-04', shift: sh, ref: trRef });
}

if (want('EM-03')) {
  // Palace rings.md (fetched 2026-11-06): r_a 10 um, r_b 100 um, w 1 um; analytic M_ab 1.973921, L_aa 41.78537, L_bb 707.2050 pH.
  const ra = 10e-6, rb = 100e-6, w = 1e-6;
  const Mfil = loopMutual(ra, rb, 0);
  const Lself = (r: number) => MU0 * r * (Math.log((16 * r) / w) - 1.75);
  console.log(`EM-03 references: Palace M_ab 1.973921 pH (mu0 pi ra^2/(2 rb) = ${(MU0 * Math.PI * ra * ra / (2 * rb) * 1e12).toFixed(6)} pH), filament elliptic M_ab ${(Mfil * 1e12).toFixed(6)} pH; L_aa formula ${(Lself(ra) * 1e12).toFixed(5)}, L_bb ${(Lself(rb) * 1e12).toFixed(4)} pH`);
  const targets: Target[] = [
    { id: 'M_ab', ref: Mfil, unit: 'H', rel: 5e-3 },
    { id: 'L_aa', ref: Lself(ra), unit: 'H', rel: 2e-2 },
    { id: 'L_bb', ref: Lself(rb), unit: 'H', rel: 2e-3 },
    { id: 'M_ab_palace', ref: 1.973921e-12, unit: 'H', rel: 2e-2, gate: false },
  ];
  const levels: Level[] = [];
  const Rb = 100 * rb;
  for (const [i, f] of [1, 0.5, 0.25].entries()) {
    const t0 = performance.now();
    const geo = halfDisk(Rb, [{ id: 'ra', type: 'circle', c: [ra, 0], r: w / 2 }, { id: 'rb', type: 'circle', c: [rb, 0], r: w / 2 }]);
    const m = mesh2d(geo, { hmax: Rb / 4, grade: 0.25 * f, refine: [{ select: ['dom:ra', 'dom:rb'], h: (w / 8) * f, grade: 0.25 * f }], order: 2 });
    const tm = performance.now() - t0;
    const nc = nCells(m);
    const t1 = performance.now();
    const sol = await solveMagnetostatics({ mesh: m, muR: new Float64Array(nc).fill(1), inductance: true, coils: [
      { id: 'a', select: ['dom:ra'], turns: 1, current: 1 }, { id: 'b', select: ['dom:rb'], turns: 1, current: 1 }],
      insulation: m.entities.boundaries.filter((b) => b.id.startsWith('bnd:far')).map((b) => b.id) });
    const wall = performance.now() - t1 + tm;
    const L = sol.L!;
    levels.push({ level: i, h: f, dof: sol.stats.dof, wall_ms: wall, stages: stages(sol.timing, { mesh: +tm.toFixed(1) }), values: { M_ab: L[1]!, L_aa: L[0]!, L_bb: L[3]!, M_ab_palace: L[1]! } });
    if (Math.abs(L[1]! - L[2]!) > 1e-9 * Math.abs(L[1]!)) console.log(`  warning: L not symmetric ${L[1]} ${L[2]}`);
  }
  fin('EM-03 Palace rings (axisym, round section w)', levels, targets);
}

if (want('EM-01')) {
  const c = readCase('a', 'EM-01');
  const a = c.geometry.spec.inner_radius_m as number, b = c.geometry.spec.outer_radius_m as number, er = c.materials.dielectric.eps_r as number;
  const ids = ['C_per_m', 'L_per_m', 'Z0'];
  const targets: Target[] = ids.map((id, j) => ({ id, ref: expectedValue('EM-01', id).value, unit: '', rel: c.references[j].tolerance.rel }));
  const levels: Level[] = [];
  for (const [i, f] of [1, 0.5, 0.25].entries()) {
    const t0 = performance.now();
    const geo = buildGeometry2D({ features: [{ id: 'outer', type: 'circle', c: [0, 0], r: b }, { id: 'inner', type: 'circle', c: [0, 0], r: a }, { id: 'diel', type: 'difference', target: 'outer', tools: ['inner'] }] });
    const m = mesh2d(geo, { hmax: ((b - a) / 3) * f, order: 2 });
    const tm = performance.now() - t0;
    const t1 = performance.now();
    const sol = await solveElectrostatics({ mesh: m, epsR: new Float64Array(nCells(m)).fill(er), terminals: [{ id: 'inner', select: ['bnd:inner.edge'] }], ground: ['bnd:outer.edge'], vacuum: true });
    const wall = performance.now() - t1 + tm;
    levels.push({ level: i, h: f, dof: sol.stats.dof, wall_ms: wall, stages: stages(sol.timing, { mesh: +tm.toFixed(1) }), values: { C_per_m: sol.scalars.C_per_m!.value, L_per_m: sol.scalars.L_per_m!.value, Z0: sol.scalars.Z0!.value } });
  }
  fin('EM-01 coax', levels, targets);
}

if (want('EM-02')) {
  // Palace spheres.md (fetched 2026-11-06): a 1 cm, b 2 cm, c 5 cm, vacuum; Lekner (2011) series; Palace's values
  // C_aa 1.230518, C_bb 2.431543, C_ab -0.4945668 pF. Series recomputed here (D).
  const a = 0.01, b = 0.02, cc = 0.05;
  const u = Math.acosh((cc * cc - a * a - b * b) / (2 * a * b));
  let Saa = 0, Sbb = 0, Sab = 0;
  for (let n = 0; n < 200; n++) {
    Saa += 1 / (a * Math.sinh(n * u) + b * Math.sinh((n + 1) * u));
    Sbb += 1 / (b * Math.sinh(n * u) + a * Math.sinh((n + 1) * u));
    if (n >= 1) Sab += 1 / Math.sinh(n * u);
  }
  const k4 = 4 * Math.PI * EPS0;
  const Caa = k4 * a * b * Math.sinh(u) * Saa, Cbb = k4 * a * b * Math.sinh(u) * Sbb, Cab = -k4 * ((a * b) / cc) * Math.sinh(u) * Sab;
  console.log(`EM-02 Lekner series (200 terms): C_aa ${(Caa * 1e12).toFixed(7)} C_bb ${(Cbb * 1e12).toFixed(7)} C_ab ${(Cab * 1e12).toFixed(8)} pF (Palace 1.230518, 2.431543, -0.4945668)`);
  const targets: Target[] = [{ id: 'C_aa', ref: Caa, unit: 'F', rel: 1e-3 }, { id: 'C_bb', ref: Cbb, unit: 'F', rel: 1e-3 }, { id: 'C_ab', ref: Cab, unit: 'F', rel: 1e-3 }];
  const Rout = 1000;  // grounded outer sphere: C_aa shift ~ a / Rout = 1e-5 (s.4.3)
  const levels: Level[] = [];
  for (const [i, f] of [1, 0.5, 0.25].entries()) {
    const t0 = performance.now();
    const geo = buildGeometry2D({ axisym: true, features: [
      { id: 'box', type: 'rect', x: [0, Rout], y: [-Rout, Rout] }, { id: 'far', type: 'circle', c: [0, 0], r: Rout },
      { id: 'air', type: 'intersection', inputs: ['box', 'far'] }, { id: 'sa', type: 'circle', c: [0, 0], r: a }, { id: 'sb', type: 'circle', c: [0, cc], r: b },
      { id: 'all', type: 'difference', target: 'air', tools: ['sa', 'sb'] }] });
    const m = mesh2d(geo, { hmax: Rout / 4, grade: 0.25 * f, refine: [{ select: ['bnd:sa.edge', 'bnd:sb.edge'], h: (a / 4) * f, grade: 0.25 * f }], order: 2 });
    const tm = performance.now() - t0;
    // the sphere interiors are not part of the field domain
    const epsR = new Float64Array(nCells(m)).fill(1);
    const bnd = (pre: string) => m.entities.boundaries.filter((x) => x.id.startsWith(pre)).map((x) => x.id);
    const t1 = performance.now();
    const sol = await solveElectrostatics({ mesh: m, epsR, terminals: [{ id: 'a', select: bnd('bnd:sa.') }, { id: 'b', select: bnd('bnd:sb.') }], ground: bnd('bnd:far.') });
    const wall = performance.now() - t1 + tm;
    if (i === 0) console.log(`  domains ${m.entities.domains.map((d) => d.id).join(', ')}; boundaries ${m.entities.boundaries.map((d) => d.id).join(', ')}`);
    levels.push({ level: i, h: f, dof: sol.stats.dof, wall_ms: wall, stages: stages(sol.timing, { mesh: +tm.toFixed(1) }), values: { C_aa: sol.C[0]!, C_bb: sol.C[3]!, C_ab: sol.C[1]! } });
  }
  fin('EM-02 Lekner spheres (axisym, R_out = 1000 m grounded)', levels, targets);
}
console.log(`\nlog: ${log.path}`);
