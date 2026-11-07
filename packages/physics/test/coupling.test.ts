// SPDX-License-Identifier: GPL-3.0-or-later
// Lane MC gates (DevLog-031 s.1.3): study driver, DC currents, joule-heating and thermal-expansion couplings.
// Values marked "test input" are nominal numbers chosen for the check, not material data; eval-case values are read
// from eval/cases and eval/expected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseSpecText } from '@amp/spec';
import { physicsRegistry, prepareRun, runStudy, studyReadiness, registry, COUPLINGS, type CouplingImpl } from '../src/index.ts';
import { evalPoint, integrate, sample } from '../../post/src/index.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const q = (value: number | number[], unit: string) => ({ value, unit });
const rel = (a: number, b: number) => Math.abs(a - b) / Math.abs(b);
type Spec = Record<string, unknown>;
const run = async (spec: Spec) => { const p = await prepareRun(spec, { library: null }); return { p, sol: await runStudy(p) }; };

// ------------------------------------------------------------------------------------------------- currents

/** 3D bar resistor, L x W x t, sigma: R = L / (sigma W t). Test inputs (nominal). */
const barSpec = (term: Record<string, unknown>, ref: Record<string, unknown>): Spec => ({
  schema: 'amp-spec/0', id: 'bar', title: 'bar',
  geometry: { dim: 3, features: [{ id: 'bar', type: 'box', settings: { size: q([0.1, 0.01, 0.002], 'm'), center: q([0.05, 0.005, 0.001], 'm') } }] },
  materials: [{ id: 'cond', override: { sigma: q(1e6, 'S/m') }, select: ['dom:bar'] }],
  physics: [{ id: 'cur', type: 'currents', select: ['dom:bar'], bcs: [
    { id: 't1', type: 'terminal', select: ['bnd:bar.xmax'], settings: term }, { ...ref, select: ['bnd:bar.xmin'] },
    { id: 'ins', type: 'insulation', select: ['bnd:bar.ymin', 'bnd:bar.ymax', 'bnd:bar.zmin', 'bnd:bar.zmax'] }] }],
  mesh: { size: { hmax: q(0.005, 'm') } },
  studies: [{ id: 'std1', type: 'stationary', physics: ['cur'] }],
});

test('currents 3D tet10 bar, current terminal: V = I R, R = L / (sigma W t), P = I^2 R', async () => {
  const L = 0.1, W = 0.01, t = 0.002, sigma = 1e6, I = 2;
  const R = L / (sigma * W * t);
  const { sol } = await run(barSpec({ I: q(I, 'A') }, { id: 'gnd', type: 'ground' }));
  const s = sol.scalars;
  console.log(`bar R ${s.R_t1!.value} Ohm vs ${R} (rel ${rel(s.R_t1!.value, R)}), V ${s.V_t1!.value} V vs ${I * R}, P ${s.P!.value} W vs ${I * I * R} (rel ${rel(s.P!.value, I * I * R)})`);
  assert.ok(rel(s.R_t1!.value, R) < 1e-9, `R ${s.R_t1!.value} vs ${R}`);
  assert.ok(rel(s.V_t1!.value, I * R) < 1e-9, `V ${s.V_t1!.value}`);
  assert.ok(rel(s.I_t1!.value, I) < 1e-9, `I ${s.I_t1!.value}`);
  assert.ok(rel(s.P!.value, I * I * R) < 1e-9, `P ${s.P!.value} vs ${I * I * R}`);
  // uniform Q = I^2 R / volume in every cell
  const Q = sol.fields.find((f) => f.name === 'Q')!.data;
  const q0 = (I * I * R) / (L * W * t);
  for (const v of Q) assert.ok(rel(v, q0) < 1e-8);
  assert.equal(s.P!.unit, 'W');
});

test('currents 3D bar: current terminal against a potential boundary (superposition): V_t = V_p + I R', async () => {
  const R = 0.1 / (1e6 * 0.01 * 0.002), I = 2, Vp = 0.5;
  const { sol } = await run(barSpec({ I: q(I, 'A') }, { id: 'pot', type: 'potential', settings: { V: q(Vp, 'V') } }));
  assert.ok(rel(sol.scalars.V_t1!.value, Vp + I * R) < 1e-9, `V ${sol.scalars.V_t1!.value}`);
  assert.ok(rel(sol.scalars.I_t1!.value, I) < 1e-9);
});

test('currents axisym rod, voltage terminal: I = V sigma pi r^2 / L', async () => {
  const r = 1e-3, L = 0.01, sigma = 5e5, V = 0.1;   // test inputs
  const spec: Spec = {
    schema: 'amp-spec/0', id: 'rod', title: 'rod',
    geometry: { dim: 2, axisym: true, features: [{ id: 'rod', type: 'rect', settings: { size: q([r, L], 'm'), center: q([r / 2, L / 2], 'm') } }] },
    materials: [{ id: 'cond', override: { sigma: q(sigma, 'S/m') }, select: ['dom:rod'] }],
    physics: [{ id: 'cur', type: 'currents', select: ['dom:rod'], bcs: [
      { id: 'top', type: 'terminal', select: ['bnd:rod.top'], settings: { V: q(V, 'V') } }, { id: 'gnd', type: 'ground', select: ['bnd:rod.bottom'] }] }],
    mesh: { size: { hmax: q(r / 3, 'm') } },
    studies: [{ id: 'std1', type: 'stationary', physics: ['cur'] }],
  };
  const { sol } = await run(spec);
  const Iex = (V * sigma * Math.PI * r * r) / L;
  console.log(`rod I ${sol.scalars.I_top!.value} A vs ${Iex} (rel ${rel(sol.scalars.I_top!.value, Iex)})`);
  assert.ok(rel(sol.scalars.I_top!.value, Iex) < 1e-9, `I ${sol.scalars.I_top!.value} vs ${Iex}`);
  assert.ok(rel(sol.scalars.R_top!.value, V / Iex) < 1e-9);
  assert.ok(rel(sol.scalars.P!.value, V * Iex) < 1e-9);
});

