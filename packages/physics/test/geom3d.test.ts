// SPDX-License-Identifier: GPL-3.0-or-later
// Gates of the 3D layer stack (DevLog-044 s.1.6), end to end through prepareRun + runStudy. Coefficients are arbitrary
// test numbers, not material data. Each gate prints one `GEOM3D {json}` line (DOF, mesh and solve times, values).
//   (a) box as an extrude vs the existing single-box path (Kuhn tet10): linear heat and uniaxial elastic exact on both;
//       heat with a uniform source vs the triple sine series; elastic bending, both paths at two nested levels
//   (b) three-layer slab, flux in / T fixed: T exact (piecewise linear), tet10 and tet4
//   (c) TSV: (c1) via through the cell, isothermal ends: G = (k1 A1 + k2 A2) / t; (c2) blind via under a cap layer:
//       G between the variational bounds and equal to a 2D-axisymmetric run of the same r-z section
//   (d) mesh determinism: same hash and tagHash twice in one process and in a second Node process
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseYaml, type Mesh } from '@amp/spec';
import { meshFromSpec } from '@amp/mesh/spec';
import { resolveEntityIds } from '@amp/geom';
import { prepareRun, runStudy } from '../src/index.ts';
import { NPC } from '../src/common/mesh.ts';
import { defaultRule, gatherX, physGrad, physPoint, shapeTable } from '../src/common/lagrange.ts';

type Spec = Record<string, unknown>;
const y = (s: string) => parseYaml(s).data as Spec;

/** Spec of a TSV unit cell (round cell radius b, via radius a), layers as given, isothermal top / bottom. */
const tsvSpec = (o: { a: string; b: string; layers: string; hmax: string; mats: string }) => y(`
schema: amp-spec/0
id: g3d-tsv
title: TSV cell
geometry:
  dim: 3
  features:
    - {id: cell, type: circle, settings: {center: {value: [0, 0], unit: um}, radius: ${o.b}}}
    - {id: via, type: circle, settings: {center: {value: [0, 0], unit: um}, radius: ${o.a}}}
    - {id: si, type: difference, settings: {base: cell, tools: [via], keepTools: true}}
    - {id: cap, type: circle, settings: {center: {value: [0, 0], unit: um}, radius: ${o.b}}}
    - id: st
      type: extrude
      settings:
        layers: ${o.layers}
materials: ${o.mats}
physics:
  - id: ht
    type: heat
    select: ["dom:st"]
    bcs:
      - {id: hot, type: temperature, select: ["bnd:st.top"], settings: {T: 301 K}}
      - {id: cold, type: temperature, select: ["bnd:st.bottom"], settings: {T: 300 K}}
studies: [{id: s, type: stationary, physics: [ht]}]
mesh: {size: {hmax: ${o.hmax}}}
`);

async function solve(spec: Spec, hFactor = 1) {
  const prep = await prepareRun(spec, { hFactor });
  const t0 = performance.now();
  const sol = await runStudy(prep);
  return { prep, sol, mesh: prep.mesh as Mesh, solveMs: performance.now() - t0, meshMs: prep.timing.geometry_mesh!, dof: (sol.stats as { dof?: number }).dof ?? 0 };
}
const field = (sol: { fields: Array<{ name: string; data: Float64Array }> }, n: string) => sol.fields.find((f) => f.name === n)!.data;

/** Per-cell conductivity from the prepared materials (each domain selected by one material). */
function kCells(prep: Awaited<ReturnType<typeof prepareRun>>): Float64Array {
  const m = prep.mesh as Mesh;
  const kd = new Float64Array(m.entities.domains.length).fill(NaN);
  for (const mat of prep.spec.materials ?? []) for (const d of resolveEntityIds(m.entities, 'domains', mat.select).indices) kd[d] = prep.materials[mat.id]!.k!;
  return Float64Array.from(m.cells.domain, (d) => kd[d]!);
}

