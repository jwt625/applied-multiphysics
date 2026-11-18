// SPDX-License-Identifier: GPL-3.0-or-later
// Model Builder tree (state/tree.ts) and tree selection -> graphics view (state/tree-view.ts). Hand-written spec data
// and mesh entity lists; expected nodes, pointers and highlight ids written out by hand (lane T1, DevLog-038).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SpecIssue } from '@amp/spec';
import type { Mesh } from '@amp/spec/types';
import { buildTree, findNode, RESULT_FOLDERS, type TreeNode } from '../src/lib/state/tree.ts';
import { expandIds, viewFor } from '../src/lib/state/tree-view.ts';

const issue = (pointer: string): SpecIssue => ({ path: [], dotted: '', pointer, code: 't', message: 't' });

const SPEC = {
	id: 'm1', title: 'Model one',
	params: { a: 1, b: '2 mm' },
	geometry: { dim: 2, axisym: true, features: [{ id: 'r', type: 'rect' }, { type: 'circle' }] },
	materials: [{ id: 'si' }],
	physics: [{ id: 'ht', type: 'heat', bcs: [{ id: 't0', type: 'temperature' }, { id: 'q', type: 'flux' }] }],
	mesh: { mesher: 'tri', size: { hmax: 1 }, refine: [{ select: ['bnd:a', 'bnd:b'] }] },
	studies: [{ id: 's1', type: 'stationary' }],
	results: {
		datasets: [{ id: 'd1', type: 'solution' }],
		evaluations: [{ id: 'e', items: [{ id: 'i1', type: 'max' }, { id: 'i2', type: 'min', enabled: false }] }],
		tables: [{ id: 't', from: 'e' }],
		plots: [{ id: 'p', type: 'plot2d', enabled: false, items: [{ id: 's', type: 'surface' }] }]
	},
	provenance: { values: { x: 1, y: 2 } },
	assumptions: ['one'],
	missing: []
};
const ISSUES = [issue('/physics/0/bcs/1/settings'), issue('/params/a'), issue('/physicsX')];

test('buildTree: top-level order, labels, subs and issue counts under each pointer', () => {
	const t = buildTree(SPEC, ISSUES);
	assert.deepEqual(t.map((n) => n.kind), ['model', 'params', 'geometry', 'materials', 'physics', 'mesh', 'studies', 'results', 'provenance', 'assumptions', 'missing']);
	const by = (k: TreeNode['kind']) => t.find((n) => n.kind === k)!;
	assert.deepEqual({ key: by('model').key, pointer: by('model').pointer, label: by('model').label, sub: by('model').sub, issues: by('model').issues }, { key: '/', pointer: '', label: 'Model one', sub: 'm1', issues: 3 });
	assert.equal(by('params').sub, '2');
	assert.equal(by('params').issues, 1);
	assert.equal(by('geometry').sub, '2D axisym');
	// '/physicsX' is not under '/physics'
	assert.equal(by('physics').issues, 1);
	assert.equal(by('provenance').sub, '2');
	assert.equal(by('assumptions').sub, '1');
	assert.equal(by('missing').sub, '0');
	assert.equal(t.some((n) => n.kind === 'couplings'), false);
});

test('buildTree: list children (features, bcs, refine) with id or #index labels and type subs', () => {
	const t = buildTree(SPEC, ISSUES);
	const geo = t.find((n) => n.kind === 'geometry')!;
	assert.deepEqual(geo.children.map((c) => [c.kind, c.pointer, c.label, c.sub]), [['feature', '/geometry/features/0', 'r', 'rect'], ['feature', '/geometry/features/1', '#1', 'circle']]);
	assert.deepEqual(geo.childKeys, ['features']);
	const ph = t.find((n) => n.kind === 'physics')!.children[0]!;
	assert.deepEqual([ph.kind, ph.label, ph.sub, ph.childKeys], ['phys', 'ht', 'heat', ['bcs']]);
	assert.deepEqual(ph.children.map((c) => [c.kind, c.pointer, c.label, c.issues]), [['bc', '/physics/0/bcs/0', 't0', 0], ['bc', '/physics/0/bcs/1', 'q', 1]]);
	const mesh = t.find((n) => n.kind === 'mesh')!;
	assert.equal(mesh.sub, 'tri');
	assert.deepEqual(mesh.children.map((c) => [c.kind, c.pointer, c.label, c.sub ?? '']), [['meshsize', '/mesh/size', 'Size', ''], ['refine', '/mesh/refine/0', 'Refine 1', 'bnd:a bnd:b']]);
});

test('buildTree: results folders, groups and items; disabled flags inherit from the group', () => {
	const r = buildTree(SPEC, []).find((n) => n.kind === 'results')!;
	assert.deepEqual(r.children.map((f) => [f.label, f.pointer, f.sub ?? '', f.section, f.addable]), RESULT_FOLDERS.map(([sec, label]) => [label, `/results/${sec}`, '1', sec, true]));
	const ev = r.children[1]!.children[0]!;
	assert.deepEqual([ev.pointer, ev.sub, ev.addable, ev.rid, ev.off], ['/results/evaluations/0', 'group', true, 'e', false]);
	assert.deepEqual(ev.children.map((c) => [c.pointer, c.rid, c.group, c.off, c.section]), [['/results/evaluations/0/items/0', 'i1', 'e', false, 'evaluations'], ['/results/evaluations/0/items/1', 'i2', 'e', true, 'evaluations']]);
	const tb = r.children[2]!.children[0]!;
	assert.deepEqual([tb.sub, tb.addable, tb.children.length], ['table of e', false, 0]);
	const pl = r.children[3]!.children[0]!;
	assert.equal(pl.off, true);
	assert.equal(pl.children[0]!.off, true, 'an item of a disabled group is shown disabled');
	const ds = r.children[0]!.children[0]!;
	assert.deepEqual([ds.sub, ds.addable], ['solution', false]);
});