test('currents axisym annulus, radial current: I = 2 pi sigma H V / ln(r2 / r1); integral of the cell-mean Q = P', async () => {
  const r1 = 1e-3, r2 = 4e-3, H = 2e-3, sigma = 1e3, V = 1;   // test inputs
  const spec: Spec = {
    schema: 'amp-spec/0', id: 'ann', title: 'ann',
    geometry: { dim: 2, axisym: true, features: [{ id: 'a', type: 'rect', settings: { size: q([r2 - r1, H], 'm'), center: q([(r1 + r2) / 2, H / 2], 'm') } }] },
    materials: [{ id: 'cond', override: { sigma: q(sigma, 'S/m') }, select: ['dom:a'] }],
    physics: [{ id: 'cur', type: 'currents', select: ['dom:a'], bcs: [
      { id: 'in', type: 'terminal', select: ['bnd:a.left'], settings: { V: q(V, 'V') } }, { id: 'gnd', type: 'ground', select: ['bnd:a.right'] }] }],
    mesh: { size: { hmax: q(2e-4, 'm') } },
    studies: [{ id: 'std1', type: 'stationary', physics: ['cur'] }],
  };
  const { p, sol } = await run(spec);
  const Iex = (2 * Math.PI * sigma * H * V) / Math.log(r2 / r1);
  const Pq = integrate(p.mesh, sol.fields.find((f) => f.name === 'Q')!, { revolve: true })[0]!;
  console.log(`annulus I ${sol.scalars.I_in!.value} A vs ${Iex} (rel ${rel(sol.scalars.I_in!.value, Iex)}); int Q dV ${Pq} W vs P ${sol.scalars.P!.value} W (rel ${rel(Pq, sol.scalars.P!.value)})`);
  assert.ok(rel(sol.scalars.I_in!.value, Iex) < 1e-5);
  assert.ok(rel(Pq, sol.scalars.P!.value) < 1e-10);
  assert.ok(rel(sol.scalars.P!.value, V * sol.scalars.I_in!.value) < 1e-10);
});

test('currents 2D with thickness: R = L / (sigma W t); per unit depth without thickness', async () => {
  const L = 0.02, W = 0.004, t = 1e-6, sigma = 2e7, I = 0.01;   // test inputs (thin film strip)
  const mk = (thk: boolean, term: Record<string, unknown>): Spec => ({
    schema: 'amp-spec/0', id: 'film', title: 'film',
    geometry: { dim: 2, features: [{ id: 'f', type: 'rect', settings: { size: q([L, W], 'm'), center: q([L / 2, W / 2], 'm') } }] },
    materials: [{ id: 'cond', override: { sigma: q(sigma, 'S/m') }, select: ['dom:f'] }],
    physics: [{ id: 'cur', type: 'currents', select: ['dom:f'], ...(thk ? { settings: { thickness: q(t, 'm') } } : {}), bcs: [
      { id: 'a', type: 'terminal', select: ['bnd:f.right'], settings: term }, { id: 'g', type: 'ground', select: ['bnd:f.left'] }] }],
    mesh: { size: { hmax: q(W / 2, 'm') } },
    studies: [{ id: 'std1', type: 'stationary', physics: ['cur'] }],
  });
  const a = (await run(mk(true, { I: q(I, 'A') }))).sol;
  assert.ok(rel(a.scalars.R_a!.value, L / (sigma * W * t)) < 1e-9);
  assert.ok(rel(a.scalars.V_a!.value, (I * L) / (sigma * W * t)) < 1e-9);
  const b = (await run(mk(false, { V: q(1, 'V') }))).sol;
  assert.equal(b.scalars.R_a!.unit, 'Ohm*m');
  assert.ok(rel(b.scalars.R_a!.value, L / (sigma * W)) < 1e-9);
  // a current terminal in 2D without thickness is a readiness reason
  const sp = parseSpecText(JSON.stringify(mk(false, { I: q(I, 'A') })), physicsRegistry());
  assert.ok(sp.spec);
  const rd = studyReadiness(sp.spec!);
  assert.ok(!rd.ready && rd.reasons.some((x) => x.includes('thickness')), rd.reasons.join('; '));
});

// ------------------------------------------------------------------------------------------------- joule heating