/** int k |grad T|^2 dV (axisym: 2 pi r dr dz) = Q dT for a Dirichlet pair (Galerkin energy identity). */
function dissipation(m: Mesh, T: Float64Array, k: Float64Array): number {
  const type = m.cells.type, nn = NPC[type], dim = m.dim, axi = !!m.axisym;
  const ord = type === 'tet10' || type === 'tri6' ? 2 : 1;
  const rule = defaultRule(type, 2 * ord + (axi ? 1 : 0)), t = shapeTable(type, rule);
  const X = new Float64Array(nn * dim), G = new Float64Array(nn * dim), P = new Float64Array(dim), g = new Float64Array(dim);
  let s = 0;
  for (let c = 0; c < m.cells.domain.length; c++) {
    gatherX(m.nodes, dim, m.cells.conn, c, nn, X);
    for (let q = 0; q < rule.n; q++) {
      let w = rule.wts[q]! * physGrad(t, q, X, dim, G);
      if (axi) { physPoint(t, q, X, dim, P); w *= 2 * Math.PI * P[0]!; }
      g.fill(0);
      for (let a = 0; a < nn; a++) for (let d = 0; d < dim; d++) g[d]! += T[m.cells.conn[nn * c + a]!]! * G[dim * a + d]!;
      let gg = 0;
      for (let d = 0; d < dim; d++) gg += g[d]! * g[d]!;
      s += k[c]! * gg * w;
    }
  }
  return s;
}
const log = (gate: string, o: Record<string, unknown>) => console.log(`GEOM3D ${JSON.stringify({ gate, ...o })}`);

// (d) child process: print the hash of the TSV stack mesh and exit (used by gate d)
const DSPEC = () => tsvSpec({ a: '5 um', b: '20 um', hmax: '4 um', layers: '[{id: sub, thickness: 50 um, sketch: [si, via]}, {id: lid, thickness: 10 um, sketch: [cap]}]', mats: '[]' });
if (process.env.GEOM3D_HASH_CHILD) {
  for (const order of [1, 2] as const) { const m = meshFromSpec(DSPEC(), { order }); console.log(`${m.hash} ${m.tagHash}`); }
  process.exit(0);
}

// ------------------------------------------------------------------------------------------------------ (a)

const LX = 1e-3, LY = 0.6e-3, LZ = 0.4e-3;
const boxGeo = (stack: boolean) => (stack ? `
  dim: 3
  features:
    - {id: sq, type: rect, settings: {size: {value: [1, 0.6], unit: mm}, center: {value: [0.5, 0.3], unit: mm}}}
    - {id: st, type: extrude, settings: {layers: [{id: L0, thickness: 0.4 mm, sketch: [sq]}]}}` : `
  dim: 3
  features:
    - {id: sq, type: box, settings: {size: {value: [1, 0.6, 0.4], unit: mm}, center: {value: [0.5, 0.3, 0.2], unit: mm}}}`);
// face names: box xmin..zmax; stack: rect sides (left = xmin, right = xmax, bottom = ymin, top = ymax) and caps
const F = (stack: boolean) => (stack
  ? { xmin: 'bnd:sq.left', xmax: 'bnd:sq.right', ymin: 'bnd:sq.bottom', ymax: 'bnd:sq.top', zmin: 'bnd:st.bottom', zmax: 'bnd:st.top', dom: 'dom:sq.L0' }
  : { xmin: 'bnd:sq.xmin', xmax: 'bnd:sq.xmax', ymin: 'bnd:sq.ymin', ymax: 'bnd:sq.ymax', zmin: 'bnd:sq.zmin', zmax: 'bnd:sq.zmax', dom: 'dom:sq' });
const heatBox = (stack: boolean, bcs: string, src = '') => {
  const f = F(stack);
  return y(`
schema: amp-spec/0
id: g3d-box
title: box
geometry: ${boxGeo(stack)}
materials: [{id: m, select: ["${f.dom}"], override: {k: 10 W/(m*K)}}]
physics:
  - id: ht
    type: heat
    select: ["${f.dom}"]
    bcs: ${bcs.replace(/\$(\w+)/g, (_, k) => (f as Record<string, string>)[k]!)}${src}
studies: [{id: s, type: stationary, physics: [ht]}]
mesh: {size: {hmax: 0.1 mm}}
`);
};

test('geom3d (a1): box as extrude, linear heat exact on both paths', async () => {
  for (const stack of [false, true]) {
    const r = await solve(heatBox(stack, `[{id: a, type: temperature, select: ["$xmin"], settings: {T: 400 K}}, {id: b, type: temperature, select: ["$xmax"], settings: {T: 300 K}}]`));
    const T = field(r.sol, 'T'), X = r.mesh.nodes;
    let e = 0;
    for (let i = 0; i < T.length; i++) e = Math.max(e, Math.abs(T[i]! - (400 - (100 * X[3 * i]!) / LX)));
    log('a1-heat-linear', { path: stack ? 'extrude' : 'box', cell: r.mesh.cells.type, cells: r.mesh.cells.domain.length, dof: r.dof, maxErrK: e, meshMs: +r.meshMs.toFixed(1), solveMs: +r.solveMs.toFixed(1) });
    assert.ok(e < 1e-9, `max |T - T_exact| ${e} K`);
  }
});

