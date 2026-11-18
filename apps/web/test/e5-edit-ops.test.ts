// SPDX-License-Identifier: GPL-3.0-or-later
// Model tree operations (state/edit-ops.ts): each op's patch (spec diff), applied through a real op log on the
// kirsch-plate and hot-arm-actuator sims (comment-preserving splice, undo restores the text), refusals with reasons,
// and rename reference updates. Expected diffs written out by hand from the sims files (lane E5, DevLog-051).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createOpLog, parseSpecText, validateSpec } from '@amp/spec';
import { physicsRegistry } from '@amp/physics';
import { addNodePatch, applyTreeOp, deleteNodePatch, duplicateNodePatch, editTarget, modelAddMenu, referencesTo, renameNodePatch, type EditHost } from '../src/lib/state/edit-ops.ts';

const sim = (id: string) => readFileSync(new URL(`../../../sims/${id}.yaml`, import.meta.url), 'utf8');
const KIRSCH = sim('kirsch-plate');
const reg = physicsRegistry();
const validate = (d: unknown) => validateSpec(d, reg).issues;

async function host(text: string) {
	const log = await createOpLog(text, { registry: reg });
	const h: EditHost & { log: typeof log } = { log, get data() { return log.data; }, apply: (p, reason) => log.apply(p, { actor: 'user', reason }) };
	return h;
}
const ok = <T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> => { assert.ok(r.ok, JSON.stringify(r)); return r as Extract<T, { ok: true }>; };
const no = (r: { ok: boolean; reason?: string }, re: RegExp) => { assert.equal(r.ok, false); assert.match(r.reason ?? '', re); };

test('editTarget: kinds, canonical pointers, @id tokens; other nodes are not targets', async () => {
	const d = (await host(KIRSCH)).data;
	assert.deepEqual([editTarget(d, '/geometry/features/1')?.kind, editTarget(d, '/geometry/features/1')?.id], ['feature', 'hole']);
	assert.equal(editTarget(d, '/materials/@steel')?.pointer, '/materials/0');
	assert.deepEqual([editTarget(d, '/physics/0')?.kind, editTarget(d, '/physics/0')?.physicsType], ['phys', 'elastic']);
	const bc = editTarget(d, '/physics/@solid/bcs/@tension')!;
	assert.deepEqual([bc.kind, bc.pointer, bc.list, bc.index, bc.physicsType], ['bc', '/physics/0/bcs/2', '/physics/0/bcs', 2, 'elastic']);
	assert.equal(editTarget(d, '/studies/0'), null);
	assert.equal(editTarget(d, '/results/plots/0'), null);
	assert.equal(editTarget(d, '/geometry/features/9'), null);
});

test('add: menus from the registry; templates hold id, type and empty containers only; one op; undo restores the text', async () => {
	const h = await host(KIRSCH);
	const feats = modelAddMenu(h.data, reg, '/geometry');
	assert.ok(feats.some((e) => e.type === 'rect' && !e.disabled));
	assert.ok(feats.every((e) => e.kind === 'feature' && e.parent === '/geometry'));
	const bcs = modelAddMenu(h.data, reg, '/physics/0');
	assert.ok(bcs.some((e) => e.type === 'roller') && bcs.every((e) => e.kind === 'bc'));
	assert.deepEqual(modelAddMenu(h.data, reg, '/studies'), []);

	const r = ok(addNodePatch(h.data, reg, '/geometry', 'rect'));
	assert.deepEqual(r.patch, [{ op: 'add', path: '/geometry/features/3', value: { id: 'rect1', type: 'rect', settings: {} } }]);
	const m = ok(addNodePatch(h.data, reg, '/materials', 'material'));
	assert.deepEqual(m.patch, [{ op: 'add', path: '/materials/1', value: { id: 'mat1', select: [] } }]);
	const b = ok(addNodePatch(h.data, reg, '/physics/0', 'fixed'));
	assert.equal(b.pointer, '/physics/0/bcs/4');
	assert.deepEqual((b.patch[0] as { value: unknown }).value, { id: 'fixed1', type: 'fixed', select: [] });
	const p = ok(addNodePatch(h.data, reg, '/physics', 'heat'));
	assert.equal((p.patch[0] as { value: { select: unknown[] } }).value.select.length, 0);

	const before = h.log.text;
	ok(await applyTreeOp(h, { op: 'add', parent: '/geometry', type: 'rect' }, { reg }));
	assert.equal(h.log.ops.length, 1);
	assert.ok(h.log.text.includes('# H1 Plate with a hole'), 'comments kept');
	assert.equal((h.data as { geometry: { features: unknown[] } }).geometry.features.length, 4);
	await h.log.undo({ actor: 'user' });
	assert.equal(h.log.text, before);

	no(addNodePatch(h.data, reg, '/geometry', 'nope'), /unknown feature type 'nope'/);
	no(addNodePatch(h.data, reg, '/geometry', 'rect', 'hole'), /already used/);
	no(addNodePatch(h.data, reg, '/geometry', 'rect', '9x'), /not a valid id/);
	no(addNodePatch(h.data, reg, '/physics/0', 'convection'), /does not apply to physics type 'elastic'/);
	no(addNodePatch(h.data, reg, '/studies', 'stationary'), /nothing can be added/);
	no(addNodePatch(h.data, reg, '/materials', 'rect'), /type is 'material'/);
	// fresh ids skip used ones
	ok(await applyTreeOp(h, { op: 'add', parent: '/geometry', type: 'rect' }, { reg }));
	assert.equal(ok(addNodePatch(h.data, reg, '/geometry', 'rect')).id, 'rect2');
});