test('joule-heating: CP-03 coupled variant (currents -> heat) reproduces the CP-03 closed form', async () => {
  const text = readFileSync(`${root}sims/heated-wire.yaml`, 'utf8');
  const parsed = parseSpecText(text, physicsRegistry());
  assert.ok(parsed.ok && parsed.data);
  const spec = structuredClone(parsed.data) as Spec & { params: Record<string, { value: number }>; materials: Array<{ override: Record<string, unknown> }>; physics: Array<{ id: string; bcs: Array<{ id: string }> }>; studies: Array<{ physics: string[] }> };
  const qgen = spec.params.q_gen!.value, Lz = spec.params.Lz!.value;
  // test input: sigma; V0 so that sigma (V0 / Lz)^2 = q_gen of CP-03 (uniform E along the wire)
  const sigma = 1e6;
  const V0 = Lz * Math.sqrt(qgen / sigma);
  spec.materials[0]!.override.sigma = q(sigma, 'S/m');
  spec.physics[0]!.bcs = spec.physics[0]!.bcs.filter((b) => b.id !== 'gen');
  spec.physics.unshift({ id: 'cur', type: 'currents', select: ['dom:wire'], bcs: [
    { id: 'top', type: 'terminal', select: ['bnd:wire.top'], settings: { V: q(V0, 'V') } },
    { id: 'gnd', type: 'ground', select: ['bnd:wire.bottom'] },
    { id: 'ins', type: 'insulation', select: ['bnd:wire.right'] }] } as never);
  (spec as Spec).couplings = [{ id: 'jh', type: 'joule-heating', from: 'cur', to: 'ht' }];
  spec.studies[0]!.physics = ['ht', 'cur'];   // listed out of order on purpose: the driver orders by the coupling
  const exp = JSON.parse(readFileSync(`${root}eval/expected/CP-03.json`, 'utf8')) as { targets: Array<{ metric_id: string; value: number }> };
  const ref = (id: string) => exp.targets.find((t) => t.metric_id === id)!.value;
  const { sol } = await run(spec);
  assert.deepEqual([...new Set(sol.fields.map((f) => f.physics))], ['cur', 'ht']);
  const Tc = sol.scalars['ht.T_max']!.value, Ts = sol.scalars['ht.T_min']!.value;
  console.log(`CP-03 coupled: T_center ${Tc} K vs ${ref('T_center')} (rel ${rel(Tc, ref('T_center'))}), T_surface ${Ts} K vs ${ref('T_surface')} (rel ${rel(Ts, ref('T_surface'))}), V0 ${V0} V, dof ${sol.stats.dof}`);
  assert.ok(rel(Tc, ref('T_center')) < 1e-9, `T_center ${Tc} vs ${ref('T_center')}`);
  assert.ok(rel(Ts, ref('T_surface')) < 1e-9, `T_surface ${Ts} vs ${ref('T_surface')}`);
  // unique bare names are kept; the Joule power is q_gen times the wire volume
  assert.equal(sol.scalars.T_max!.value, Tc);
  const r0 = spec.params.r0!.value;
  assert.ok(rel(sol.scalars['cur.P']!.value, qgen * Math.PI * r0 * r0 * Lz) < 1e-9);
  // post resolves <physics id>.<name> against the tags
  const T = evalPoint(sol, 'ht.T', [[0, Lz / 2]], { snap: 1e-6 });
  assert.ok(rel(T.values[0]!, ref('T_center')) < 1e-9);
  const Qv = evalPoint(sol, 'cur.Q', [[r0 / 2, Lz / 2]]);
  assert.ok(rel(Qv.values[0]!, qgen) < 1e-9);
  assert.equal(sol.stats.byPhysics?.cur?.solver !== undefined, true);
});

// ------------------------------------------------------------------------------------------------- thermal expansion

/** Rect plate heated uniformly (temperature BC on every boundary, no source): T = T1 everywhere. Test inputs. */
test('thermal-expansion: free uniform heating, plane stress 2D and 3D tet10: zero stress, u = alpha dT x', async () => {
  const E = 2e11, nu = 0.3, alpha = 1.2e-5, k = 10, Tref = 293.15, T1 = 393.15, dT = T1 - Tref;   // test inputs
  for (const dim of [2, 3] as const) {
    const box = dim === 2
      ? { id: 'p', type: 'rect', settings: { size: q([0.2, 0.1], 'm'), center: q([0.1, 0.05], 'm') } }
      : { id: 'p', type: 'box', settings: { size: q([0.2, 0.1, 0.05], 'm'), center: q([0.1, 0.05, 0.025], 'm') } };
    const sides = dim === 2 ? ['left', 'right', 'top', 'bottom'] : ['xmin', 'xmax', 'ymin', 'ymax', 'zmin', 'zmax'];
    const rollers = dim === 2 ? ['left', 'bottom'] : ['xmin', 'ymin', 'zmin'];
    const spec: Spec = {
      schema: 'amp-spec/0', id: 'free', title: 'free',
      geometry: { dim, features: [box] },
      materials: [{ id: 'm', override: { E: q(E, 'Pa'), nu, alpha: q(alpha, '1/K'), k: q(k, 'W/(m*K)') }, select: ['dom:p'] }],
      physics: [
        { id: 'ht', type: 'heat', select: ['dom:p'], bcs: [{ id: 'T', type: 'temperature', select: sides.map((s) => `bnd:p.${s}`), settings: { T: q(T1, 'K') } }] },
        { id: 'solid', type: 'elastic', select: ['dom:p'], settings: { model: dim === 2 ? 'plane-stress' : '3d' }, bcs: rollers.map((r) => ({ id: `r_${r}`, type: 'roller', select: [`bnd:p.${r}`] })) },
      ],
      couplings: [{ id: 'te', type: 'thermal-expansion', from: 'ht', to: 'solid', settings: { Tref: q(Tref, 'K') } }],
      mesh: { size: { hmax: q(0.05, 'm') } },
      studies: [{ id: 'std1', type: 'stationary', physics: ['ht', 'solid'] }],
    };
    const { sol } = await run(spec);
    const pt = dim === 2 ? [0.2, 0.1] : [0.2, 0.1, 0.05];
    for (let c = 0; c < dim; c++) {
      const u = sample(sol, 'solid.u', pt, { component: c })[0]!;
      assert.ok(rel(u, alpha * dT * pt[c]!) < 1e-9, `${dim}D u${c} ${u} vs ${alpha * dT * pt[c]!}`);
    }
    const s0 = E * alpha * dT;
    console.log(`free heating ${dim}D: mises_max ${sol.scalars['solid.mises_max']!.value} Pa (E alpha dT ${s0} Pa), u_max ${sol.scalars['solid.u_max']!.value} m`);
    assert.ok(sol.scalars['solid.mises_max']!.value < 1e-9 * s0, `${dim}D mises_max ${sol.scalars['solid.mises_max']!.value}`);
  }
});

