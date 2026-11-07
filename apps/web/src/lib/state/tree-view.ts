// SPDX-License-Identifier: GPL-3.0-or-later
// Model tree -> graphics view (DevLog-020 s.1.5): the view mode a tree node opens and the entities it highlights.
// Geometry nodes open Geometry (a feature highlights its domains and boundaries), mesh nodes open Mesh (a refine node
// highlights its selection), study and result nodes open Results, materials / physics / boundary conditions open
// Geometry with their selection highlighted. Other nodes (params, model, provenance, ...) leave the mode unchanged.
// Highlight ids are expanded to the mesh's own entity ids (split pieces `id#k`, `parent` and `ancestors`), so the
// graphics view matches them exactly.
import type { Mesh } from '@amp/spec/types';
import type { TreeNode } from './tree';
import type { ViewMode } from './nav.svelte';

type Ent = { id: string; parent?: string[]; ancestors?: string[] };
type O = Record<string, unknown>;

const at = (data: unknown, pointer: string): unknown => {
	let cur = data;
	for (const k of pointer.split('/').slice(1)) cur = cur && typeof cur === 'object' ? (cur as O)[k.replace(/~1/g, '/').replace(/~0/g, '~')] : undefined;
	return cur;
};
const selOf = (x: unknown): string[] => {
	const s = x && typeof x === 'object' ? (x as { select?: unknown }).select : undefined;
	return Array.isArray(s) ? s.filter((v): v is string => typeof v === 'string') : [];
};

/** Mesh entity ids matched by selection ids (exact, split pieces, parent or ancestor). */
export function expandIds(ids: readonly string[], mesh: Mesh | null): string[] {
	if (!mesh || !ids.length) return [...ids];
	const want = new Set(ids);
	const hit = (e: Ent) => want.has(e.id) || ids.some((x) => e.id.startsWith(`${x}#`)) || !!e.parent?.some((p) => want.has(p)) || !!e.ancestors?.some((p) => want.has(p));
	const ents = [...(mesh.entities.domains as Ent[]), ...(mesh.entities.boundaries as Ent[])];
	const out = ents.filter(hit).map((e) => e.id);
	return out.length ? out : [...ids];
}

/** Entity ids of one geometry feature: its domain (and the domains made from it) and its named boundaries. */
function featureIds(f: string, mesh: Mesh | null): string[] {
	if (!mesh) return [`dom:${f}`];
	const d = `dom:${f}`;
	const doms = (mesh.entities.domains as Ent[]).filter((e) => e.id === d || e.id.startsWith(`${d}#`) || !!e.parent?.includes(d) || !!e.ancestors?.includes(d)).map((e) => e.id);
	const bnds = (mesh.entities.boundaries as Ent[]).filter((e) => e.id === `bnd:${f}` || e.id.startsWith(`bnd:${f}.`) || e.id.startsWith(`bnd:${f}#`)).map((e) => e.id);
	return [...doms, ...bnds];
}

export function viewFor(node: TreeNode | null, data: unknown, mesh: Mesh | null): { mode: ViewMode | null; ids: string[] } {
	if (!node) return { mode: null, ids: [] };
	const v = at(data, node.pointer);
	switch (node.kind) {
		case 'geometry': return { mode: 'geometry', ids: [] };
		case 'feature': {
			const id = v && typeof v === 'object' ? (v as { id?: unknown }).id : undefined;
			return { mode: 'geometry', ids: typeof id === 'string' ? featureIds(id, mesh) : [] };
		}
		case 'mesh': case 'meshsize': return { mode: 'mesh', ids: [] };
		case 'refine': return { mode: 'mesh', ids: expandIds(selOf(v), mesh) };
		case 'studies': case 'study': case 'results': case 'result': return { mode: 'results', ids: [] };
		case 'materials': case 'physics': case 'couplings': return { mode: 'geometry', ids: [] };
		case 'material': case 'phys': case 'bc': case 'coupling': return { mode: 'geometry', ids: expandIds(selOf(v), mesh) };
		default: return { mode: null, ids: [] };
	}
}