test('buildTree: results folders exist without a results block; non-objects give no tree; findNode', () => {
	const t = buildTree({ id: 'x' }, []);
	assert.deepEqual(t.map((n) => n.kind), ['model', 'results']);
	assert.deepEqual(t[1]!.children.map((f) => [f.label, f.sub ?? '', f.children.length]), RESULT_FOLDERS.map(([, l]) => [l, '', 0]));
	assert.equal(t[0]!.label, 'x', 'title falls back to id');
	assert.deepEqual(buildTree(null, []), []);
	assert.deepEqual(buildTree([1, 2], []), []);
	const full = buildTree(SPEC, []);
	assert.equal(findNode(full, '/physics/0/bcs/1')?.label, 'q');
	assert.equal(findNode(full, '/results/plots/0/items/0')?.rid, 's');
	assert.equal(findNode(full, '/nope'), null);
});

// mesh entities: split pieces, parent and ancestors
const MESH = {
	entities: {
		domains: [{ id: 'dom:a#0' }, { id: 'dom:a#1' }, { id: 'dom:b', parent: ['dom:a'] }, { id: 'dom:c', ancestors: ['dom:z', 'dom:a'] }, { id: 'dom:d' }],
		boundaries: [{ id: 'bnd:a.left' }, { id: 'bnd:a#2' }, { id: 'bnd:a' }, { id: 'bnd:ab' }, { id: 'bnd:x', parent: ['bnd:y'] }]
	}
} as unknown as Mesh;

test('expandIds: exact, split pieces, parent and ancestor matches; fallback to the input ids', () => {
	assert.deepEqual(expandIds(['dom:a'], MESH), ['dom:a#0', 'dom:a#1', 'dom:b', 'dom:c']);
	assert.deepEqual(expandIds(['dom:d', 'bnd:y'], MESH), ['dom:d', 'bnd:x']);
	assert.deepEqual(expandIds(['nothing'], MESH), ['nothing']);
	assert.deepEqual(expandIds(['dom:a'], null), ['dom:a']);
	assert.deepEqual(expandIds([], MESH), []);
});

test('viewFor: view mode per node kind and the highlighted entity ids', () => {
	const data = {
		geometry: { features: [{ id: 'a', type: 'rect' }] },
		materials: [{ id: 'm', select: ['dom:d'] }],
		physics: [{ id: 'p', bcs: [{ id: 'b', select: ['bnd:y'] }] }],
		mesh: { refine: [{ select: ['dom:a'] }] },
		'x/y': { sel: { select: ['dom:d'] } }
	};
	const n = (kind: TreeNode['kind'], pointer: string): TreeNode => ({ key: pointer, label: '', pointer, kind, children: [], issues: 0 });
	assert.deepEqual(viewFor(null, data, MESH), { mode: null, ids: [] });
	assert.deepEqual(viewFor(n('geometry', '/geometry'), data, MESH), { mode: 'geometry', ids: [] });
	// feature a: domains made from it, and its named boundaries (bnd:a, bnd:a.<name>, bnd:a#k; not bnd:ab)
	assert.deepEqual(viewFor(n('feature', '/geometry/features/0'), data, MESH), { mode: 'geometry', ids: ['dom:a#0', 'dom:a#1', 'dom:b', 'dom:c', 'bnd:a.left', 'bnd:a#2', 'bnd:a'] });
	assert.deepEqual(viewFor(n('feature', '/geometry/features/0'), data, null), { mode: 'geometry', ids: ['dom:a'] });
	assert.deepEqual(viewFor(n('mesh', '/mesh'), data, MESH), { mode: 'mesh', ids: [] });
	assert.deepEqual(viewFor(n('meshsize', '/mesh/size'), data, MESH), { mode: 'mesh', ids: [] });
	assert.deepEqual(viewFor(n('refine', '/mesh/refine/0'), data, MESH), { mode: 'mesh', ids: ['dom:a#0', 'dom:a#1', 'dom:b', 'dom:c'] });
	for (const k of ['studies', 'study', 'results', 'result'] as const) assert.deepEqual(viewFor(n(k, '/studies'), data, MESH), { mode: 'results', ids: [] });
	for (const k of ['materials', 'physics', 'couplings'] as const) assert.deepEqual(viewFor(n(k, '/materials'), data, MESH), { mode: 'geometry', ids: [] });
	assert.deepEqual(viewFor(n('material', '/materials/0'), data, MESH), { mode: 'geometry', ids: ['dom:d'] });
	assert.deepEqual(viewFor(n('bc', '/physics/0/bcs/0'), data, MESH), { mode: 'geometry', ids: ['bnd:x'] });
	assert.deepEqual(viewFor(n('phys', '/physics/0'), data, MESH), { mode: 'geometry', ids: [] }, 'a physics without select highlights nothing');
	// JSON Pointer unescaping (~1 = '/')
	assert.deepEqual(viewFor(n('coupling', '/x~1y/sel'), data, MESH), { mode: 'geometry', ids: ['dom:d'] });
	for (const k of ['params', 'model', 'provenance', 'assumptions', 'missing'] as const) assert.deepEqual(viewFor(n(k, '/params'), data, MESH), { mode: null, ids: [] });
});