test('thermal-expansion: NAFEMS T1 (CP-21) hot spot, sigma_yy just outside D = (1, 0) within 1.5 % of 50 MPa', async () => {
  const cs = readFileSync(`${root}eval/cases/a/CP-21.yaml`, 'utf8');
  // CP-21 inputs (materials, hot-spot temperature 100 degC, T_ref 0 degC, quarter 10 x 10, radius 1); lengths in m
  assert.ok(/hot_spot: \{E: 100000000000.0, nu: 0.3, alpha: 1.0e-05/.test(cs) && /membrane: \{E: 100000000000.0, nu: 0.3, alpha: 0.0/.test(cs) && /value: 100.0, unit: degC, T_ref: 0.0/.test(cs));
  const E = 1e11, nu = 0.3;
  const spec: Spec = {
    schema: 'amp-spec/0', id: 't1', title: 'NAFEMS T1',
    geometry: { dim: 2, features: [
      { id: 'plate', type: 'rect', settings: { size: q([10, 10], 'm'), center: q([5, 5], 'm') } },
      { id: 'disk', type: 'circle', settings: { center: q([0, 0], 'm'), radius: q(1, 'm') } },
      { id: 'sq', type: 'rect', settings: { size: q([1, 1], 'm'), center: q([0.5, 0.5], 'm') } },
      { id: 'spot', type: 'intersection', settings: { inputs: ['disk', 'sq'] } },
      { id: 'membrane', type: 'difference', settings: { base: 'plate', tools: ['spot'], keepTools: true } },
    ] },
    materials: [
      // k: test input; the hot-spot temperature is uniform (Dirichlet on its arc, insulated symmetry edges, no source), independent of k
      { id: 'mat_spot', override: { E: q(E, 'Pa'), nu, alpha: q(1e-5, '1/K'), k: q(1, 'W/(m*K)') }, select: ['dom:spot'] },
      { id: 'mat_membrane', override: { E: q(E, 'Pa'), nu, alpha: q(0, '1/K') }, select: ['dom:membrane'] },
    ],
    physics: [
      { id: 'ht', type: 'heat', select: ['dom:spot'], bcs: [
        { id: 'hot', type: 'temperature', select: ['bnd:disk.edge'], settings: { T: q(100, 'degC') } },
        { id: 'sym', type: 'insulation', select: ['bnd:sq.left', 'bnd:sq.bottom'] }] },
      { id: 'solid', type: 'elastic', select: ['dom:spot', 'dom:membrane'], settings: { model: 'plane-stress' }, bcs: [
        { id: 'sx', type: 'roller', select: ['bnd:plate.left', 'bnd:sq.left'] },
        { id: 'sy', type: 'roller', select: ['bnd:plate.bottom', 'bnd:sq.bottom'] },
        { id: 'free', type: 'free', select: ['bnd:plate.right', 'bnd:plate.top'] }] },
    ],
    couplings: [{ id: 'te', type: 'thermal-expansion', from: 'ht', to: 'solid', settings: { Tref: q(0, 'degC') } }],
    mesh: { size: { hmax: q(0.5, 'm') }, refine: [{ select: ['bnd:disk.edge'], h: q(0.02, 'm') }] },
    studies: [{ id: 'std1', type: 'stationary', physics: ['ht', 'solid'] }],
  };
  const { sol } = await run(spec);
  // element strains in the membrane cell at D (d() is per element; alpha = 0 there): sigma_yy = E / (1 - nu^2) (eyy + nu exx)
  const at = [[1 + 1e-7, 1e-7]];
  const exx = evalPoint(sol, 'd(solid.u.x, x)', at).values[0]!, eyy = evalPoint(sol, 'd(solid.u.y, y)', at).values[0]!;
  const syy = (E / (1 - nu * nu)) * (eyy + nu * exx);
  // inside: uniform -E alpha dT / 2 for the infinite plate (Eshelby); the finite quarter is within the 1.5 % band
  const inside = evalPoint(sol, 'solid.sxx', [[0.3, 0.3]]).values[0]!;
  console.log(`T1 sigma_yy(D+) = ${syy} Pa, sxx(0.3, 0.3) = ${inside} Pa, dof ${sol.stats.dof}`);
  assert.ok(rel(syy, 50e6) < 0.015, `sigma_yy(D) ${syy}`);
  // CP-21 bounds: between the infinite-plate (50.0 MPa) and free-disk (50.5 MPa) values
  assert.ok(syy > 50e6 && syy < 50.5e6, `sigma_yy(D) ${syy} outside [50.0, 50.5] MPa`);
  assert.ok(rel(inside, -50e6) < 0.015, `sxx inside ${inside}`);
});

/**
 * Timoshenko (1925), "Analysis of bi-metal thermostats", J. Opt. Soc. Am. 11(3), 233-255, curvature of a free
 * bi-material strip under a uniform temperature change dT:
 *   kappa = 6 (alpha2 - alpha1) dT (1 + m)^2 / (h [3 (1 + m)^2 + (1 + m n) (m^2 + 1 / (m n))]),
 *   m = t1 / t2, n = E1 / E2, h = t1 + t2.
 */
const timoshenko = (t1: number, t2: number, E1: number, E2: number, a1: number, a2: number, dT: number) => {
  const m = t1 / t2, n = E1 / E2, h = t1 + t2;
  return (6 * (a2 - a1) * dT * (1 + m) ** 2) / (h * (3 * (1 + m) ** 2 + (1 + m * n) * (m * m + 1 / (m * n))));
};

test('thermal-expansion: bimetal strip curvature vs Timoshenko 1925 (plane stress, clamped root, fit away from the ends)', async () => {
  // test inputs (nominal): layer 1 bottom, layer 2 top
  const L = 0.05, t1 = 1e-3, t2 = 0.6e-3, E1 = 1e11, E2 = 2e11, a1 = 1e-5, a2 = 2e-5, nu = 0.3, Tref = 293.15, dT = 100;
  const spec: Spec = {
    schema: 'amp-spec/0', id: 'bimetal', title: 'bimetal',
    geometry: { dim: 2, features: [
      { id: 'l1', type: 'rect', settings: { size: q([L, t1], 'm'), center: q([L / 2, t1 / 2], 'm') } },
      { id: 'l2', type: 'rect', settings: { size: q([L, t2], 'm'), center: q([L / 2, t1 + t2 / 2], 'm') } },
    ] },
    materials: [
      { id: 'm1', override: { E: q(E1, 'Pa'), nu, alpha: q(a1, '1/K'), k: q(10, 'W/(m*K)') }, select: ['dom:l1'] },
      { id: 'm2', override: { E: q(E2, 'Pa'), nu, alpha: q(a2, '1/K'), k: q(10, 'W/(m*K)') }, select: ['dom:l2'] },
    ],
    physics: [
      { id: 'ht', type: 'heat', select: ['dom:l1', 'dom:l2'], bcs: [{ id: 'T', type: 'temperature', select: ['bnd:l1.left', 'bnd:l1.right', 'bnd:l1.bottom', 'bnd:l2.left', 'bnd:l2.right', 'bnd:l2.top'], settings: { T: q(Tref + dT, 'K') } }] },
      { id: 'solid', type: 'elastic', select: ['dom:l1', 'dom:l2'], settings: { model: 'plane-stress' }, bcs: [{ id: 'clamp', type: 'fixed', select: ['bnd:l1.left', 'bnd:l2.left'] }] },
    ],
    couplings: [{ id: 'te', type: 'thermal-expansion', from: 'ht', to: 'solid', settings: { Tref: q(Tref, 'K') } }],
    mesh: { size: { hmax: q(t2 / 3, 'm') } },
    studies: [{ id: 'std1', type: 'stationary', physics: ['ht', 'solid'] }],
  };
  const { sol } = await run(spec);
  // least-squares parabola v(x) = a + b x + c x^2 along the interface y = t1 for x in [0.2 L, 0.8 L]: kappa = 2 c
  const xs = Array.from({ length: 61 }, (_, i) => 0.2 * L + (0.6 * L * i) / 60);
  const v = sample(sol, 'solid.u', xs.map((x) => [x, t1]), { component: 1 });
  const S = [0, 0, 0, 0, 0], B = [0, 0, 0];
  xs.forEach((x, i) => { for (let p = 0; p < 5; p++) S[p]! += x ** p; for (let p = 0; p < 3; p++) B[p]! += v[i]! * x ** p; });
  const A = [[S[0]!, S[1]!, S[2]!], [S[1]!, S[2]!, S[3]!], [S[2]!, S[3]!, S[4]!]];
  const det3 = (M: number[][]) => M[0]![0]! * (M[1]![1]! * M[2]![2]! - M[1]![2]! * M[2]![1]!) - M[0]![1]! * (M[1]![0]! * M[2]![2]! - M[1]![2]! * M[2]![0]!) + M[0]![2]! * (M[1]![0]! * M[2]![1]! - M[1]![1]! * M[2]![0]!);
  const c = det3(A.map((r, i) => [r[0]!, r[1]!, B[i]!])) / det3(A);
  const kappa = 2 * c, kex = timoshenko(t1, t2, E1, E2, a1, a2, dT);
  console.log(`bimetal kappa FE ${kappa} 1/m, Timoshenko ${kex} 1/m, rel ${rel(-kappa, kex)}, dof ${sol.stats.dof}`);
  // the strip bends towards layer 1 (lower alpha): v'' < 0 with layer 2 on top
  assert.ok(rel(-kappa, kex) < 0.01, `kappa ${kappa} vs ${kex}`);
});

// ------------------------------------------------------------------------------------------------- driver rules

test('driver: single physics without couplings is the plain module run (identical fields and scalars)', async () => {
  for (const id of ['heated-wire', 'kirsch-plate', 'coax-line']) {
    const parsed = parseSpecText(readFileSync(`${root}sims/${id}.yaml`, 'utf8'), physicsRegistry());
    const p = await prepareRun(parsed.data as Spec, { library: null });
    const a = await registry[p.spec.physics!.find((x) => x.id === p.physicsId)!.type]!.run(p);
    const b = await runStudy(p);
    assert.deepEqual(Object.keys(b.scalars), Object.keys(a.scalars));
    for (const k of Object.keys(a.scalars)) assert.equal(b.scalars[k]!.value, a.scalars[k]!.value, `${id} ${k}`);
    assert.equal(b.fields.length, a.fields.length);
    a.fields.forEach((f, i) => { assert.equal(b.fields[i]!.name, f.name); assert.equal(b.fields[i]!.physics, undefined); assert.deepEqual(b.fields[i]!.data, f.data); });
  }
});

test('driver: readiness reasons for a missing coupling implementation, an unsolved upstream physics and a cycle', () => {
  const base = (couplings: unknown[], studyPhysics: string[]): Spec => ({
    schema: 'amp-spec/0', id: 'r', title: 'r',
    geometry: { dim: 2, features: [{ id: 'p', type: 'rect', settings: { size: q([1, 1], 'm'), center: q([0.5, 0.5], 'm') } }] },
    materials: [{ id: 'm', override: { k: q(1, 'W/(m*K)'), E: q(1e9, 'Pa'), nu: 0.3, alpha: q(1e-5, '1/K'), sigma: q(1, 'S/m') }, select: ['dom:p'] }],
    physics: [
      { id: 'cur', type: 'currents', select: ['dom:p'], bcs: [{ id: 'g', type: 'ground', select: ['bnd:p.left'] }] },
      { id: 'ht', type: 'heat', select: ['dom:p'], bcs: [{ id: 'T', type: 'temperature', select: ['bnd:p.left'], settings: { T: q(300, 'K') } }] },
      { id: 'solid', type: 'elastic', select: ['dom:p'], settings: { model: 'plane-stress' }, bcs: [{ id: 'f', type: 'fixed', select: ['bnd:p.left'] }] },
    ],
    couplings, mesh: { size: { hmax: q(0.5, 'm') } },
    studies: [{ id: 's', type: 'stationary', physics: studyPhysics }],
  });
  const parse = (s: Spec) => { const r = parseSpecText(JSON.stringify(s), physicsRegistry()); assert.ok(r.spec, JSON.stringify(r.issues.slice(0, 3))); return r.spec!; };
  // upstream physics not in the study
  let rd = studyReadiness(parse(base([{ id: 'jh', type: 'joule-heating', from: 'cur', to: 'ht' }], ['ht'])));
  assert.ok(rd.reasons.some((x) => x.includes("'cur' is not solved by study 's'")), rd.reasons.join('; '));
  // missing implementation: a registered coupling type with no CouplingImpl (empty implementation list)
  const spec = parse(base([{ id: 'jh', type: 'joule-heating', from: 'cur', to: 'ht' }], ['cur', 'ht']));
  rd = studyReadiness(spec, undefined, { couplings: [] });
  assert.ok(rd.reasons.some((x) => x.includes("no implementation of coupling type 'joule-heating'")), rd.reasons.join('; '));
  rd = studyReadiness(spec);
  assert.ok(rd.ready, rd.reasons.join('; '));
  assert.deepEqual(rd.order, ['cur', 'ht']);
  // coupling property needs: alpha N/A on the elastic material
  const s2 = base([{ id: 'te', type: 'thermal-expansion', from: 'ht', to: 'solid', settings: { Tref: q(300, 'K') } }], ['ht', 'solid']);
  ((s2.materials as Array<{ override: Record<string, unknown> }>)[0]!.override).alpha = 'N/A';
  rd = studyReadiness(parse(s2));
  assert.ok(rd.reasons.some((x) => x.startsWith("coupling 'te': materials.m.override.alpha is N/A")), rd.reasons.join('; '));
  // a cycle (test-only coupling type heat -> currents next to joule-heating currents -> heat)
  const cyc = structuredClone(spec) as typeof spec & { couplings: unknown[] };
  cyc.couplings.push({ id: 'back', type: 'back-test', from: 'ht', to: 'cur' });
  const back: CouplingImpl = { type: 'back-test', from: 'heat', to: 'currents', kind: 'sequential', map: () => ({ coupling: 'back', from: 'ht', kind: 'back-test', data: {} }) };
  rd = studyReadiness(cyc, undefined, { couplings: [...COUPLINGS, back] });
  assert.ok(rd.reasons.some((x) => x.includes('form a cycle')), rd.reasons.join('; '));
});

// ------------------------------------------------------------------------------------------------- MO / MX requests (R0-R5, X1-X3)

test('registry (R0, X1, X2): dndT, r_eo, uniaxial n, cubic and hexagonal-6mm C, elastic axisym model, electrostatics 3d', () => {
  const reg = physicsRegistry();
  const base = (materials: unknown[], extra: Spec = {}): Spec => ({
    schema: 'amp-spec/0', id: 'r', title: 'r',
    geometry: { dim: 2, features: [{ id: 'p', type: 'rect', settings: { size: q([1, 1], 'm'), center: q([0.5, 0.5], 'm') } }] },
    materials, physics: [{ id: 'ht', type: 'heat', select: ['dom:p'], bcs: [] }],
    mesh: { size: { hmax: q(0.5, 'm') } }, studies: [{ id: 's', type: 'stationary', physics: ['ht'] }], ...extra,
  });
  const ok = (s: Spec) => { const r = parseSpecText(JSON.stringify(s), reg); return r.ok ? '' : r.issues.filter((i) => i.severity !== 'notice').map((i) => `${i.dotted}: ${i.message}`).join('; '); };
  // test inputs (nominal numbers, not material data)
  assert.equal(ok(base([{ id: 'm', override: { k: q(1, 'W/(m*K)'), dndT: q(1e-4, '1/K'), n: { symmetry: 'uniaxial', components: { perp: 2.2, par: 2.1 } },
    r_eo: { symmetry: 'trigonal-3m', unit: 'pm/V', components: { r13: 1, r22: 1, r33: 1, r51: 1 } } }, select: ['dom:p'] }])), '');
  assert.equal(ok(base([{ id: 'm', override: { k: q(1, 'W/(m*K)'), C: { symmetry: 'cubic', unit: 'GPa', components: { C11: 1, C12: 1, C44: 1 } } }, select: ['dom:p'] }])), '');
  assert.equal(ok(base([{ id: 'm', override: { k: q(1, 'W/(m*K)'), C: { symmetry: 'hexagonal-6mm', unit: 'GPa', components: { C11: 1, C12: 1, C13: 1, C33: 1, C44: 1 } } }, select: ['dom:p'] }])), '');
  // seed bounds kept: E > 0
  assert.notEqual(ok(base([{ id: 'm', override: { k: q(-1, 'W/(m*K)') }, select: ['dom:p'] }])), '');
  const axi = base([{ id: 'm', override: { E: q(1, 'GPa'), nu: 0.3 }, select: ['dom:p'] }], {
    geometry: { dim: 2, axisym: true, features: [{ id: 'p', type: 'rect', settings: { size: q([1, 1], 'm'), center: q([0.5, 0.5], 'm') } }] },
    physics: [{ id: 'solid', type: 'elastic', select: ['dom:p'], settings: { model: 'axisym' }, bcs: [] }], studies: [{ id: 's', type: 'stationary', physics: ['solid'] }] });
  assert.equal(ok(axi), '');
  ((axi.physics as Array<{ settings: { model: string } }>)[0]!.settings.model = 'plane-stress');
  assert.match(ok(axi), /does not match geometry 2d-axisym/);
  assert.deepEqual(reg.get('physics', 'electrostatics')!.dims, ['2d', '2d-axisym', '3d']);
});

test('prepareRun (R1a): tensor overrides flatten to <prop>.<component> in SI', async () => {
  const spec: Spec = {
    schema: 'amp-spec/0', id: 't', title: 't',
    geometry: { dim: 2, features: [{ id: 'p', type: 'rect', settings: { size: q([1, 1], 'm'), center: q([0.5, 0.5], 'm') } }] },
    // test inputs (nominal)
    materials: [{ id: 'm', override: { k: q(2, 'W/(m*K)'), n: { symmetry: 'uniaxial', components: { perp: 2.2, par: 2.1 } }, r_eo: { symmetry: 'trigonal-3m', unit: 'pm/V', components: { r13: 9, r22: 3, r33: 31, r51: 28 } } }, select: ['dom:p'] }],
    physics: [{ id: 'ht', type: 'heat', select: ['dom:p'], bcs: [{ id: 'T', type: 'temperature', select: ['bnd:p.left'], settings: { T: q(300, 'K') } }] }],
    mesh: { size: { hmax: q(0.5, 'm') } }, studies: [{ id: 's', type: 'stationary', physics: ['ht'] }],
  };
  const p = await prepareRun(spec, { library: null });
  const r = p.materials.m!;
  assert.equal(r.k, 2); assert.equal(r['n.perp'], 2.2); assert.equal(r['n.par'], 2.1);
  assert.ok(rel(r['r_eo.r33']!, 31e-12) < 1e-12, String(r['r_eo.r33']));
});

test('heat Q_total (R5): integral of the volume sources (heated-wire: q_gen pi r0^2 Lz, W)', async () => {
  const parsed = parseSpecText(readFileSync(`${root}sims/heated-wire.yaml`, 'utf8'), physicsRegistry());
  const spec = parsed.data as Spec & { params: Record<string, { value: number }> };
  const { sol } = await run(spec);
  const ex = spec.params.q_gen!.value * Math.PI * spec.params.r0!.value ** 2 * spec.params.Lz!.value;
  console.log(`heated-wire Q_total ${sol.scalars.Q_total!.value} ${sol.scalars.Q_total!.unit} vs ${ex}`);
  assert.equal(sol.scalars.Q_total!.unit, 'W');
  assert.ok(rel(sol.scalars.Q_total!.value, ex) < 1e-12);
});

test('currents 2D out-of-plane drive (X3) -> joule-heating -> heat: R = L / (sigma A), Q_total = P per length', async () => {
  const w = 1.5e-6, t = 1e-7, Lh = 4.5e-4, sigma = 4e5, V = 1;   // test inputs (nominal)
  const spec: Spec = {
    schema: 'amp-spec/0', id: 'oop', title: 'oop',
    geometry: { dim: 2, features: [
      { id: 'box', type: 'rect', settings: { size: q([2e-5, 1e-5], 'm'), center: q([0, 0], 'm') } },
      { id: 'h', type: 'rect', settings: { size: q([w, t], 'm'), center: q([0, 0], 'm') } },
      { id: 'clad', type: 'difference', settings: { base: 'box', tools: ['h'], keepTools: true } }] },
    materials: [
      { id: 'metal', override: { sigma: q(sigma, 'S/m'), k: q(20, 'W/(m*K)') }, select: ['dom:h'] },
      { id: 'ox', override: { k: q(1.4, 'W/(m*K)') }, select: ['dom:clad'] }],
    physics: [
      { id: 'cur', type: 'currents', select: ['dom:h'], settings: { outOfPlane: { V: q(V, 'V'), length: q(Lh, 'm') } }, bcs: [] },
      { id: 'ht', type: 'heat', select: ['dom:h', 'dom:clad'], bcs: [{ id: 'sink', type: 'temperature', select: ['bnd:box.bottom'], settings: { T: q(300, 'K') } }] }],
    couplings: [{ id: 'jh', type: 'joule-heating', from: 'cur', to: 'ht' }],
    mesh: { size: { hmax: q(2e-6, 'm') }, refine: [{ select: ['dom:h'], h: q(5e-8, 'm') }] },
    studies: [{ id: 's', type: 'stationary', physics: ['cur', 'ht'] }],
  };
  const { sol } = await run(spec);
  const R = Lh / (sigma * w * t), Pl = (V * V) / R / Lh;
  console.log(`out-of-plane: R ${sol.scalars['cur.R']!.value} Ohm vs ${R}, P' ${sol.scalars['cur.P']!.value} W/m vs ${Pl}, Q_total ${sol.scalars['ht.Q_total']!.value} ${sol.scalars['ht.Q_total']!.unit}`);
  assert.ok(rel(sol.scalars['cur.R']!.value, R) < 1e-9);
  assert.ok(rel(sol.scalars['cur.I']!.value, V / R) < 1e-9);
  assert.ok(rel(sol.scalars['cur.P']!.value, Pl) < 1e-9);
  assert.equal(sol.scalars['ht.Q_total']!.unit, 'W/m');
  assert.ok(rel(sol.scalars['ht.Q_total']!.value, Pl) < 1e-9);
});

test('driver: two physics with steps (electrostatics with 2 terminals + em-modes) is a readiness reason', () => {
  const spec: Spec = {
    schema: 'amp-spec/0', id: 'st', title: 'st',
    geometry: { dim: 2, features: [{ id: 'p', type: 'rect', settings: { size: q([1e-5, 1e-5], 'm'), center: q([0, 0], 'm') } }] },
    materials: [{ id: 'm', override: { eps_r: 2, n: 1.5 }, select: ['dom:p'] }],
    physics: [
      { id: 'es', type: 'electrostatics', select: ['dom:p'], bcs: [{ id: 'a', type: 'terminal', select: ['bnd:p.left'] }, { id: 'b', type: 'terminal', select: ['bnd:p.right'] }] },
      { id: 'ewg', type: 'em-modes', select: ['dom:p'], settings: { order: 2 }, bcs: [{ id: 'w', type: 'pec', select: ['bnd:p.top', 'bnd:p.bottom', 'bnd:p.left', 'bnd:p.right'] }] }],
    couplings: [{ id: 'eo', type: 'electro-optic', from: 'es', to: 'ewg', settings: { armB: 'none' } }],
    mesh: { size: { hmax: q(2e-6, 'm') } },
    studies: [{ id: 's', type: 'mode', physics: ['es', 'ewg'], settings: { wavelength: q(1.55e-6, 'm'), nModes: 1 } }],
  };
  const r = parseSpecText(JSON.stringify(spec), physicsRegistry());
  assert.ok(r.spec, JSON.stringify(r.issues.slice(0, 3)));
  const rd = studyReadiness(r.spec!);
  assert.ok(rd.reasons.some((x) => x.includes('all produce steps') && x.includes('one terminal')), rd.reasons.join('; '));
});

test('prepareRun (R1b, R1c): library n and dndT at the mode wavelength, dndT at the thermo-optic Tref; coupling needs pulled', async () => {
  const calls: Array<{ p: string; o: unknown }> = [];
  // fake library (test input): records the evaluation options
  const library = { getProperty(_id: string, p: string, o?: { T?: number; lambda?: number }) {
    calls.push({ p, o });
    if (p === 'n') return { value: { perp: 2.2, par: 2.1 } };
    if (p === 'dndT') return { value: 3e-5 };
    if (p === 'k') return { value: 5 };
    throw new Error(`no ${p}`);
  } };
  const spec: Spec = {
    schema: 'amp-spec/0', id: 'lib', title: 'lib',
    geometry: { dim: 2, features: [{ id: 'p', type: 'rect', settings: { size: q([4e-6, 4e-6], 'm'), center: q([0, 0], 'm') } }] },
    materials: [{ id: 'm', ref: 'materials/fake', select: ['dom:p'] }],
    physics: [
      { id: 'ht', type: 'heat', select: ['dom:p'], bcs: [{ id: 'T', type: 'temperature', select: ['bnd:p.bottom'], settings: { T: q(300, 'K') } }] },
      { id: 'ewg', type: 'em-modes', select: ['dom:p'], settings: { order: 2 }, bcs: [] }],
    couplings: [{ id: 'to', type: 'thermo-optic', from: 'ht', to: 'ewg', settings: { Tref: q(310, 'K') } }],
    mesh: { size: { hmax: q(2e-6, 'm') } },
    studies: [{ id: 's', type: 'mode', physics: ['ht', 'ewg'], settings: { wavelength: q(1.55, 'um'), nModes: 1 } }],
  };
  const p = await prepareRun(spec, { library });
  const r = p.materials.m!;
  assert.equal(r['n.perp'], 2.2); assert.equal(r.dndT, 3e-5); assert.equal(r.k, 5);
  const o = (pr: string) => calls.find((c) => c.p === pr)!.o as { T?: number; lambda?: number };
  assert.ok(Math.abs(o('n').lambda! - 1.55e-6) < 1e-18);
  assert.ok(Math.abs(o('dndT').lambda! - 1.55e-6) < 1e-18 && o('dndT').T === 310);
  assert.equal(o('k').lambda, undefined);
});
