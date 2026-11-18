// SPDX-License-Identifier: GPL-3.0-or-later
// Model tree operations on geometry features, materials, physics nodes and boundary / domain conditions: add,
// delete, duplicate, rename. Each builder is pure and returns one JSON Patch (one op-log operation, so undo / redo
// and the YAML tab stay consistent) or a refusal with the reason. `applyTreeOp` applies one through a host (the
// workbench model, or the agent's op log wrapper).
//
// Rules (DevLog-051 s.2):
//   - ids are one namespace over the whole spec; new ids are `<prefix><n>`, the first free one.
//   - add: the node gets its id and type and empty required containers only (`select: []`, `settings: {}` when the
//     settings schema needs keys). Nothing physical is filled in; the node shows its validation issues until the form
//     is filled.
//   - delete: refused while the node's id (or an id inside it) is referenced elsewhere (selections, feature refs,
//     studies, couplings, result expressions, parity keys); dotted paths into the node (provenance keys, assumption
//     paths, missing entries) are removed in the same op and index-addressed paths of later siblings are shifted.
//   - duplicate: deep copy after the original with fresh ids (every nested id too: one namespace); index-addressed
//     dotted paths of later siblings are shifted up by one (as delete shifts them down).
//   - rename: references are updated in the same op (selection tokens incl. `&` pieces, feature refs, studies'
//     physics lists, coupling from / to, result expressions `<physics>.<name>`, parity keys, dotted paths). If the old
//     id is still found anywhere outside free text afterwards, or the optional validator reports new issues, the
//     rename is refused with the places named.
import { ENTITY_ID, NODE_ID, resolveDotted, type PathKey, type Registry, type SpaceDim } from '@amp/spec';
import type { JsonPatchOp } from '@amp/spec/types';
import { diffPatch } from './diff.ts';

