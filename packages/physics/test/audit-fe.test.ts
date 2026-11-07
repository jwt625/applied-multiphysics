// SPDX-License-Identifier: GPL-3.0-or-later
// Audit fix lane FE (DevLog-031 s.9): thermal-expansion into an eigen study, sigma <= 0 cells in currents, electro-optic
// one-terminal limit, hex8 -> tet10 split per study, flattened tensor symmetry inference, photoelastic cells outside the
// optical domain. Values are test inputs (nominal numbers chosen for the check), not material data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSpecText } from '@amp/spec';
import type { Spec as SpecT } from '@amp/spec/types';
import { physicsRegistry, prepareRun, runStudy, studyReadiness } from '../src/index.ts';
import { materialTensor } from '../src/couplings/twoway.ts';
import { STIFFNESS_COMPONENTS, PIEZO_COMPONENTS } from '../src/coupled/tensors.ts';
import { photoelasticCells } from '../src/couplings/optomech.ts';

const q = (value: number | number[], unit: string) => ({ value, unit });
type Spec = Record<string, unknown>;
const parse = (s: Spec) => { const r = parseSpecText(JSON.stringify(s), physicsRegistry()); assert.ok(r.spec, JSON.stringify(r.issues.slice(0, 3))); return r.spec!; };

test('readiness: thermal-expansion into an eigen study is not supported (no thermal prestress in modal analysis)', () => {
  const mk = (type: 'eigen' | 'stationary'): Spec => ({
    schema: 'amp-spec/0', id: 'te', title: 'te',
    geometry: { dim: 2, features: [{ id: 'p', type: 'rect', settings: { size: q([1, 0.1], 'm'), center: q([0.5, 0.05], 'm') } }] },
    materials: [{ id: 'm', override: { k: q(10, 'W/(m*K)'), E: q(2e11, 'Pa'), nu: 0.3, rho: q(7800, 'kg/m^3'), alpha: q(1.2e-5, '1/K') }, select: ['dom:p'] }],
    physics: [
      { id: 'ht', type: 'heat', select: ['dom:p'], bcs: [{ id: 'T', type: 'temperature', select: ['bnd:p.left'], settings: { T: q(400, 'K') } }] },
      { id: 'solid', type: 'elastic', select: ['dom:p'], settings: { model: 'plane-stress' }, bcs: [{ id: 'f', type: 'fixed', select: ['bnd:p.left'] }] },
    ],
    couplings: [{ id: 'te', type: 'thermal-expansion', from: 'ht', to: 'solid', settings: { Tref: q(300, 'K') } }],
    mesh: { size: { hmax: q(0.05, 'm') } },
    studies: [type === 'eigen' ? { id: 's', type: 'eigen', physics: ['ht', 'solid'], settings: { nModes: 3 } } : { id: 's', type: 'stationary', physics: ['ht', 'solid'] }],
  });
  const eig = studyReadiness(parse(mk('eigen')));
  assert.ok(!eig.ready && eig.reasons.includes("coupling 'te': thermal-expansion into an eigen study is not supported (no thermal prestress in modal analysis)"), eig.reasons.join('; '));
  const st = studyReadiness(parse(mk('stationary')));
  assert.ok(!st.reasons.some((x) => x.includes('eigen study')), st.reasons.join('; '));
});

/** Two unit squares side by side: a (sigma 1 S/m) and b (sigma_b); ground on a.left, 1 V terminal on a.right. Test inputs. */
const twoDomain = (sigB: number, sigA = 1): Spec => ({
  schema: 'amp-spec/0', id: 'zs', title: 'zero sigma',
  geometry: { dim: 2, features: [
    { id: 'a', type: 'rect', settings: { size: q([1, 1], 'm'), center: q([0.5, 0.5], 'm') } },
    { id: 'b', type: 'rect', settings: { size: q([1, 1], 'm'), center: q([1.5, 0.5], 'm') } },
  ] },
  materials: [
    { id: 'cu', override: { sigma: q(sigA, 'S/m') }, select: ['dom:a'] },
    { id: 'ins', override: { sigma: q(sigB, 'S/m') }, select: ['dom:b'] },
  ],
  physics: [{ id: 'ec', type: 'currents', select: ['dom:a', 'dom:b'], bcs: [
    { id: 'g', type: 'ground', select: ['bnd:a.left'] }, { id: 't', type: 'terminal', select: ['bnd:a.right'], settings: { V: q(1, 'V') } }] }],
  mesh: { size: { hmax: q(0.25, 'm') } },
  studies: [{ id: 's', type: 'stationary', physics: ['ec'] }],
});