/** T at the centre of a box with uniform source Q, T = 0 on every face: triple sine series (odd l, m, n < 2 nMax). */
function boxSourceCentre(Q: number, k: number, a: number, b: number, c: number, nMax = 400): number {
  let s = 0;
  for (let l = 1; l < 2 * nMax; l += 2) for (let m = 1; m < 2 * nMax; m += 2) for (let n = 1; n < 2 * nMax; n += 2) {
    const lam = Math.PI ** 2 * ((l / a) ** 2 + (m / b) ** 2 + (n / c) ** 2);
    const sg = ((l - 1) / 2 + (m - 1) / 2 + (n - 1) / 2) % 2 === 0 ? 1 : -1;
    s += (sg * 64) / (Math.PI ** 3 * l * m * n * lam);
  }
  return (Q / k) * s;
}

test('geom3d (a2): box as extrude, uniform source vs the sine series; both paths converge to it', async () => {
  const Q = 1e10, k = 10;
  const ref = 300 + boxSourceCentre(Q, k, LX, LY, LZ, 320);   // truncation: 160 -> 320 terms changes it by 2.6e-6 K
  const out: Record<string, number[]> = {};
  for (const stack of [false, true]) {
    out[stack ? 'extrude' : 'box'] = [];
    for (const hf of [1, 0.5]) {
      const r = await solve(heatBox(stack, `[{id: w, type: temperature, select: ["$xmin", "$xmax", "$ymin", "$ymax", "$zmin", "$zmax"], settings: {T: 300 K}}, {id: q, type: heat-source, select: ["$dom"], settings: {Q: 1e10 W/m^3}}]`), hf);
      const Tm = r.sol.scalars.T_max!.value;
      out[stack ? 'extrude' : 'box']!.push(Tm);
      log('a2-heat-source', { path: stack ? 'extrude' : 'box', hFactor: hf, cells: r.mesh.cells.domain.length, dof: r.dof, T_max: Tm, T_ref: ref, relErrRise: (Tm - ref) / (ref - 300), meshMs: +r.meshMs.toFixed(1), solveMs: +r.solveMs.toFixed(1) });
    }
  }
  const rise = ref - 300;
  for (const [p, v] of Object.entries(out)) {
    const e0 = Math.abs(v[0]! - ref), e1 = Math.abs(v[1]! - ref);
    assert.ok(e1 < e0 && e1 < 2e-3 * rise, `${p}: errors ${e0}, ${e1} K (rise ${rise} K)`);
  }
  const d0 = Math.abs(out.extrude![0]! - out.box![0]!), d1 = Math.abs(out.extrude![1]! - out.box![1]!);
  log('a2-difference', { dTmax_h: d0, dTmax_h2: d1, rise });
  assert.ok(d1 < d0, `path difference does not shrink: ${d0} -> ${d1} K`);
});

const elasticBox = (stack: boolean, bcs: string) => {
  const f = F(stack);
  return y(`
schema: amp-spec/0
id: g3d-box-el
title: box elastic
geometry: ${boxGeo(stack)}
materials: [{id: m, select: ["${f.dom}"], override: {E: 100 GPa, nu: 0.3, alpha: 0 1/K}}]
physics:
  - id: solid
    type: elastic
    select: ["${f.dom}"]
    settings: {model: 3d}
    bcs: ${bcs.replace(/\$(\w+)/g, (_, k) => (f as Record<string, string>)[k]!)}
studies: [{id: s, type: stationary, physics: [solid]}]
mesh: {size: {hmax: 0.2 mm}}
`);
};