test('delete: refused while referenced (places listed); unreferenced nodes removed in one op with their dotted paths', async () => {
	const h = await host(KIRSCH);
	no(deleteNodePatch(h.data, '/geometry/features/1'), /'hole' is still referenced at \/geometry\/features\/2\/settings\/tools\/0, \/physics\/0\/bcs\/3\/select\/1, \/mesh\/refine\/0\/select\/0/);
	no(deleteNodePatch(h.data, '/physics/0'), /'solid' is still referenced at .*\/studies\/0\/physics\/0.*\/results\/evaluations\/0\/items\/0\/expr/);
	no(deleteNodePatch(h.data, '/studies/0'), /no geometry feature/);
	// a condition: no references; the material: its provenance keys go with it
	const bc = ok(deleteNodePatch(h.data, '/physics/0/bcs/3'));
	assert.deepEqual(bc.patch, [{ op: 'remove', path: '/physics/0/bcs/3' }]);
	const mat = ok(deleteNodePatch(h.data, '/materials/0'));
	assert.deepEqual(mat.patch, [
		{ op: 'remove', path: '/materials/0' },
		{ op: 'remove', path: '/provenance/values/materials.steel.override.E' },
		{ op: 'remove', path: '/provenance/values/materials.steel.override.nu' }
	]);
	ok(await applyTreeOp(h, { op: 'delete', pointer: '/materials/0' }));
	assert.equal(h.log.ops.length, 1);
	assert.equal((h.data as { materials: unknown[] }).materials.length, 0);
	assert.ok(!h.log.text.includes('materials.steel'));
});

test('delete: index-addressed dotted paths of later siblings shift; paths into the node are removed', () => {
	const f = (id: string) => ({ id, type: 'rect', settings: { size: [1, 1] } });
	const d = {
		geometry: { dim: 2, features: [f('a'), f('b'), f('c')] },
		provenance: { values: { 'geometry.features.2.settings': { basis: 'user' }, 'geometry.features.b': { basis: 'user' }, 'geometry.features.0': { basis: 'user' } } },
		assumptions: [{ text: 't', paths: ['geometry.features.1', 'geometry.features.2'] }],
		missing: [{ path: 'geometry.features.b.settings', what: 'x' }, { path: 'geometry.features.2', what: 'y' }]
	};
	const r = ok(deleteNodePatch(d, '/geometry/features/1'));
	assert.deepEqual(r.patch, [
		{ op: 'remove', path: '/geometry/features/1' },
		{ op: 'remove', path: '/missing/0' },
		{ op: 'remove', path: '/provenance/values/geometry.features.2.settings' },
		{ op: 'remove', path: '/provenance/values/geometry.features.b' },
		{ op: 'add', path: '/provenance/values/geometry.features.1.settings', value: { basis: 'user' } },
		{ op: 'replace', path: '/assumptions/0/paths', value: ['geometry.features.1'] },
		{ op: 'replace', path: '/missing/0/path', value: 'geometry.features.1' }
	]);
});

test('duplicate: copy after the original with fresh ids (a physics node copies its conditions with new ids)', async () => {
	const h = await host(KIRSCH);
	const f = ok(duplicateNodePatch(h.data, '/geometry/features/1'));
	assert.deepEqual(f.patch, [{ op: 'add', path: '/geometry/features/2', value: { id: 'hole_copy1', type: 'circle', settings: { center: { value: [0, 0], unit: 'mm' }, radius: 'D/2' } } }]);
	const p = ok(duplicateNodePatch(h.data, '/physics/0'));
	const v = (p.patch[0] as { value: { id: string; bcs: Array<{ id: string }> } }).value;
	assert.equal(v.id, 'solid_copy1');
	assert.deepEqual(v.bcs.map((b) => b.id), ['sym_x_copy1', 'sym_y_copy1', 'tension_copy1', 'open_copy1']);
	no(duplicateNodePatch(h.data, '/geometry/features/1', 'plate'), /already used/);
	ok(await applyTreeOp(h, { op: 'duplicate', pointer: '/physics/0/bcs/0' }));
	assert.equal(h.log.ops.length, 1);
	assert.ok(parseSpecText(h.log.text, reg).issues.every((i) => i.code !== 'duplicate_id'));
});

