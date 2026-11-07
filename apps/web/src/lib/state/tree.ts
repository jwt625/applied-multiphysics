// SPDX-License-Identifier: GPL-3.0-or-later
// Model Builder tree generated from the spec data (not a fixed tree): one node per spec block and per element of its
// lists, labelled by id and type; issue counts from the validation issues under each node's JSON Pointer.
// Results (DevLog-027): fixed folders with "+" menus (plot-ops.ts) and nodes flagged for the context actions.
import type { SpecIssue } from '@amp/spec';

export interface TreeNode {
	key: string;
	label: string;
	sub?: string;
	pointer: string;
	kind: 'params' | 'geometry' | 'feature' | 'materials' | 'material' | 'physics' | 'phys' | 'bc' | 'couplings' | 'coupling' | 'mesh' | 'meshsize' | 'refine' | 'studies' | 'study' | 'results' | 'rfolder' | 'result' | 'provenance' | 'assumptions' | 'missing' | 'model';
	children: TreeNode[];
	issues: number;
	/** keys of the object shown as child nodes (not as form fields) */
	childKeys?: string[];
	/** results (DevLog-027): section of a folder, group or node; id of the node; its group's id (items); "+" menu; disabled */
	section?: 'datasets' | 'evaluations' | 'tables' | 'plots';
	rid?: string;
	group?: string;
	addable?: boolean;
	off?: boolean;
}

/** Folder labels of the Results branch (DevLog-023 s.3.4). */
export const RESULT_FOLDERS = [['datasets', 'Datasets'], ['evaluations', 'Evaluations'], ['tables', 'Tables'], ['plots', 'Plots']] as const;

type O = Record<string, unknown>;
const isObj = (x: unknown): x is O => !!x && typeof x === 'object' && !Array.isArray(x);
const arr = (x: unknown): O[] => (Array.isArray(x) ? (x.filter(isObj) as O[]) : []);
const s = (x: unknown) => (typeof x === 'string' ? x : '');

export function buildTree(data: unknown, issues: readonly SpecIssue[]): TreeNode[] {
	if (!isObj(data)) return [];
	const count = (p: string) => issues.filter((i) => i.pointer === p || i.pointer.startsWith(p + '/')).length;
	const node = (kind: TreeNode['kind'], pointer: string, label: string, sub = '', children: TreeNode[] = [], childKeys?: string[]): TreeNode => ({
		key: pointer || '/', kind, pointer, label, ...(sub ? { sub } : {}), children, issues: count(pointer), ...(childKeys ? { childKeys } : {})
	});
	const list = (kind: TreeNode['kind'], ptr: string, items: O[], child: (o: O, i: number) => TreeNode[] = () => [], childKeys?: string[]) =>
		items.map((o, i) => node(kind, `${ptr}/${i}`, s(o.id) || `#${i}`, s(o.type), child(o, i), childKeys));
	const out: TreeNode[] = [];
	out.push(node('model', '', s(data.title) || s(data.id), s(data.id), [], ['params', 'geometry', 'materials', 'physics', 'couplings', 'mesh', 'studies', 'results', 'provenance', 'assumptions', 'missing']));
	if (isObj(data.params)) out.push(node('params', '/params', 'Parameters', String(Object.keys(data.params).length)));
	if (isObj(data.geometry)) {
		const g = data.geometry;
		out.push(node('geometry', '/geometry', 'Geometry', `${g.dim}D${g.axisym ? ' axisym' : ''}`, list('feature', '/geometry/features', arr(g.features)), ['features']));
	}
	if (Array.isArray(data.materials)) out.push(node('materials', '/materials', 'Materials', '', list('material', '/materials', arr(data.materials))));
	if (Array.isArray(data.physics))
		out.push(node('physics', '/physics', 'Physics', '', list('phys', '/physics', arr(data.physics), (p, i) => list('bc', `/physics/${i}/bcs`, arr(p.bcs)), ['bcs'])));
	if (Array.isArray(data.couplings)) out.push(node('couplings', '/couplings', 'Couplings', '', list('coupling', '/couplings', arr(data.couplings))));
	if (isObj(data.mesh)) {
		const m = data.mesh;
		const ch: TreeNode[] = [];
		if (isObj(m.size)) ch.push(node('meshsize', '/mesh/size', 'Size'));
		ch.push(...arr(m.refine).map((r, i) => node('refine', `/mesh/refine/${i}`, `Refine ${i + 1}`, (r.select as string[] | undefined)?.join(' ') ?? '')));
		out.push(node('mesh', '/mesh', 'Mesh', s(m.mesher), ch, ['size', 'refine']));
	}
	if (Array.isArray(data.studies)) out.push(node('studies', '/studies', 'Studies', '', list('study', '/studies', arr(data.studies))));
	// results (CONTRACTS C10, DevLog-027): folders Datasets / Evaluations / Tables / Plots (also when the block is absent),
	// one node per dataset, evaluation group, table and plot group, items under their group; "+" on folders and groups
	{
		const r = isObj(data.results) ? data.results : {};
		const folders: TreeNode[] = [];
		for (const [sec, label] of RESULT_FOLDERS) {
			const grouped = sec === 'evaluations' || sec === 'plots';
			const items = arr(r[sec]);
			const offOf = (o: O) => o.enabled === false;
			const kids = items.map((o, i) => {
				const ptr = `/results/${sec}/${i}`, gid = s(o.id);
				const sub = sec === 'tables' ? `table of ${s(o.from)}` : sec === 'evaluations' ? 'group' : s(o.type);
				const ch = grouped ? arr(o.items).map((it, j) => ({ ...node('result', `${ptr}/items/${j}`, s(it.id) || `#${j}`, s(it.type)), section: sec, rid: s(it.id), group: gid, off: offOf(o) || offOf(it) })) : [];
				return { ...node('result', ptr, gid || `#${i}`, sub, ch, grouped ? ['items'] : undefined), section: sec, rid: gid, addable: grouped, off: offOf(o) };
			});
			folders.push({ ...node('rfolder', `/results/${sec}`, label, items.length ? String(items.length) : '', kids), section: sec, addable: true });
		}
		out.push(node('results', '/results', 'Results', '', folders, ['datasets', 'evaluations', 'tables', 'plots']));
	}
	if (isObj(data.provenance)) out.push(node('provenance', '/provenance', 'Provenance', String(Object.keys((data.provenance.values as O) ?? {}).length)));
	if (Array.isArray(data.assumptions)) out.push(node('assumptions', '/assumptions', 'Assumptions', String(data.assumptions.length)));
	if (Array.isArray(data.missing)) out.push(node('missing', '/missing', 'Missing', String(data.missing.length)));
	return out;
}

export function findNode(nodes: TreeNode[], pointer: string): TreeNode | null {
	for (const n of nodes) {
		if (n.pointer === pointer) return n;
		const c = findNode(n.children, pointer);
		if (c) return c;
	}
	return null;
}
