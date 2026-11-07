// SPDX-License-Identifier: GPL-3.0-or-later
// Photonic couplings (DevLog-032): thermo-optic and electro-optic inputs of em-modes, through the C11 map functions of
// couplings/photonic.ts and em-modes run(). Material values from the @amp/materials library (sourced YAML).
//   G-TO1  Si strip 500 x 220 nm in SiO2 (si-strip-te0), uniform dT: direct vs first order; per-domain sensitivities
//          obey sum_d n_d dneff/dn_d = n_g (exact for non-dispersive eps: eps -> s^2 eps at k0 equals eps at s k0);
//          dneff = dT sum_d (dn/dT)_d dneff/dn_d.
//   G-EO1  PEC box filled with z-cut LN (c axis = lab y), uniform E_y: TE10 has E_y only, so
//          dneff/dV = (k0 / (2 beta)) d eps_yy / dV, d eps_yy = -n_e^4 r33 E_y (closed form); direct vs first order.
//   S1     P1 / P2 nodal sampling (value and gradient) of polynomials at the kernel quadrature points.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Mesh, RunContext, Solution, Spec } from '@amp/spec/types';
import { parseYaml } from '@amp/spec';
import { prepareRun } from '../src/prepare.ts';
import { emModes, solveModes } from '../src/modes/index.ts';
import { vectorPerturbation } from '../src/modes/vector-mode.mjs';
import { sampleNodal } from '../src/modes/coupled.ts';
import { PHOTONIC_COUPLINGS } from '../src/couplings/photonic.ts';
import { rectTriMesh, nNodes, nCells } from '../src/common/mesh.ts';
import { defaultLibrary } from '@amp/materials/node';

const LIB = defaultLibrary();
const prop = (id: string, p: string, o: Record<string, number> = {}) => LIB.getProperty(id, p, o).value;
const impl = (t: string) => PHOTONIC_COUPLINGS.find((c) => c.type === t)!;
const nodalSol = (mesh: Mesh, name: string, data: Float64Array, step?: number): Solution =>
  ({ meshHash: mesh.hash, fields: [{ name, unit: name === 'T' ? 'K' : 'V', space: mesh.cells.type === 'tri6' ? 'H1P2' : 'H1P1', components: 1, data, ...(step !== undefined ? { step } : {}) }], scalars: {}, stats: { dof: 0, solver: 'test' }, timing: {}, run: {} as Solution['run'] });

test('S1 nodal sampling: P1 and P2 value and gradient exact for linear / quadratic fields', () => {
  for (const order of [1, 2] as const) {
    const m = rectTriMesh({ x: [0, 2e-6], y: [0, 1e-6], nx: 3, ny: 2, order });
    const f = order === 1 ? (x: number, y: number) => 3 + 2e6 * x - 5e6 * y : (x: number, y: number) => 1 + 1e12 * x * x - 2e12 * x * y + 3e6 * y;
    const g = order === 1 ? () => [2e6, -5e6] : (x: number, y: number) => [2e12 * x - 2e12 * y, -2e12 * x + 3e6];
    const data = new Float64Array(nNodes(m));
    for (let i = 0; i < data.length; i++) data[i] = f(m.nodes[2 * i]!, m.nodes[2 * i + 1]!);
    for (let c = 0; c < nCells(m); c++) {
      const L = [0.2, 0.3, 0.5];
      const k = order === 1 ? 3 : 6, v = [0, 1, 2].map((a) => m.cells.conn[k * c + a]!);
      const x = L.reduce((s, l, a) => s + l * m.nodes[2 * v[a]!]!, 0), y = L.reduce((s, l, a) => s + l * m.nodes[2 * v[a]! + 1]!, 0);
      const r = sampleNodal(m, data, order === 1 ? 'H1P1' : 'H1P2', c, L);
      assert.ok(Math.abs(r[0]! - f(x, y)) < 1e-9 * Math.abs(f(x, y)), `value order ${order}`);
      const [gx, gy] = g(x, y);
      assert.ok(Math.abs(r[1]! - gx!) < 1e-6 * Math.max(1, Math.abs(gx!)) && Math.abs(r[2]! - gy!) < 1e-6 * Math.max(1, Math.abs(gy!)), `gradient order ${order}`);
    }
  }
});