test('geom3d (a3): box as extrude, uniaxial stress exact on both paths', async () => {
  const E = 100e9, nu = 0.3, sx = 50e6;
  for (const stack of [false, true]) {
    const r = await solve(elasticBox(stack, `[{id: rx, type: roller, select: ["$xmin"]}, {id: ry, type: roller, select: ["$ymin"]}, {id: rz, type: roller, select: ["$zmin"]}, {id: t, type: boundary-load, select: ["$xmax"], settings: {traction: {value: [50, 0, 0], unit: MPa}}}]`));
    const u = field(r.sol, 'u'), X = r.mesh.nodes;
    let e = 0;
    for (let i = 0; i < X.length / 3; i++) {
      const ex = [(sx * X[3 * i]!) / E, (-nu * sx * X[3 * i + 1]!) / E, (-nu * sx * X[3 * i + 2]!) / E];
      for (let d = 0; d < 3; d++) e = Math.max(e, Math.abs(u[3 * i + d]! - ex[d]!));
    }
    const ref = (sx * LX) / E;
    log('a3-elastic-uniaxial', { path: stack ? 'extrude' : 'box', cell: r.mesh.cells.type, dof: r.dof, maxErrRel: e / ref, meshMs: +r.meshMs.toFixed(1), solveMs: +r.solveMs.toFixed(1) });
    assert.ok(e < 1e-9 * ref, `max |u - u_exact| / u_ref ${e / ref}`);
  }
});

test('geom3d (a4): box as extrude, cantilever bending: paths agree to discretization error', async () => {
  const out: Record<string, number[]> = {};
  for (const stack of [false, true]) {
    out[stack ? 'extrude' : 'box'] = [];
    for (const hf of [1, 0.5]) {
      const r = await solve(elasticBox(stack, `[{id: c, type: fixed, select: ["$xmin"]}, {id: t, type: boundary-load, select: ["$xmax"], settings: {traction: {value: [0, 0, -10], unit: MPa}}}]`), hf);
      const um = r.sol.scalars.u_max!.value;
      out[stack ? 'extrude' : 'box']!.push(um);
      log('a4-elastic-bending', { path: stack ? 'extrude' : 'box', hFactor: hf, dof: r.dof, u_max: um, meshMs: +r.meshMs.toFixed(1), solveMs: +r.solveMs.toFixed(1) });
    }
  }
  const b = out.box!, e = out.extrude!;
  const step = Math.abs(b[1]! - b[0]!), diff1 = Math.abs(e[1]! - b[1]!) / b[1]!;
  log('a4-difference', { relDiff_h: Math.abs(e[0]! - b[0]!) / b[0]!, relDiff_h2: diff1, boxLevelChangeRel: step / b[1]! });
  // the paths differ by less than the box path's own change between the two levels (same order of accuracy)
  assert.ok(Math.abs(e[1]! - b[1]!) < step, `extrude vs box ${e[1]} / ${b[1]} m; box level change ${step} m`);
});

// ------------------------------------------------------------------------------------------------------ (b)