test('currents: sigma = 0 cells are outside the conduction domain (note names the material); R of the conducting square = 1 / sigma', async () => {
  const prep = await prepareRun(twoDomain(0), { physicsId: 'ec', library: null });
  const sol = await runStudy(prep) as Awaited<ReturnType<typeof runStudy>> & { notes?: string[] };
  // unit square, sigma 1 S/m, per unit depth: R = L / (sigma W) = 1 Ohm*m
  assert.ok(Math.abs(sol.scalars.R_t!.value - 1) < 1e-9, `R_t ${sol.scalars.R_t!.value}`);
  assert.ok(sol.notes?.some((n) => n.includes("'ins'") && n.includes('sigma <= 0') && n.includes('outside the conduction domain')), JSON.stringify(sol.notes));
  assert.ok(!sol.notes?.some((n) => n.includes("'cu'") && n.includes('sigma <= 0')));
  // Q is NaN (not part of the physics) in the insulator cells, finite in the conductor
  const Q = sol.fields.find((f) => f.name === 'Q')!.data;
  assert.ok(Q.some((v) => Number.isNaN(v)) && Q.some((v) => Number.isFinite(v)));
  // no conducting cell at all: run error
  const p0 = await prepareRun(twoDomain(0, 0), { physicsId: 'ec', library: null });
  await assert.rejects(runStudy(p0), /no conducting cell \(sigma > 0\)/);
});

test('readiness: electro-optic with a two-terminal electrostatics physics says that exactly one terminal is supported', () => {
  const spec: Spec = {
    schema: 'amp-spec/0', id: 'eo', title: 'eo',
    geometry: { dim: 2, features: [{ id: 'p', type: 'rect', settings: { size: q([1e-5, 1e-5], 'm'), center: q([0, 0], 'm') } }] },
    materials: [{ id: 'm', override: { eps_r: 2, n: 1.5 }, select: ['dom:p'] }],
    physics: [
      { id: 'es', type: 'electrostatics', select: ['dom:p'], bcs: [{ id: 'a', type: 'terminal', select: ['bnd:p.left'] }, { id: 'b', type: 'terminal', select: ['bnd:p.right'] }] },
      { id: 'ewg', type: 'em-modes', select: ['dom:p'], settings: { order: 2 }, bcs: [{ id: 'w', type: 'pec', select: ['bnd:p.top', 'bnd:p.bottom', 'bnd:p.left', 'bnd:p.right'] }] }],
    couplings: [{ id: 'eo', type: 'electro-optic', from: 'es', to: 'ewg', settings: { armB: 'none', terminal: 'a' } }],
    mesh: { size: { hmax: q(2e-6, 'm') } },
    studies: [{ id: 's', type: 'mode', physics: ['es', 'ewg'], settings: { wavelength: q(1.55e-6, 'm'), nModes: 1 } }],
  };
  const rd = studyReadiness(parse(spec));
  assert.ok(rd.reasons.some((x) => x.startsWith("coupling 'eo' (electro-optic): electrostatics 'es' has 2 terminal conditions (a, b)") && x.includes('exactly one terminal')), rd.reasons.join('; '));
});

test('prepareRun: hex8 box grid -> tet10 only when the selected study solves an elastic physics', async () => {
  const spec: Spec = {
    schema: 'amp-spec/0', id: 'hx', title: 'hx',
    geometry: { dim: 3, features: [
      { id: 'a', type: 'box', settings: { size: q([1e-3, 2e-4, 1e-4], 'm'), center: q([5e-4, 1e-4, 5e-5], 'm') } },
      { id: 'b', type: 'box', settings: { size: q([5e-4, 6e-4, 1e-4], 'm'), center: q([1.25e-3, 3e-4, 5e-5], 'm') } },
    ] },
    materials: [{ id: 'm', override: { k: q(100, 'W/(m*K)'), E: q(1e11, 'Pa'), nu: 0.25, alpha: q(1e-6, '1/K') }, select: ['dom:a', 'dom:b'] }],
    physics: [
      { id: 'ht', type: 'heat', select: ['dom:a', 'dom:b'], bcs: [{ id: 'T', type: 'temperature', select: ['bnd:a.xmin'], settings: { T: q(300, 'K') } }] },
      { id: 'solid', type: 'elastic', select: ['dom:a', 'dom:b'], settings: { model: '3d' }, bcs: [{ id: 'f', type: 'fixed', select: ['bnd:a.xmin'] }] },
    ],
    couplings: [{ id: 'te', type: 'thermal-expansion', from: 'ht', to: 'solid', settings: { Tref: q(300, 'K') } }],
    mesh: { size: { hmax: q(1e-4, 'm') } },
    studies: [{ id: 'sh', type: 'stationary', physics: ['ht'] }, { id: 'ss', type: 'stationary', physics: ['ht', 'solid'] }],
  };
  const heatOnly = await prepareRun(spec, { physicsId: 'ht', studyId: 'sh', library: null });
  assert.equal(heatOnly.mesh.cells.type, 'hex8');
  const withSolid = await prepareRun(spec, { physicsId: 'ht', studyId: 'ss', library: null });
  assert.equal(withSolid.mesh.cells.type, 'tet10');
  assert.ok(withSolid.notes.some((n) => n.includes('split into tet10')));
  // default study (no studyId): the first study of the physics, here the heat-only one
  assert.equal((await prepareRun(spec, { physicsId: 'ht', library: null })).mesh.cells.type, 'hex8');
});

