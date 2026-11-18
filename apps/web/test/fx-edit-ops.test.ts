// SPDX-License-Identifier: GPL-3.0-or-later
// Duplicate in the model tree (state/edit-ops.ts, fix lane FX-web, DevLog-057 items 1-2): inserting the copy at
// <list>/<i+1> shifts index-addressed dotted paths (provenance keys, assumption paths, missing paths) of later siblings,
// so every such path still resolves to the same node after the op; nested ids of the copy are fresh (one namespace).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createOpLog, parseSpecText, resolveDotted } from '@amp/spec';
import { physicsRegistry } from '@amp/physics';
import { allIds, duplicateNodePatch, editTarget } from '../src/lib/state/edit-ops.ts';

const reg = physicsRegistry();
const sim = (id: string) => readFileSync(new URL(`../../../sims/${id}.yaml`, import.meta.url), 'utf8');
type O = Record<string, unknown>;

/** The nodes a dotted path runs through, by id where the array element has one (index otherwise), plus the leaf value. */
function signature(data: unknown, dotted: string, list: readonly (string | number)[] = []): string {
	const keys = resolveDotted(data, dotted);
	if (!keys) return `unresolved:${dotted}`;
	const out: string[] = [];
	let cur: unknown = data;
	for (const k of keys) {
		if (Array.isArray(cur)) {
			const e = cur[k as number] as O | undefined;
			out.push(e && typeof e === 'object' && typeof e.id === 'string' ? `@${e.id}` : String(k));
			cur = e;
		} else { out.push(String(k)); cur = (cur as O)[k as string]; }
	}
	// an ancestor of the list that receives the copy changes its value by design: compare the path only
	const ancestor = keys.length <= list.length && keys.every((k, i) => String(k) === String(list[i]));
	return ancestor ? out.join('/') : `${out.join('/')}=${JSON.stringify(cur)}`;
}
/** Every dotted path of the spec in a stable order: provenance keys (in order), assumption paths, missing paths. */
function dotted(data: O): string[] {
	const prov = Object.keys(((data.provenance as O | undefined)?.values as O | undefined) ?? {});
	const asm = ((data.assumptions as O[] | undefined) ?? []).flatMap((a) => (Array.isArray(a.paths) ? (a.paths as string[]) : []));
	const mis = ((data.missing as O[] | undefined) ?? []).flatMap((m) => (typeof m.path === 'string' ? [m.path] : []));
	return [...prov, ...asm, ...mis];
}
/** Pointers of every feature, material, physics node and condition. */
function targets(data: O): string[] {
	const out: string[] = [];
	((data.geometry as O).features as unknown[] ?? []).forEach((_, i) => out.push(`/geometry/features/${i}`));
	((data.materials as unknown[]) ?? []).forEach((_, i) => out.push(`/materials/${i}`));
	((data.physics as O[]) ?? []).forEach((p, i) => { out.push(`/physics/${i}`); ((p.bcs as unknown[]) ?? []).forEach((_, j) => out.push(`/physics/${i}/bcs/${j}`)); });
	return out;
}

async function checkAll(id: string): Promise<number> {
	const text = sim(id);
	const data0 = parseSpecText(text, reg).data as O;
	assert.ok(dotted(data0).every((p) => resolveDotted(data0, p)), `${id}: a dotted path does not resolve before the op`);
	let n = 0;
	for (const ptr of targets(data0)) {
		const list = ptr.split('/').slice(1, -1);
		// provenance keys may move to the end of the map (JSON Patch remove + add): compare as sorted lists
		const before = dotted(data0).map((p) => signature(data0, p, list)).sort();
		const log = await createOpLog(text, { registry: reg });
		const r = duplicateNodePatch(log.data, ptr);
		assert.ok(r.ok, `${id} ${ptr}: ${JSON.stringify(r)}`);
		await log.apply(r.patch, { actor: 'user', reason: 'test duplicate' });
		const data1 = log.data as O;
		const after = dotted(data1).map((p) => signature(data1, p, list)).sort();
		assert.deepEqual(after, before, `${id}: duplicate ${ptr} changed what a dotted path points at`);
		// the copy is right after the original, every id stays unique
		const t = editTarget(data1, r.pointer)!;
		assert.equal(t.id, r.id);
		const ids: string[] = [];
		const walk = (v: unknown) => { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (k === 'id' && typeof x === 'string') ids.push(x); else walk(x); } };
		walk(data1);
		assert.equal(new Set(ids).size, ids.length, `${id} ${ptr}: duplicate ids`);
		n++;
	}
	return n;
}