test('geom3d (b): three-layer slab, series resistance exact (tet10 via runStudy, tet4 via solveHeat)', async () => {
  const k = [150, 1.4, 400], t = [0.2e-3, 0.05e-3, 0.3e-3], q = 1e4, Ttop = 300;
  const spec = y(`
schema: amp-spec/0
id: g3d-stack3
title: three-layer slab
geometry:
  dim: 3
  features:
    - {id: sq, type: rect, settings: {size: {value: [1, 1], unit: mm}, center: {value: [0, 0], unit: mm}}}
    - id: st
      type: extrude
      settings:
        layers:
          - {id: a, thickness: 0.2 mm, sketch: [sq]}
          - {id: b, thickness: 0.05 mm, sketch: [sq]}
          - {id: c, thickness: 0.3 mm, sketch: [sq], nz: 3}
materials:
  - {id: ma, select: ["dom:st.a"], override: {k: 150 W/(m*K)}}
  - {id: mb, select: ["dom:st.b"], override: {k: 1.4 W/(m*K)}}
  - {id: mc, select: ["dom:st.c"], override: {k: 400 W/(m*K)}}
physics:
  - id: ht
    type: heat
    select: ["dom:st"]
    bcs:
      - {id: q, type: heat-flux, select: ["bnd:st.bottom"], settings: {q: 1e4 W/m^2}}
      - {id: t, type: temperature, select: ["bnd:st.top"], settings: {T: 300 K}}
studies: [{id: s, type: stationary, physics: [ht]}]
mesh: {size: {hmax: 0.25 mm}}
`);
  // exact: T(z) = Ttop + q * (resistance per area between z and the top)
  const z1 = t[0]!, z2 = z1 + t[1]!, z3 = z2 + t[2]!;
  const Tex = (z: number) => {
    const above = z >= z2 ? (z3 - z) / k[2]! : z >= z1 ? (z2 - z) / k[1]! + t[2]! / k[2]! : (z1 - z) / k[0]! + t[1]! / k[1]! + t[2]! / k[2]!;
    return Ttop + q * above;
  };
  const dT = Tex(0) - Ttop;
  const r = await solve(spec);
  const T = field(r.sol, 'T'), X = r.mesh.nodes;
  let e = 0;
  for (let i = 0; i < T.length; i++) e = Math.max(e, Math.abs(T[i]! - Tex(X[3 * i + 2]!)));
  log('b-series', { cell: r.mesh.cells.type, cells: r.mesh.cells.domain.length, dof: r.dof, T_bottom: r.sol.scalars.T_max!.value, T_bottom_exact: Tex(0), maxErrRel: e / dT, meshMs: +r.meshMs.toFixed(1), solveMs: +r.solveMs.toFixed(1) });
  assert.ok(e < 1e-9 * dT, `max |T - T_exact| / dT ${e / dT}`);
  // tet4 (P1) on the same stack, module solve
  const { solveHeat } = await import('../src/heat/index.ts');
  const m1 = meshFromSpec(spec, { order: 1 });
  const kd = [150, 1.4, 400];
  const kc = Float64Array.from(m1.cells.domain, (d) => kd[d]!);
  const s1 = await solveHeat({ mesh: m1 as Mesh, k: kc, bcs: [{ type: 'heat-flux', select: ['bnd:st.bottom'], q }, { type: 'temperature', select: ['bnd:st.top'], T: Ttop }] });
  let e1 = 0;
  for (let i = 0; i < s1.T.length; i++) e1 = Math.max(e1, Math.abs(s1.T[i]! - Tex(m1.nodes[3 * i + 2]!)));
  log('b-series-tet4', { cell: m1.cells.type, cells: m1.cells.domain.length, maxErrRel: e1 / dT });
  assert.ok(e1 < 1e-9 * dT, `tet4: max |T - T_exact| / dT ${e1 / dT}`);
});

// ------------------------------------------------------------------------------------------------------ (c)

const KV = 400, KM = 10;   // via / matrix conductivity (test numbers, contrast 40)
const MATS = `[{id: cu, select: ["dom:via"], override: {k: ${KV} W/(m*K)}}, {id: mx, select: ["dom:si", "dom:cap"], override: {k: ${KM} W/(m*K)}}]`;
const MATS1 = `[{id: cu, select: ["dom:via"], override: {k: ${KV} W/(m*K)}}, {id: mx, select: ["dom:si"], override: {k: ${KM} W/(m*K)}}]`;

test('geom3d (c1): via through the cell, isothermal ends: G = (k_v A_v + k_m A_m) / t (T linear in z)', async () => {
  const a = 5e-6, b = 20e-6, t = 50e-6;
  const Gex = (KV * Math.PI * a * a + KM * Math.PI * (b * b - a * a)) / t;
  {
    const hf = 1;
    const r = await solve(tsvSpec({ a: '5 um', b: '20 um', hmax: '4 um', layers: '[{id: sub, thickness: 50 um, sketch: [si, via]}]', mats: MATS1 }), hf);
    const T = field(r.sol, 'T'), X = r.mesh.nodes;
    let e = 0;
    for (let i = 0; i < T.length; i++) e = Math.max(e, Math.abs(T[i]! - (300 + X[3 * i + 2]! / t)));
    const G = dissipation(r.mesh, T, kCells(r.prep));   // dT = 1 K
    log('c1-through-via', { hFactor: hf, cell: r.mesh.cells.type, cells: r.mesh.cells.domain.length, dof: r.dof, G_WperK: G, G_exact: Gex, relErr: G / Gex - 1, maxErrTlinearK: e, meshMs: +r.meshMs.toFixed(1), solveMs: +r.solveMs.toFixed(1) });
    assert.ok(e < 1e-9, `T not linear in z: ${e} K`);
    // the only error is the P2 representation of the circular walls (via cross-section area)
    assert.ok(Math.abs(G / Gex - 1) < 1e-4, `G ${G} vs ${Gex}`);
  }
});