test('materialTensor: flattened keys -> symmetry from the exact key set (C14 -> 3m, C66 -> 4mm, both -> error naming the material)', () => {
  const spec = { materials: [{ id: 'x', select: [] }] } as unknown as SpecT;
  const base = { 'C.C11': 1, 'C.C12': 2, 'C.C13': 3, 'C.C33': 4, 'C.C44': 5 };
  const sym = (rec: Record<string, number>, prop = 'C', comps = STIFFNESS_COMPONENTS) => materialTensor(spec, { x: rec }, 'x', prop, comps)?.sym ?? null;
  assert.equal(sym({ ...base, 'C.C14': 6 }), 'trigonal-3m');
  assert.equal(sym({ ...base, 'C.C66': 6 }), 'tetragonal-4mm');
  assert.equal(sym(base), 'hexagonal-6mm');
  assert.equal(sym({ 'C.C11': 1, 'C.C12': 2, 'C.C44': 3 }), 'cubic');
  assert.equal(sym({}), null);
  assert.throws(() => sym({ ...base, 'C.C14': 6, 'C.C66': 7 }), /material 'x': C components \{C11, C12, C13, C14, C33, C44, C66\} match no supported symmetry exactly/);
  assert.throws(() => sym({ 'C.C11': 1, 'C.C12': 2, 'C.C13': 3, 'C.C33': 4 }), /material 'x'/);
  // piezo e15, e31, e33: 6mm and 4mm share the key set and the tensor form
  assert.equal(sym({ 'e_piezo.e15': 1, 'e_piezo.e31': 2, 'e_piezo.e33': 3 }, 'e_piezo', PIEZO_COMPONENTS), 'hexagonal-6mm');
  assert.equal(sym({ 'e_piezo.e15': 1, 'e_piezo.e22': 4, 'e_piezo.e31': 2, 'e_piezo.e33': 3 }, 'e_piezo', PIEZO_COMPONENTS), 'trigonal-3m');
});

test('optomechanical: photoelastic solid cells outside the optical domain are skipped with a note (E = 0 there)', () => {
  // 5 cells: 0, 1 solid + optical (GaAs); 2 solid outside the optical domain (GaAs, photoelastic); 3 solid outside
  // (Si, not photoelastic); 4 optical only (air). End-to-end runs are blocked by emw-axisym: an optical selection that
  // leaves out mesh cells fails in its gradient projector (reported in DevLog-031 s.9).
  const sMask = Uint8Array.of(1, 1, 1, 1, 0), oMask = Uint8Array.of(1, 1, 0, 0, 1);
  const matOf = ['GaAs', 'GaAs', 'GaAs', 'Si', 'air'];
  const { mask, note } = photoelasticCells(sMask, oMask, matOf, (t) => matOf[t] === 'GaAs', 'opt');
  assert.deepEqual([...mask], [1, 1, 0, 0, 0]);
  assert.equal(note, "optomechanical: 1 cells of photoelastic 'GaAs' lie outside the optical domain 'opt'; skipped in the photoelastic integral (the optical mode is solved only inside its closed window, so E = 0 there in this model)");
  assert.equal(photoelasticCells(Uint8Array.of(1, 0), Uint8Array.of(1, 1), ['GaAs', 'air'], () => true, 'opt').note, null);
});