test('duplicate /geometry/features/0 of nafems-le11: provenance of zbox, c_in and upper still resolves to them', async () => {
	const text = sim('nafems-le11');
	const log = await createOpLog(text, { registry: reg });
	const r = duplicateNodePatch(log.data, '/geometry/features/0');
	assert.ok(r.ok);
	await log.apply(r.patch, { actor: 'user', reason: 'test' });
	const prov = ((log.data as O).provenance as O).values as O;
	const at = (k: string) => signature(log.data, k);
	assert.ok(Object.hasOwn(prov, 'geometry.features.2.settings.size'));
	assert.match(at('geometry.features.2.settings.size'), /^geometry\/features\/@zbox\/settings\/size=/);
	assert.match(at('geometry.features.4.settings.radius'), /^geometry\/features\/@c_in\/settings\/radius=/);
	assert.match(at('geometry.features.6.settings.points'), /^geometry\/features\/@upper\/settings\/points=/);
	// the original keeps its own path; the copy has none (provenance is not copied)
	assert.match(at('geometry.features.0.settings.radius'), /^geometry\/features\/@c_out\/settings\/radius=/);
	assert.ok(!Object.hasOwn(prov, 'geometry.features.1.settings.size') && !Object.hasOwn(prov, 'geometry.features.1.settings.radius'));
	// undo restores the text
	await log.undo({ actor: 'user' });
	assert.equal(log.text, text);
});

test('duplicate every node of nafems-le11, si-microheater-to, tfln-mzm-eo: all dotted paths resolve to the same nodes', async () => {
	for (const id of ['nafems-le11', 'si-microheater-to', 'tfln-mzm-eo']) assert.ok((await checkAll(id)) > 5, id);
});

test('duplicate gives fresh ids to nested ids of a feature, material or condition (one id namespace)', () => {
	const data = {
		schema: 'amp-spec/0', id: 'm',
		geometry: { dim: 2, features: [{ id: 'f', type: 'rect', settings: { parts: [{ id: 'p' }, { id: 'q' }] } }] },
		materials: [{ id: 'mat', select: [], layers: [{ id: 'ly' }] }],
		physics: [{ id: 'ph', type: 'heat', select: [], bcs: [{ id: 'b', type: 'temperature', select: [], extra: { id: 'inner' } }] }]
	};
	const ids = (v: unknown) => [...allIds(v)];
	const val = (r: { patch: ReadonlyArray<unknown> }) => (r.patch[0] as { value: unknown }).value;
	const f = duplicateNodePatch(data, '/geometry/features/0');
	assert.ok(f.ok);
	assert.deepEqual(ids(val(f)), ['f_copy1', 'p_copy1', 'q_copy1']);
	const m = duplicateNodePatch(data, '/materials/0');
	assert.ok(m.ok);
	assert.deepEqual(ids(val(m)), ['mat_copy1', 'ly_copy1']);
	const b = duplicateNodePatch(data, '/physics/0/bcs/0');
	assert.ok(b.ok);
	assert.deepEqual(ids(val(b)), ['b_copy1', 'inner_copy1']);
	const p = duplicateNodePatch(data, '/physics/0');
	assert.ok(p.ok);
	assert.deepEqual(ids(val(p)), ['ph_copy1', 'b_copy1', 'inner_copy1']);
	// a given id for the copy is kept; nested ids still fresh and distinct from it
	const g = duplicateNodePatch(data, '/geometry/features/0', 'p_copy1');
	assert.ok(g.ok);
	assert.deepEqual(ids(val(g)), ['p_copy1', 'p_copy2', 'q_copy1']);
});