test('geom3d (c2): blind via under a cap layer: G between the variational bounds, equal to the axisymmetric run', async () => {
  const a = 5e-6, b = 20e-6, t1 = 50e-6, t2 = 10e-6;
  const Av = Math.PI * a * a, A = Math.PI * b * b, Am = A - Av;
  // upper bound: an isothermal plane at the interface (Dirichlet principle); lower: an adiabatic wall at r = a
  // through both layers (Thomson principle); derivation in DevLog-044 s.3
  const Gup = 1 / (t1 / (KV * Av + KM * Am) + t2 / (KM * A));
  const Glo = Av / (t1 / KV + t2 / KM) + (KM * Am) / (t1 + t2);
  const G3: number[] = [];
  for (const hf of [1, 0.5]) {
    const r = await solve(tsvSpec({ a: '5 um', b: '20 um', hmax: '5 um', layers: '[{id: sub, thickness: 50 um, sketch: [si, via], dz: 10 um}, {id: lid, thickness: 10 um, sketch: [cap]}]', mats: MATS }), hf);
    const G = dissipation(r.mesh, field(r.sol, 'T'), kCells(r.prep));
    G3.push(G);
    log('c2-blind-via-3d', { hFactor: hf, cell: r.mesh.cells.type, cells: r.mesh.cells.domain.length, dof: r.dof, G_WperK: G, meshMs: +r.meshMs.toFixed(1), solveMs: +r.solveMs.toFixed(1) });
  }
  // the same r-z section with the existing axisymmetric heat solver
  const axi = y(`
schema: amp-spec/0
id: g3d-tsv-axi
title: TSV cell axisym
geometry:
  dim: 2
  axisym: true
  features:
    - {id: via, type: rect, settings: {size: {value: [5, 50], unit: um}, center: {value: [2.5, 25], unit: um}}}
    - {id: si, type: rect, settings: {size: {value: [15, 50], unit: um}, center: {value: [12.5, 25], unit: um}}}
    - {id: cap, type: rect, settings: {size: {value: [20, 10], unit: um}, center: {value: [10, 55], unit: um}}}
materials: ${MATS}
physics:
  - id: ht
    type: heat
    select: ["dom:via", "dom:si", "dom:cap"]
    bcs:
      - {id: hot, type: temperature, select: ["bnd:cap.top"], settings: {T: 301 K}}
      - {id: cold, type: temperature, select: ["bnd:via.bottom", "bnd:si.bottom"], settings: {T: 300 K}}
studies: [{id: s, type: stationary, physics: [ht]}]
mesh: {size: {hmax: 1 um}}
`);
  const Ga: number[] = [];
  for (const hf of [1, 0.5]) {
    const r = await solve(axi, hf);
    const G = dissipation(r.mesh, field(r.sol, 'T'), kCells(r.prep));
    Ga.push(G);
    log('c2-blind-via-axisym', { hFactor: hf, cell: r.mesh.cells.type, cells: r.mesh.cells.domain.length, dof: r.dof, G_WperK: G, solveMs: +r.solveMs.toFixed(1) });
  }
  const rel = G3[1]! / Ga[1]! - 1;
  log('c2-summary', { G_lower: Glo, G_upper: Gup, G3d: G3, Gaxi: Ga, rel3dVsAxi: rel, rel3dLevelChange: G3[1]! / G3[0]! - 1, relAxiLevelChange: Ga[1]! / Ga[0]! - 1 });
  for (const G of [...G3, ...Ga]) assert.ok(G > Glo && G < Gup, `G ${G} outside [${Glo}, ${Gup}]`);
  assert.ok(Math.abs(rel) < 2e-3, `3D vs axisym ${rel}`);
  assert.ok(Math.abs(G3[1]! / Ga[1]! - 1) < Math.abs(G3[0]! / Ga[1]! - 1), '3D does not approach the axisymmetric value');
});

// ------------------------------------------------------------------------------------------------------ (d)