test('rename feature: selections (incl. sub-entities), difference tools and refine updated in the same op; the result validates', async () => {
	const h = await host(KIRSCH);
	const r = ok(renameNodePatch(h.data, '/geometry/features/1', 'bore', { reg, validate }));
	assert.deepEqual(r.patch, [
		{ op: 'replace', path: '/geometry/features/1/id', value: 'bore' },
		{ op: 'replace', path: '/geometry/features/2/settings/tools/0', value: 'bore' },
		{ op: 'replace', path: '/physics/0/bcs/3/select/1', value: 'bnd:bore.edge' },
		{ op: 'replace', path: '/mesh/refine/0/select/0', value: 'bnd:bore.edge' },
		{ op: 'replace', path: '/results/evaluations/0/items/0/over/0', value: 'bnd:bore.edge' }
	]);
	ok(await applyTreeOp(h, { op: 'rename', pointer: '/geometry/features/1', id: 'bore' }, { reg, validate }));
	assert.equal(h.log.ops.length, 1);
	const pr = parseSpecText(h.log.text, reg);
	assert.ok(pr.ok, pr.issues.map((i) => i.message).join('; '));
	assert.deepEqual(referencesTo(h.data, 'hole'), []);
	assert.ok(h.log.text.includes('# x = 0 symmetry plane'), 'comments kept');
});

test('rename physics: studies, expressions and dotted paths; rename material: provenance keys follow', async () => {
	const h = await host(KIRSCH);
	const r = ok(renameNodePatch(h.data, '/physics/0', 'mech', { reg, validate }));
	assert.deepEqual(r.patch, [
		{ op: 'replace', path: '/physics/0/id', value: 'mech' },
		{ op: 'replace', path: '/studies/0/physics/0', value: 'mech' },
		{ op: 'replace', path: '/results/evaluations/0/items/0/expr', value: 'mech.sxx/sigma_inf' },
		{ op: 'replace', path: '/results/plots/0/items/0/expr', value: 'mech.sxx' }
	]);
	const m = ok(renameNodePatch(h.data, '/materials/0', 'st37'));
	const h2 = await host(KIRSCH);
	await h2.apply(m.patch, 'r');
	const keys = Object.keys((h2.data as { provenance: { values: object } }).provenance.values);
	assert.ok(keys.includes('materials.st37.override.E') && keys.includes('materials.st37.override.nu') && !keys.some((k) => k.includes('steel')));
	assert.ok(parseSpecText(h2.log.text, reg).ok);
	no(renameNodePatch(h.data, '/physics/0', 'hole'), /already used/);
	no(renameNodePatch(h.data, '/physics/0', 'solid'), /already 'solid'/);
	no(renameNodePatch(h.data, '/physics/0', 'a b'), /not a valid id/);
});

test('rename physics in a coupled model: coupling from / to and dotted paths into conditions', async () => {
	const h = await host(sim('hot-arm-actuator'));
	const d = h.data as { couplings?: Array<{ from: string; to: string }>; physics: Array<{ id: string }> };
	const src = d.couplings?.[0]?.from;
	assert.ok(src, 'hot-arm-actuator has a coupling');
	const i = d.physics.findIndex((p) => p.id === src);
	const r = ok(renameNodePatch(h.data, `/physics/${i}`, 'phx', { reg, validate }));
	assert.ok(r.patch.some((p) => p.path === '/couplings/0/from' || p.path === '/couplings/0/to'));
	await h.apply(r.patch, 'rename');
	assert.deepEqual(referencesTo(h.data, src!), []);
	assert.ok(parseSpecText(h.log.text, reg).ok);
});

test('rename refused when the old id stays somewhere the rename cannot update', () => {
	const d = {
		geometry: { dim: 2, features: [{ id: 'a', type: 'rect' }] },
		physics: [{ id: 'p', type: 'heat', select: ['dom:a'], settings: { target: 'a' } }]
	};
	no(renameNodePatch(d, '/geometry/features/0', 'b'), /'a' is also used at \/physics\/0\/settings\/target/);
});