test('G-TO1 Si strip in SiO2, uniform dT: direct vs first order; sum n_d dneff/dn_d = n_g; dneff/dT from the domain sensitivities', async (t) => {
  const spec = parseYaml(readFileSync(new URL('../../../sims/si-strip-te0.yaml', import.meta.url), 'utf8')).data as Record<string, any>;
  spec.mesh.size.hmax = 'W/12';
  const ctx = (await prepareRun(spec, { physicsId: 'ewg' })) as RunContext;
  const lam = 1.55e-6, Tref = 293;
  // dn/dT from the library: Si Li 1980 Table 2 (293 K), SiO2 Leviton-Frey 2006 fit (Corning 7980) at 293 K
  const dSi = prop('silicon', 'dndT', { lambda: lam }) as number, dOx = prop('fused-silica', 'dndT', { lambda: lam, T: Tref }) as number;
  ctx.materials.Si!.dndT = dSi; ctx.materials.SiO2!.dndT = dOx;
  (ctx.spec.physics as any[]).push({ id: 'heat1', type: 'heat', select: ['dom:core', 'dom:clad'] });
  const dT = 1;
  const up = nodalSol(ctx.mesh, 'T', new Float64Array(nNodes(ctx.mesh)).fill(Tref + dT));
  const inp = impl('thermo-optic').map!({ up, upId: 'heat1', down: ctx, node: { id: 'to1', type: 'thermo-optic', from: 'heat1', to: 'ewg', settings: { Tref: { value: Tref, unit: 'K' } } } as any });
  const sol = await emModes.run({ ...ctx, inputs: [inp] });
  const S = sol.scalars;
  const dn = S.dneff_0!.value, dnP = S.dneffPert_0!.value;
  t.diagnostic(`TE0 neff0 ${S.neff0_0!.value}, dneff ${dn} (direct), ${dnP} (first order), dneff/dT ${dn / dT} 1/K; dSi ${dSi}, dOx ${dOx}`);
  assert.ok(Math.abs(dn / dnP - 1) < 1e-3, `direct ${dn} vs first order ${dnP}`);
  // independent: per-domain sensitivities on the unheated mode
  const base = await solveModes({ mesh: ctx.mesh, wavelength: lam, nModes: 1, fields: false, ...pick(ctx) });
  const m0 = base.result.modes[0], model = base.model, nT = nCells(ctx.mesh);
  const nOf = { Si: ctx.materials.Si!.n!, SiO2: ctx.materials.SiO2!.n! };
  const domMat = ctx.mesh.entities.domains.map((d) => (d.id.startsWith('dom:core') ? 'Si' : 'SiO2'));
  const sens: Record<string, number> = {};
  for (const mat of ['Si', 'SiO2'] as const) {
    const dE = new Float64Array(4 * nT);
    for (let c = 0; c < nT; c++) if (domMat[ctx.mesh.cells.domain[c]!] === mat) dE.set([2 * nOf[mat], 0, 2 * nOf[mat], 2 * nOf[mat]], 4 * c); // d eps / d n
    sens[mat] = vectorPerturbation(model, m0, dE, lam * 1e6);
  }
  const ngId = nOf.Si * sens.Si! + nOf.SiO2 * sens.SiO2!;
  t.diagnostic(`dneff/dn_Si ${sens.Si}, dneff/dn_SiO2 ${sens.SiO2}; sum n dneff/dn = ${ngId}, solver n_g ${m0.ng}`);
  assert.ok(Math.abs(ngId / m0.ng - 1) < 1e-6, `identity ${ngId} vs n_g ${m0.ng}`);
  assert.ok(Math.abs((dT * (dSi * sens.Si! + dOx * sens.SiO2!)) / dnP - 1) < 1e-9, 'first order = sum of domain sensitivities');
  assert.equal(S.dphidz_0!.unit, 'rad/m');
  assert.ok(Math.abs(S.dphidz_0!.value - (2 * Math.PI / lam) * dn) < 1e-12 * Math.abs(S.dphidz_0!.value));
  assert.equal(S.Ppi_0, undefined, 'no heater power: no Ppi');
  // with a heater power per length: Ppi = lambda P' / (2 |dneff|)
  const inp2 = impl('thermo-optic').map!({ up, upId: 'heat1', down: ctx, node: { id: 'to1', type: 'thermo-optic', from: 'heat1', to: 'ewg', settings: { Tref: { value: Tref, unit: 'K' }, power: { value: 1, unit: 'W/m' } } } as any });
  const s2 = (await emModes.run({ ...ctx, inputs: [inp2] })).scalars;
  assert.ok(Math.abs(s2.Ppi_0!.value - lam * 1 / (2 * Math.abs(s2.dneff_0!.value))) < 1e-12 * s2.Ppi_0!.value);
  // missing dn/dT is an error, not a default
  delete ctx.materials.SiO2!.dndT;
  await assert.rejects(emModes.run({ ...ctx, inputs: [inp] }), /SiO2 have no dndT/);
});