test('geom3d (d): mesh determinism (same hash and tagHash twice, and in a second Node process)', () => {
  const lines: string[] = [];
  for (const order of [1, 2] as const) {
    const t0 = performance.now();
    const m1 = meshFromSpec(DSPEC(), { order });
    const ms = performance.now() - t0;
    const m2 = meshFromSpec(DSPEC(), { order });
    assert.equal(m1.hash, m2.hash);
    assert.equal(m1.tagHash, m2.tagHash);
    lines.push(`${m1.hash} ${m1.tagHash}`);
    log('d-determinism', { order, cell: m1.cells.type, nodes: m1.nodes.length / 3, cells: m1.cells.domain.length, hash: m1.hash.slice(0, 16), meshMs: +ms.toFixed(1) });
  }
  const out = execFileSync(process.execPath, ['--max-old-space-size=1536', fileURLToPath(import.meta.url)], { env: { ...process.env, GEOM3D_HASH_CHILD: '1' }, encoding: 'utf8' });
  assert.deepEqual(out.trim().split('\n').filter((l) => /^[0-9a-f]{64} /.test(l)), lines);
});

// ------------------------------------------------------------------------------------------------------ (e)

test('geom3d (e1): acoustics on an extruded box: rigid-box modes f = (c/2) sqrt((l/Lx)^2 + (m/Ly)^2 + (n/Lz)^2)', async () => {
  const r = await solve(y(`
schema: amp-spec/0
id: g3d-room
title: room as extrude
geometry:
  dim: 3
  features:
    - {id: fl, type: rect, settings: {size: {value: [1.0, 0.8], unit: m}, center: {value: [0.5, 0.4], unit: m}}}
    - {id: st, type: extrude, settings: {layers: [{id: air, thickness: 0.6 m, sketch: [fl]}]}}
materials:
  - {id: air, override: {c: {value: 343, unit: m/s}, rho: {value: 1.2, unit: kg/m^3}}, select: ["dom:st"]}
physics:
  - id: ac
    type: acoustics
    select: ["dom:st"]
    bcs: [{id: walls, type: sound-hard, select: ["bnd:fl.left", "bnd:fl.right", "bnd:fl.bottom", "bnd:fl.top", "bnd:st.top", "bnd:st.bottom"]}]
mesh: {size: {hmax: 0.2 m}}
studies: [{id: eig, type: eigen, physics: [ac], settings: {nModes: 5}}]
`));
  const ex = [[1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1]].map(([l, m, n]) => (343 / 2) * Math.hypot(l! / 1.0, m! / 0.8, n! / 0.6)).sort((a, b) => a - b);
  const f = [1, 2, 3, 4].map((i) => r.sol.scalars[`f_${i}`]!.value);
  const rel = f.map((v, i) => v / ex[i]! - 1);
  log('e1-acoustics-box', { cell: r.mesh.cells.type, cells: r.mesh.cells.domain.length, dof: r.dof, f_Hz: f, exact_Hz: ex, rel, solveMs: +r.solveMs.toFixed(1) });
  for (const e of rel) assert.ok(Math.abs(e) < 2e-3, `rel ${rel}`);
});

test('geom3d (e2): emw on an extruded disk (PEC cylinder cavity): TM010 = x01 c0 / (2 pi a sqrt(eps_r))', async () => {
  const a = 0.0274, epsr = 2.08, x01 = 2.404825557695773, c0 = 299792458;
  const r = await solve(y(`
schema: amp-spec/0
id: g3d-cav
title: cavity as extrude
geometry:
  dim: 3
  features:
    - {id: disk, type: circle, settings: {center: {value: [0, 0], unit: m}, radius: 2.74 cm}}
    - {id: st, type: extrude, settings: {layers: [{id: L0, thickness: 5.48 cm, sketch: [disk]}]}}
materials:
  - {id: fill, override: {eps_r: 2.08, tan_delta: 0, mu_r: 1}, select: ["dom:st"]}
physics:
  - id: rf
    type: emw
    select: ["dom:st"]
    bcs: [{id: walls, type: pec, select: ["bnd:disk.edge", "bnd:st.top", "bnd:st.bottom"]}]
mesh: {size: {hmax: 0.00685 m}}
studies: [{id: eig, type: eigen, physics: [rf], settings: {nModes: 2, shift: 2.5 GHz}}]
`));
  const f0 = r.sol.scalars.f_0!.value, ex = (x01 * c0) / (2 * Math.PI * a * Math.sqrt(epsr));
  log('e2-emw-cavity', { cell: r.mesh.cells.type, cells: r.mesh.cells.domain.length, dof: r.dof, f0_Hz: f0, exact_Hz: ex, rel: f0 / ex - 1, solveMs: +r.solveMs.toFixed(1) });
  assert.ok(Math.abs(f0 / ex - 1) < 1e-3, `TM010 ${f0} vs ${ex}`);
});