type O = Record<string, unknown>;
const isObj = (x: unknown): x is O => !!x && typeof x === 'object' && !Array.isArray(x);
const arr = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
const str = (x: unknown): string => (typeof x === 'string' ? x : '');
const esc = (k: string | number) => String(k).replace(/~/g, '~0').replace(/\//g, '~1');
const ptrOf = (keys: readonly PathKey[]) => keys.map((k) => `/${esc(k)}`).join('');
const clone = <T>(x: T): T => structuredClone(x);

export type EditKind = 'feature' | 'material' | 'phys' | 'bc';
export const EDIT_KINDS: readonly EditKind[] = ['feature', 'material', 'phys', 'bc'];
/** Tree node kinds whose "+" adds a model node: Geometry (feature), Materials, Physics, a physics node (condition). */
export const ADD_PARENTS = ['geometry', 'materials', 'physics', 'phys'] as const;

export type EditResult =
	| { ok: true; patch: JsonPatchOp[]; id: string; pointer: string; note?: string }
	| { ok: false; reason: string };

/** One entry of a model "+" menu. */
export interface ModelMenuEntry {
	/** pointer of the parent: '/geometry', '/materials', '/physics' or '/physics/<i>' */
	parent: string;
	kind: EditKind;
	type: string;
	label: string;
	tip: string;
	disabled?: string;
}

export type TreeOp =
	| { op: 'add'; parent: string; type: string; id?: string }
	| { op: 'delete'; pointer: string }
	| { op: 'duplicate'; pointer: string; id?: string }
	| { op: 'rename'; pointer: string; id: string };

/** Validation issues of a spec (for the rename guard); only `message` and `pointer` are read. */
export type Validator = (data: unknown) => ReadonlyArray<{ pointer: string; message: string }>;

// ---- locating nodes ----------------------------------------------------------------------------------------------

/** Concrete keys of a pointer; `@id` tokens address array elements by id. Null when it does not resolve. */
function keysAt(data: unknown, pointer: string): PathKey[] | null {
	if (pointer === '') return [];
	if (!pointer.startsWith('/')) return null;
	const keys: PathKey[] = [];
	let cur: unknown = data;
	for (const raw of pointer.slice(1).split('/')) {
		const t = raw.replace(/~1/g, '/').replace(/~0/g, '~');
		if (Array.isArray(cur)) {
			const i = t.startsWith('@') ? cur.findIndex((e) => isObj(e) && e.id === t.slice(1)) : /^\d+$/.test(t) ? Number(t) : -1;
			if (i < 0 || i >= cur.length) return null;
			keys.push(i);
			cur = cur[i];
		} else if (isObj(cur) && Object.hasOwn(cur, t)) {
			keys.push(t);
			cur = cur[t];
		} else return null;
	}
	return keys;
}
function getKeys(data: unknown, keys: readonly PathKey[]): unknown {
	let cur = data;
	for (const k of keys) cur = Array.isArray(cur) ? cur[k as number] : isObj(cur) ? cur[k as string] : undefined;
	return cur;
}

export interface EditTarget {
	kind: EditKind;
	/** canonical pointer (indices) of the node and of its array */
	pointer: string;
	list: string;
	keys: PathKey[];
	index: number;
	node: O;
	id: string;
	/** physics type of the condition's physics (bc) or of the node (phys) */
	physicsType?: string;
}

/** The model node at a pointer (`/geometry/features/<i>`, `/materials/<i>`, `/physics/<i>`, `/physics/<i>/bcs/<j>`; `@id` tokens accepted). */
export function editTarget(data: unknown, pointer: string): EditTarget | null {
	const keys = keysAt(data, pointer);
	if (!keys) return null;
	const node = getKeys(data, keys);
	if (!isObj(node)) return null;
	const k = keys.map(String).join('/');
	let kind: EditKind | null = null;
	if (/^geometry\/features\/\d+$/.test(k)) kind = 'feature';
	else if (/^materials\/\d+$/.test(k)) kind = 'material';
	else if (/^physics\/\d+$/.test(k)) kind = 'phys';
	else if (/^physics\/\d+\/bcs\/\d+$/.test(k)) kind = 'bc';
	if (!kind) return null;
	const index = keys.at(-1) as number;
	const out: EditTarget = { kind, pointer: ptrOf(keys), list: ptrOf(keys.slice(0, -1)), keys, index, node, id: str(node.id) };
	const ph = kind === 'phys' ? node : kind === 'bc' ? getKeys(data, keys.slice(0, 2)) : null;
	if (isObj(ph) && typeof ph.type === 'string') out.physicsType = ph.type;
	return out;
}

/** Every string at an `id` key anywhere in the data (one id namespace). */
export function allIds(data: unknown, out = new Set<string>()): Set<string> {
	if (Array.isArray(data)) for (const x of data) allIds(x, out);
	else if (isObj(data)) for (const [k, v] of Object.entries(data)) { if (k === 'id' && typeof v === 'string') out.add(v); else allIds(v, out); }
	return out;
}
/** First free id `<prefix><n>` (n from 1); the prefix is reduced to id characters. */
export function freshId(used: Set<string>, prefix: string): string {
	let p = prefix.replace(/[^A-Za-z0-9_]/g, '_').replace(/^[^A-Za-z_]+/, '') || 'n';
	if (p.length > 56) p = p.slice(0, 56);
	for (let n = 1; ; n++) { const id = `${p}${n}`; if (!used.has(id)) { used.add(id); return id; } }
}

/** Why `id` cannot be a new node id ('' when it can). */
export function idProblem(data: unknown, id: string, except?: string): string {
	if (!NODE_ID.test(id)) return `'${id}' is not a valid id: a letter or underscore, then letters, digits, _ or - (at most 64)`;
	if (id !== except && allIds(data).has(id)) return `id '${id}' is already used in this model (ids are unique across the whole model)`;
	return '';
}

// ---- references --------------------------------------------------------------------------------------------------

/** Keys whose string values are free text (never references). */
const TEXT_KEYS = new Set(['label', 'description', 'title', 'text', 'note', 'source', 'what', 'date', 'basis', 'schema', 'type', 'unit', 'ref', 'mesher']);
/** Top-level sections whose strings are dotted paths or prose, handled separately. */
const PATH_SECTIONS = new Set(['provenance', 'assumptions', 'missing']);

const reEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** `<id>.` as an expression prefix (not after a letter, digit, `_` or `.`); selection strings are not expressions. */
const exprRe = (id: string) => new RegExp(`(^|[^A-Za-z0-9_.])${reEsc(id)}(?=\\.[A-Za-z_])`, 'g');

function selPieces(s: string): { kind: string; pieces: string[]; rest: string } | null {
	const m = ENTITY_ID.exec(s);
	return m ? { kind: m[1]!, pieces: m[2]!.split('&'), rest: `${m[3] ?? ''}${m[4] ?? ''}` } : null;
}

/** Places (JSON Pointers) where `id` is referenced, outside `skip` (a pointer prefix) and the path sections. */
export function referencesTo(data: unknown, id: string, skip = ''): string[] {
	const out: string[] = [];
	const re = exprRe(id);
	const walk = (v: unknown, keys: PathKey[], key: string) => {
		const p = ptrOf(keys);
		if (skip && (p === skip || p.startsWith(`${skip}/`))) return;
		if (keys.length === 1 && PATH_SECTIONS.has(String(keys[0]))) return;
		if (typeof v === 'string') {
			if (TEXT_KEYS.has(key)) return;
			const sel = selPieces(v);
			re.lastIndex = 0;
			if (v === id || (sel ? sel.pieces.includes(id) : re.test(v))) out.push(p);
			return;
		}
		if (Array.isArray(v)) { v.forEach((x, i) => walk(x, [...keys, i], key)); return; }
		if (isObj(v)) for (const [k, x] of Object.entries(v)) {
			if (k === 'id') continue;
			// record keys `<physics>.<field>` (results parity)
			if (key === 'parity' && (k === id || k.startsWith(`${id}.`))) out.push(`${p}/${esc(k)}`);
			walk(x, [...keys, k], k);
		}
	};
	walk(data, [], '');
	return out;
}

function listRefs(refs: string[]): string {
	return refs.length > 6 ? `${refs.slice(0, 6).join(', ')} and ${refs.length - 6} more` : refs.join(', ');
}

/** Dotted-path holders of the spec: provenance keys, assumption paths, missing paths. */
interface DottedSite { where: 'prov' | 'assume' | 'missing'; i?: number; j?: number; path: string }
function dottedSites(data: unknown): DottedSite[] {
	if (!isObj(data)) return [];
	const out: DottedSite[] = [];
	const prov = isObj(data.provenance) && isObj(data.provenance.values) ? data.provenance.values : {};
	for (const k of Object.keys(prov)) out.push({ where: 'prov', path: k });
	arr(data.assumptions).forEach((a, i) => { if (isObj(a)) arr(a.paths).forEach((p, j) => { if (typeof p === 'string') out.push({ where: 'assume', i, j, path: p }); }); });
	arr(data.missing).forEach((m, i) => { if (isObj(m) && typeof m.path === 'string') out.push({ where: 'missing', i, path: m.path }); });
	return out;
}
const startsWithKeys = (a: readonly PathKey[], b: readonly PathKey[]) => a.length >= b.length && b.every((k, i) => a[i] === k);

/**
 * Rewrite the dotted paths of `doc` (a clone of `data`) for a node at `keys`: `rename` replaces the id segment;
 * `remove` drops paths into the node and shifts index segments of later siblings down by one; `insertAfter` (a copy
 * inserted right after the node) shifts index segments of later siblings up by one (paths into the node stay).
 */
function rewriteDotted(data: unknown, doc: O, keys: readonly PathKey[], act: { rename: string } | { remove: true } | { insertAfter: true }): { missingGone: number[] } {
	const d = keys.length - 1;
	const list = keys.slice(0, -1), idx = keys[d] as number;
	const id = str((getKeys(data, keys) as O | undefined)?.id);
	const missingGone: number[] = [];
	const provOld = isObj(doc.provenance) && isObj(doc.provenance.values) ? doc.provenance.values : null;
	const newProv: Array<[string, unknown]> = [];
	const dropAssume = new Map<number, Set<number>>();
	const fixAssume = new Map<string, string>();
	for (const s of dottedSites(data)) {
		const k = resolveDotted(data, s.path);
		if (!k) continue;
		const seg = s.path.split('.');
		if (seg.length !== k.length) continue;
		let next: string | null = s.path;
		if (startsWithKeys(k, keys)) {
			if ('rename' in act) { if (seg[d] === id) { seg[d] = act.rename; next = seg.join('.'); } }
			else if ('remove' in act) next = null;
		} else if (!('rename' in act) && startsWithKeys(k, list) && (k[d] as number) > idx && /^\d+$/.test(seg[d]!)) {
			seg[d] = String((k[d] as number) + ('remove' in act ? -1 : 1));
			next = seg.join('.');
		}
		if (next === s.path) continue;
		if (s.where === 'prov' && provOld) newProv.push([s.path, next]);
		else if (s.where === 'assume') {
			if (next === null) { const set = dropAssume.get(s.i!) ?? new Set(); set.add(s.j!); dropAssume.set(s.i!, set); }
			else fixAssume.set(`${s.i}/${s.j}`, next);
		} else if (s.where === 'missing') {
			if (next === null) missingGone.push(s.i!);
			else ((doc.missing as O[])[s.i!] as O).path = next;
		}
	}
	if (provOld && newProv.length) {
		// rebuild in the original key order (renamed keys keep their place)
		const map = new Map(newProv);
		const rebuilt: O = {};
		for (const [k, v] of Object.entries(provOld)) {
			if (!map.has(k)) { rebuilt[k] = v; continue; }
			const nk = map.get(k);
			if (typeof nk === 'string') rebuilt[nk] = v;
		}
		(doc.provenance as O).values = rebuilt;
	}
	for (const [key, v] of fixAssume) { const [i, j] = key.split('/').map(Number); ((doc.assumptions as O[])[i!]!.paths as string[])[j!] = v; }
	for (const [i, js] of dropAssume) {
		const a = (doc.assumptions as O[])[i]!;
		const kept = (a.paths as string[]).filter((_, j) => !js.has(j));
		if (kept.length) a.paths = kept; else delete a.paths;
	}
	return { missingGone };
}

// ---- add ---------------------------------------------------------------------------------------------------------

const spaceOf = (data: unknown): SpaceDim | null => {
	const g = isObj(data) && isObj(data.geometry) ? data.geometry : null;
	if (!g) return null;
	return g.dim === 1 ? '1d' : g.dim === 2 ? (g.axisym ? '2d-axisym' : '2d') : g.dim === 3 ? '3d' : null;
};
const firstLine = (s: string | undefined) => (s ?? '').split(/(?<=\.)\s|\n/)[0] ?? '';
/** settings `{}` is accepted (the key may be left out) */
const settingsOptional = (r: { settings?: { safeParse(x: unknown): { success: boolean } } }) => !r.settings || r.settings.safeParse({}).success;

/** "+" menu of a tree node: features (Geometry), a blank material (Materials), physics types (Physics), conditions of a physics node. */
export function modelAddMenu(data: unknown, reg: Registry, pointer: string): ModelMenuEntry[] {
	const space = spaceOf(data);
	const okDim = (dims: readonly SpaceDim[] | undefined) => !dims || !space || dims.includes(space);
	if (pointer === '/geometry') {
		return reg.list('feature').map((r) => ({
			parent: pointer, kind: 'feature' as const, type: r.type, label: r.type, tip: `${firstLine(r.description) || r.type}\nadds {id, type}${settingsOptional(r) ? '' : ' and empty settings to fill in the form'}`,
			...(okDim(r.dims) ? {} : { disabled: `not for ${space} models (supports ${r.dims!.join(', ')})` })
		}));
	}
	if (pointer === '/materials') return [{ parent: pointer, kind: 'material', type: 'material', label: 'Material', tip: 'a material with an empty selection; choose a library ref or override values in the form' }];
	if (pointer === '/physics') {
		return reg.list('physics').map((r) => ({
			parent: pointer, kind: 'phys' as const, type: r.type, label: r.type, tip: `${firstLine(r.description) || r.type}\nadds {id, type, select: []}; choose the domains in the form`,
			...(okDim(r.dims) ? {} : { disabled: `not for ${space} models (supports ${r.dims!.join(', ')})` })
		}));
	}
	const t = editTarget(data, pointer);
	if (t?.kind === 'phys' && t.physicsType) {
		return reg.bcsFor(t.physicsType).map((r) => ({ parent: t.pointer, kind: 'bc' as const, type: r.type, label: r.type, tip: `${firstLine(r.description) || r.type}\nselects ${(r.select ?? []).join(' or ') || 'entities'}; choose them in the form` }));
	}
	return [];
}

/** Add a node of `type` under a parent ('/geometry', '/materials', '/physics', or a physics node for a condition). */
export function addNodePatch(data: unknown, reg: Registry | null, parent: string, type: string, id?: string): EditResult {
	if (!isObj(data)) return { ok: false, reason: 'no model data' };
	const used = allIds(data);
	const pick = (prefix: string): string | { reason: string } => {
		if (id === undefined) return freshId(used, prefix);
		const why = idProblem(data, id);
		return why ? { reason: why } : id;
	};
	const settingsFor = (r: { settings?: { safeParse(x: unknown): { success: boolean } } } | undefined) => (r && !settingsOptional(r) ? { settings: {} } : {});
	if (parent === '/geometry') {
		if (!isObj(data.geometry)) return { ok: false, reason: 'the model has no geometry block' };
		const r = reg?.get('feature', type);
		if (reg && !r) return { ok: false, reason: `unknown feature type '${type}' (types: ${reg.list('feature').map((x) => x.type).join(', ')})` };
		if (r?.dims && spaceOf(data) && !r.dims.includes(spaceOf(data)!)) return { ok: false, reason: `feature type '${type}' does not support ${spaceOf(data)} models` };
		const nid = pick(type);
		if (typeof nid !== 'string') return { ok: false, ...nid };
		const n = arr(data.geometry.features).length;
		const node = { id: nid, type, ...settingsFor(r) };
		return Array.isArray(data.geometry.features)
			? { ok: true, patch: [{ op: 'add', path: `/geometry/features/${n}`, value: node }], id: nid, pointer: `/geometry/features/${n}` }
			: { ok: true, patch: [{ op: 'add', path: '/geometry/features', value: [node] }], id: nid, pointer: '/geometry/features/0' };
	}
	if (parent === '/materials') {
		if (type !== 'material') return { ok: false, reason: `under /materials the type is 'material' (got '${type}'); choose a library ref or override values in the new node` };
		const nid = pick('mat');
		if (typeof nid !== 'string') return { ok: false, ...nid };
		const node = { id: nid, select: [] as string[] };
		const n = arr(data.materials).length;
		return Array.isArray(data.materials)
			? { ok: true, patch: [{ op: 'add', path: `/materials/${n}`, value: node }], id: nid, pointer: `/materials/${n}`, note: 'choose a library ref or override values, and the domains' }
			: { ok: true, patch: [{ op: 'add', path: '/materials', value: [node] }], id: nid, pointer: '/materials/0', note: 'choose a library ref or override values, and the domains' };
	}
	if (parent === '/physics') {
		const r = reg?.get('physics', type);
		if (reg && !r) return { ok: false, reason: `unknown physics type '${type}' (types: ${reg.list('physics').map((x) => x.type).join(', ')})` };
		if (r?.dims && spaceOf(data) && !r.dims.includes(spaceOf(data)!)) return { ok: false, reason: `physics type '${type}' does not support ${spaceOf(data)} models` };
		const nid = pick(type);
		if (typeof nid !== 'string') return { ok: false, ...nid };
		const node = { id: nid, type, select: [] as string[], ...settingsFor(r) };
		const n = arr(data.physics).length;
		return Array.isArray(data.physics)
			? { ok: true, patch: [{ op: 'add', path: `/physics/${n}`, value: node }], id: nid, pointer: `/physics/${n}`, note: 'choose the domains; a study must list it to be solved' }
			: { ok: true, patch: [{ op: 'add', path: '/physics', value: [node] }], id: nid, pointer: '/physics/0', note: 'choose the domains; a study must list it to be solved' };
	}
	const t = editTarget(data, parent);
	if (t?.kind === 'phys') {
		const r = reg && t.physicsType ? reg.getBc(t.physicsType, type) : undefined;
		if (reg && !r) return { ok: false, reason: `condition type '${type}' does not apply to physics type '${t.physicsType ?? 'N/A'}'` };
		const nid = pick(type);
		if (typeof nid !== 'string') return { ok: false, ...nid };
		const node = { id: nid, type, select: [] as string[], ...settingsFor(r) };
		const n = arr(t.node.bcs).length;
		return Array.isArray(t.node.bcs)
			? { ok: true, patch: [{ op: 'add', path: `${t.pointer}/bcs/${n}`, value: node }], id: nid, pointer: `${t.pointer}/bcs/${n}`, note: 'choose the entities in the form' }
			: { ok: true, patch: [{ op: 'add', path: `${t.pointer}/bcs`, value: [node] }], id: nid, pointer: `${t.pointer}/bcs/0`, note: 'choose the entities in the form' };
	}
	return { ok: false, reason: `nothing can be added under ${parent || '/'} (parents: /geometry, /materials, /physics, a physics node)` };
}

// ---- delete ------------------------------------------------------------------------------------------------------

export function deleteNodePatch(data: unknown, pointer: string): EditResult {
	const t = editTarget(data, pointer);
	if (!t) return { ok: false, reason: `no geometry feature, material, physics or condition at ${pointer}` };
	const ids = [...allIds(t.node)];
	const refs: string[] = [];
	for (const id of ids) for (const r of referencesTo(data, id, t.pointer)) refs.push(id === t.id ? r : `${r} (${id})`);
	if (refs.length) return { ok: false, reason: `'${t.id}' is still referenced at ${listRefs(refs)}; remove those references first (Undo restores a delete, but a dangling reference would not validate)` };
	const doc = clone(data) as O;
	const { missingGone } = rewriteDotted(data, doc, t.keys, { remove: true });
	// remove the node from the clone, then diff the rest; explicit removes keep the YAML splice small
	const patch: JsonPatchOp[] = [{ op: 'remove', path: t.pointer }];
	(getKeys(doc, t.keys.slice(0, -1)) as unknown[]).splice(t.index, 1);
	for (const i of [...missingGone].sort((a, b) => b - a)) { patch.push({ op: 'remove', path: `/missing/${i}` }); (doc.missing as unknown[]).splice(i, 1); }
	const base = clone(data) as O;
	(getKeys(base, t.keys.slice(0, -1)) as unknown[]).splice(t.index, 1);
	for (const i of [...missingGone].sort((a, b) => b - a)) (base.missing as unknown[]).splice(i, 1);
	patch.push(...diffPatch(base, doc));
	return { ok: true, patch, id: t.id, pointer: t.list, ...(patch.length > 1 ? { note: 'provenance, assumption or missing paths into the node were updated' } : {}) };
}

// ---- duplicate ---------------------------------------------------------------------------------------------------

export function duplicateNodePatch(data: unknown, pointer: string, id?: string): EditResult {
	const t = editTarget(data, pointer);
	if (!t) return { ok: false, reason: `no geometry feature, material, physics or condition at ${pointer}` };
	const used = allIds(data);
	if (id !== undefined) { const why = idProblem(data, id); if (why) return { ok: false, reason: why }; used.add(id); }
	const prefix = (x: string) => `${x.replace(/\d+$/, '') || 'n'}_copy`;
	const copy = clone(t.node);
	copy.id = id ?? freshId(used, prefix(t.id));
	// one id namespace: every nested `id` of the copy (a physics node's conditions, ids inside a feature, material or
	// condition) gets a fresh one too, in document order
	const renest = (v: unknown): void => {
		if (Array.isArray(v)) { for (const x of v) renest(x); return; }
		if (!isObj(v)) return;
		for (const [k, x] of Object.entries(v)) { if (k === 'id' && typeof x === 'string') v.id = freshId(used, prefix(x)); else renest(x); }
	};
	for (const [k, x] of Object.entries(copy)) if (k !== 'id') renest(x);
	const p = `${t.list}/${t.index + 1}`;
	// index-addressed dotted paths (provenance keys, assumption paths, missing paths) of later siblings shift up by one,
	// exactly as delete shifts them down; paths into the original node keep pointing at it
	const doc = clone(data) as O;
	rewriteDotted(data, doc, t.keys, { insertAfter: true });
	const patch: JsonPatchOp[] = [{ op: 'add', path: p, value: copy }];
	const base = clone(data) as O;
	(getKeys(base, t.keys.slice(0, -1)) as unknown[]).splice(t.index + 1, 0, clone(copy));
	(getKeys(doc, t.keys.slice(0, -1)) as unknown[]).splice(t.index + 1, 0, clone(copy));
	patch.push(...diffPatch(base, doc));
	return { ok: true, patch, id: String(copy.id), pointer: p, ...(patch.length > 1 ? { note: 'index-addressed provenance, assumption or missing paths of later nodes were shifted' } : {}) };
}

// ---- rename ------------------------------------------------------------------------------------------------------

/** Replace references to `from` by `to` in every non-text string of `v` (in place on a clone); returns the new value. */
function rewriteRefs(v: unknown, from: string, to: string, kind: EditKind, key: string, featRefKey: (k: string) => boolean, inFeatureSettings: boolean): unknown {
	if (typeof v === 'string') {
		if (TEXT_KEYS.has(key)) return v;
		const sel = selPieces(v);
		if (sel && kind === 'feature' && sel.pieces.includes(from)) return `${sel.kind}:${sel.pieces.map((p) => (p === from ? to : p)).join('&')}${sel.rest}`;
		if (v === from) {
			if (kind === 'feature' && inFeatureSettings && featRefKey(key)) return to;
			if (kind === 'phys' && (key === 'physics' || key === 'from' || key === 'to')) return to;
			return v;
		}
		if (kind === 'phys' && !sel) return v.replace(exprRe(from), (_m, pre: string) => `${pre}${to}`);
		return v;
	}
	if (Array.isArray(v)) return v.map((x) => rewriteRefs(x, from, to, kind, key, featRefKey, inFeatureSettings));
	if (isObj(v)) {
		const out: O = {};
		for (const [k, x] of Object.entries(v)) {
			const nk = kind === 'phys' && key === 'parity' && (k === from || k.startsWith(`${from}.`)) ? `${to}${k.slice(from.length)}` : k;
			out[nk] = k === 'id' ? x : rewriteRefs(x, from, to, kind, k, featRefKey, inFeatureSettings);
		}
		return out;
	}
	return v;
}

/**
 * Rename a node and update the references to it in the same patch. Refused when the new id is invalid or taken, when
 * the old id is still referenced somewhere the rename cannot update (listed), or when `validate` reports new issues.
 */
export function renameNodePatch(data: unknown, pointer: string, newId: string, o: { reg?: Registry | null; validate?: Validator } = {}): EditResult & { updated?: string[] } {
	const t = editTarget(data, pointer);
	if (!t) return { ok: false, reason: `no geometry feature, material, physics or condition at ${pointer}` };
	if (newId === t.id) return { ok: false, reason: `the id is already '${newId}'` };
	const why = idProblem(data, newId);
	if (why) return { ok: false, reason: why };
	const from = t.id;
	const doc = clone(data) as O;
	// feature refs: settings keys the feature type lists (`refs`), else any settings key
	const featRefsOf = (f: O): ((k: string) => boolean) => {
		const r = t.kind === 'feature' && o.reg ? o.reg.get('feature', str(f.type))?.refs : undefined;
		return r ? (k: string) => r.includes(k) : () => true;
	};
	for (const k of Object.keys(doc)) {
		if (PATH_SECTIONS.has(k)) continue;
		if (k === 'geometry' && isObj(doc.geometry)) {
			const g = doc.geometry;
			if (Array.isArray(g.features)) g.features = g.features.map((f) => (isObj(f) ? { ...f, ...(isObj(f.settings) ? { settings: rewriteRefs(f.settings, from, newId, t.kind, 'settings', featRefsOf(f), true) } : {}) } : f));
			continue;
		}
		doc[k] = rewriteRefs(doc[k], from, newId, t.kind, k, () => false, false);
	}
	(getKeys(doc, t.keys) as O).id = newId;
	rewriteDotted(data, doc, t.keys, { rename: newId });
	// residual scan: the old id must be gone (outside free text and the path sections)
	const left = referencesTo(doc, from);
	if (left.length) return { ok: false, reason: `'${from}' is also used at ${listRefs(left)}, which a rename does not update; edit those in the YAML tab, or rename there` };
	if (o.validate) {
		const before = new Set(o.validate(data).map((i) => i.message));
		const added = o.validate(doc).filter((i) => !before.has(i.message.split(newId).join(from)));
		if (added.length) return { ok: false, reason: `renaming '${from}' to '${newId}' would add ${added.length} validation issue(s): ${added.slice(0, 3).map((i) => `${i.pointer}: ${i.message}`).join('; ')}` };
	}
	const patch = diffPatch(data, doc);
	const updated = patch.map((p) => p.path).filter((p) => p !== `${t.pointer}/id`);
	return { ok: true, patch, id: newId, pointer: t.pointer, updated, ...(updated.length ? { note: `${updated.length} reference(s) updated` } : {}) };
}

// ---- one entry point (UI and agent tools) ------------------------------------------------------------------------

export function treeOpPatch(data: unknown, op: TreeOp, o: { reg?: Registry | null; validate?: Validator } = {}): EditResult {
	switch (op.op) {
		case 'add': return addNodePatch(data, o.reg ?? null, op.parent, op.type, op.id);
		case 'delete': return deleteNodePatch(data, op.pointer);
		case 'duplicate': return duplicateNodePatch(data, op.pointer, op.id);
		case 'rename': return renameNodePatch(data, op.pointer, op.id, o);
	}
}

/** What applies a patch as one operation: the workbench model (`ModelState`) or an agent wrapper on `applyAgent`. */
export interface EditHost {
	readonly data: unknown;
	apply(patch: JsonPatchOp[], reason: string): Promise<unknown>;
}

export const describeOp = (op: TreeOp, r: { id: string }): string =>
	op.op === 'add' ? `add ${op.type} ${r.id}` : op.op === 'delete' ? `delete ${r.id}` : op.op === 'duplicate' ? `duplicate as ${r.id}` : `rename to ${r.id}`;

/** Build and apply one tree op; refusals (and a failed apply) come back with the reason, nothing is applied. */
export async function applyTreeOp(host: EditHost, op: TreeOp, o: { reg?: Registry | null; validate?: Validator; reason?: string } = {}): Promise<EditResult> {
	const r = treeOpPatch(host.data, op, o);
	if (!r.ok) return r;
	try {
		const done = await host.apply(r.patch, o.reason ?? describeOp(op, r));
		if (done === null) return { ok: false, reason: 'the operation was not applied' };
	} catch (e) {
		return { ok: false, reason: (e as Error).message };
	}
	return r;
}