/** ModesProblem fields of a prepared context (eps per domain from n). */
function pick(ctx: RunContext) {
  const eps = ctx.mesh.entities.domains.map((d) => (d.id.startsWith('dom:core') ? ctx.materials.Si!.n! ** 2 : ctx.materials.SiO2!.n! ** 2));
  return { eps, pec: ['bnd:win.left', 'bnd:win.right', 'bnd:win.top', 'bnd:win.bottom'] };
}

test('G-EO1 PEC box of z-cut LN, uniform E_y: TE10 dneff/dV vs closed form; direct vs first order; arm B conventions', async (t) => {
  const a = 2e-6, b = 1e-6, lam = 1.55e-6, d = b;            // box a x b, potential difference over the height b
  const mesh = rectTriMesh({ x: [0, a], y: [0, b], nx: 24, ny: 12, order: 2 });
  const n = prop('linbo3-congruent', 'n', { lambda: lam }) as Record<string, number>;   // Zelmon 1997
  const r = prop('linbo3-congruent', 'r_eo') as Record<string, number>;                 // Weis-Gaylord 1985, 633 nm clamped
  const walls = ['bnd:rect.bottom', 'bnd:rect.right', 'bnd:rect.top', 'bnd:rect.left'];
  const spec = {
    schema: 'amp-spec/0', id: 'eo-box', title: 'eo box', params: {}, geometry: { dim: 2, features: [] },
    materials: [{ id: 'ln', override: { n: { symmetry: 'uniaxial', components: { perp: n.perp!, par: n.par! } } }, select: ['dom:rect'] }],
    physics: [
      { id: 'ewg', type: 'em-modes', select: ['dom:rect'], bcs: [{ id: 'w', type: 'pec', select: walls }] },
      { id: 'es1', type: 'electrostatics', select: ['dom:rect'], bcs: [] },
    ],
    studies: [{ id: 'm', type: 'mode', physics: ['ewg', 'es1'], settings: { wavelength: { value: lam, unit: 'm' }, nModes: 1 } }],
  } as unknown as Spec;
  const materials = { ln: { 'n.perp': n.perp!, 'n.par': n.par!, 'r_eo.r13': r.r13!, 'r_eo.r22': r.r22!, 'r_eo.r33': r.r33!, 'r_eo.r51': r.r51! } };
  const ctx: RunContext = { spec, physicsId: 'ewg', mesh, materials, study: spec.studies![0]!, progress: () => {}, signal: new AbortController().signal };
  const V = new Float64Array(nNodes(mesh));
  for (let i = 0; i < V.length; i++) V[i] = mesh.nodes[2 * i + 1]! / d;   // 1 V across b: E_y = -1/d V/m per volt
  const up = nodalSol(mesh, 'V_applied', V);
  const crystals = [{ material: 'ln', cut: 'z', propagation: 'x' }];      // lab x = crystal y, lab y = crystal z (c)
  const run = async (armB: string, extra: Record<string, unknown> = {}) => {
    const inp = impl('electro-optic').map!({ up, upId: 'es1', down: ctx, node: { id: 'eo1', type: 'electro-optic', from: 'es1', to: 'ewg', settings: { armB, crystals, ...extra } } as any });
    return (await emModes.run({ ...ctx, inputs: [inp] })).scalars;
  };
  const S = await run('none');
  const k0 = 2 * Math.PI / lam, ne = n.par!;
  const beta = Math.sqrt(k0 * k0 * ne * ne - (Math.PI / a) ** 2);
  assert.ok(Math.abs(S.neff_0!.value - beta / k0) < 1e-6, `TE10 neff ${S.neff_0!.value} vs ${beta / k0}`);
  const exact = (k0 / (2 * beta)) * (-(ne ** 4) * r.r33! * (-1 / d));
  t.diagnostic(`dneff/dV first order ${S.dneffdV_0!.value}, direct ${S.dneffdVdirect_0!.value}, closed form ${exact} 1/V; VpiL single ${S.VpiL_0!.value * 100} V cm`);
  assert.ok(Math.abs(S.dneffdV_0!.value / exact - 1) < 1e-6, 'first order vs closed form');
  assert.ok(Math.abs(S.dneffdVdirect_0!.value / exact - 1) < 1e-4, 'direct vs closed form');
  assert.ok(Math.abs(S.VpiL_0!.value - lam / (2 * Math.abs(exact))) < 1e-6 * S.VpiL_0!.value, 'single-arm VpiL');
  const I = await run('ideal', { direct: false });
  assert.ok(Math.abs(I.dneffdVB_0!.value + I.dneffdV_0!.value) < 1e-20 && Math.abs(I.VpiL_0!.value - S.VpiL_0!.value / 2) < 1e-9 * S.VpiL_0!.value, 'ideal push-pull halves VpiL');
  // mirror about the box centre in a uniform field: arm B sees the same field, dn_B = dn_A, no differential phase
  const M = await run('mirror', { direct: false, mirrorX: { value: a / 2, unit: 'm' } });
  assert.ok(Math.abs(M.dneffdVB_0!.value / M.dneffdV_0!.value - 1) < 1e-9 && M.VpiL_0 === undefined, 'mirror in a uniform field');
  await assert.rejects(Promise.resolve().then(() => impl('electro-optic').map!({ up, upId: 'es1', down: ctx, node: { id: 'eo1', type: 'electro-optic', from: 'es1', to: 'ewg', settings: { crystals } } as any })), /armB is required/);
});

test('em-modes without coupled inputs is the plain path (same n_eff bitwise)', async () => {
  const spec = parseYaml(readFileSync(new URL('../../../sims/si-strip-te0.yaml', import.meta.url), 'utf8')).data as Record<string, any>;
  spec.mesh.size.hmax = 'W/8';
  const ctx = (await prepareRun(spec, { physicsId: 'ewg' })) as RunContext;
  const a = await emModes.run(ctx), b = await emModes.run({ ...ctx, inputs: [] });
  assert.deepEqual(Array.from(a.steps!.values), Array.from(b.steps!.values));
});

test('G-TO2 heat -> em-modes end to end (spec, prepareRun, runStudy): heater source, dneff linear in power, Ppi independent of power', async (t) => {
  const { runStudy } = await import('../src/driver.ts');
  await import('../src/index.ts');   // registers the modules with the driver
  const lam = 1.55e-6, Tref = 293;
  const kOf = (id: string) => prop(id, 'k', { T: 298.15 }) as number;   // library k at 25 C (stated validity)
  const mk = (Q: number) => ({
    schema: 'amp-spec/0', id: 'to-e2e', title: 'thermo-optic end to end (test inputs)',
    params: { Q: { value: Q, unit: 'W/m^3' } },
    geometry: { dim: 2, features: [
      { id: 'win', type: 'rect', settings: { size: ['4 um', '4 um'], center: ['0 um', '0 um'] } },
      { id: 'core', type: 'rect', settings: { size: ['500 nm', '220 nm'], center: ['0 um', '0 um'] } },
      { id: 'htr', type: 'rect', settings: { size: ['1 um', '200 nm'], center: ['0 um', '1.2 um'] } },
      { id: 'clad', type: 'difference', settings: { base: 'win', tools: ['core', 'htr'], keepTools: true } },
    ] },
    materials: [
      { id: 'Si', override: { n: prop('silicon', 'n', { lambda: lam }), k: { value: kOf('silicon'), unit: 'W/(m*K)' } }, select: ['dom:core'] },
      { id: 'SiO2', override: { n: prop('fused-silica', 'n', { lambda: lam }), k: { value: kOf('fused-silica'), unit: 'W/(m*K)' } }, select: ['dom:clad'] },
      { id: 'Au', override: { k: { value: kOf('gold'), unit: 'W/(m*K)' } }, select: ['dom:htr'] },
    ],
    physics: [
      { id: 'ht', type: 'heat', select: ['dom:core', 'dom:clad', 'dom:htr'], bcs: [
        { id: 'sink', type: 'temperature', select: ['bnd:win.bottom'], settings: { T: { value: Tref, unit: 'K' } } },
        { id: 'src', type: 'heat-source', select: ['dom:htr'], settings: { Q: 'Q' } },
      ] },
      { id: 'ewg', type: 'em-modes', select: ['dom:core', 'dom:clad'], settings: { order: 2 }, bcs: [{ id: 'w', type: 'pec', select: ['bnd:win.left', 'bnd:win.right', 'bnd:win.top', 'bnd:win.bottom'] }] },
    ],
    couplings: [{ id: 'to1', type: 'thermo-optic', from: 'ht', to: 'ewg', settings: { Tref: { value: Tref, unit: 'K' }, power: { value: Q * 1e-6 * 200e-9, unit: 'W/m' } } }],
    mesh: { size: { hmax: '0.3 um', grading: 0.3 }, refine: [{ select: ['dom:core'], h: '55 nm' }] },
    studies: [{ id: 'std', type: 'mode', physics: ['ht', 'ewg'], settings: { wavelength: { value: lam, unit: 'm' }, nModes: 1 } }],
  });
  const out: Array<Record<string, { value: number; unit: string }>> = [];
  for (const Q of [1e14, 2e14]) {   // W/m^3 test inputs (heater 1 um x 200 nm: 20 and 40 mW/mm)
    const prep = await prepareRun(mk(Q), { physicsId: 'ewg', studyId: 'std' });
    // dndT is not a valid override key of physicsRegistry() yet (request R0 to MC: register the @amp/materials
    // properties); set it on the resolved materials as prepareRun will once it is
    prep.materials.Si!.dndT = prop('silicon', 'dndT', { lambda: lam }) as number;
    prep.materials.SiO2!.dndT = prop('fused-silica', 'dndT', { lambda: lam, T: Tref }) as number;
    const sol = await runStudy(prep);
    out.push(sol.scalars);
    t.diagnostic(`Q ${Q} W/m^3: T_max ${sol.scalars['ht.T_max']?.value} K, dneff ${sol.scalars['ewg.dneff_0']?.value}, first order ${sol.scalars['ewg.dneffPert_0']?.value}, Ppi ${sol.scalars['ewg.Ppi_0']?.value} W`);
  }
  const [a, b] = out as unknown as [Record<string, { value: number }>, Record<string, { value: number }>];
  assert.ok(a['ewg.dneff_0']!.value > 0, 'heating raises n_eff (dn/dT > 0)');
  assert.ok(Math.abs(b['ewg.dneff_0']!.value / a['ewg.dneff_0']!.value - 2) < 1e-3, 'dneff linear in power');
  assert.ok(Math.abs(b['ewg.Ppi_0']!.value / a['ewg.Ppi_0']!.value - 1) < 1e-3, 'Ppi independent of power');
  assert.ok(Math.abs(a['ewg.dneffPert_0']!.value / a['ewg.dneff_0']!.value - 1) < 1e-3, 'first order vs direct');
});
