// SPDX-License-Identifier: GPL-3.0-or-later
// Headline numbers of a model (audit top-10 #2): the spec's own evaluation items of type `max`, `min` and `point`
// (results model C10; `headlineItems` of @amp/spec), evaluated on the current solution and shown in their spec unit.
// Supported forms (others are listed as not evaluated, never guessed):
//   max / min, method `nodal`: an expression over nodal scalar fields (H1P1 / H1P2) and params (e.g.
//     `solid.sxx/sigma_inf`), evaluated at every node of the item's `over` selection (boundaries or domains) and
//     reduced; the same numbers as the legacy `max(<field>)<tail>` scalar for a positive tail factor;
//   point: one field at the single point of the item's cutpoint dataset of a solution dataset (2D, exact FE
//     evaluation in the post worker).
// The solution shown is the session's current one; an item whose root study is another study is not told apart (R3).
// The general evaluator is @amp/post (lane R1); R3 moves the headlines onto it.
import { compileExpression } from '@amp/core/expr';
import { headlineItems, resolveQuantity, units, type ParamInfo, type ScopeValue } from '@amp/spec';
import type { FieldData, Mesh, Solution } from '@amp/spec/types';
import type { PostClient } from './client';
import type { Space } from './field2d';

export interface Headline { id: string; label: string; value: number | null; unit: string; tip: string; /** probe location (m), 2D */ at?: [number, number] }

const fieldName = (expr: string) => expr.replace(/^\w+\./, '');

function nodesOf(mesh: Mesh, select: string[] | undefined): Set<number> | null {
	if (!select?.length) return null;
	const want = (id: string, parent?: string[]) => select.some((s) => s === id || id.startsWith(`${s}#`) || parent?.includes(s));
	const out = new Set<number>();
	const bIdx = new Set(mesh.entities.boundaries.map((b, i) => (want(b.id, b.parent) ? i : -1)).filter((i) => i >= 0));
	const dIdx = new Set(mesh.entities.domains.map((d, i) => (want(d.id, d.parent) ? i : -1)).filter((i) => i >= 0));
	const f = mesh.facets, npf = f.conn.length / Math.max(1, f.boundary.length);
	for (let i = 0; i < f.boundary.length; i++) if (bIdx.has(f.boundary[i]!)) for (let k = 0; k < npf; k++) out.add(f.conn[npf * i + k]!);
	const c = mesh.cells, npc = c.conn.length / Math.max(1, c.domain.length);
	for (let i = 0; i < c.domain.length; i++) if (dIdx.has(c.domain[i]!)) for (let k = 0; k < npc; k++) out.add(c.conn[npc * i + k]!);
	return out;
}

/** `results`: the spec's results block (C10). Anything else (absent, legacy list) yields no headlines. */
export async function headlines(results: unknown, sol: Solution, mesh: Mesh, params: Map<string, ParamInfo>, post: PostClient): Promise<Headline[]> {
	const scope = new Map<string, ScopeValue>([...params].map(([k, p]) => [k, { si: p.si, dim: p.dim }]));
	const out: Headline[] = [];
	const find = (name: string, step?: number | 'last'): FieldData | undefined => (step === 'last' ? sol.fields.findLast((f) => f.name === name) : sol.fields.find((f) => f.name === name && (step === undefined || (f.step ?? 0) === step)));
	for (const r of headlineItems(results)) {
		const expr = r.expr;
		const unit = r.unit && r.unit !== '1' ? r.unit : '';
		const label = r.id;
		const conv = (si: number) => { try { const u = units.parseUnit(r.unit ?? '1'); return (si - u.offset) / u.factor; } catch { return si; } };
		try {
			if (r.type === 'max' || r.type === 'min') {
				if (r.dataset !== 'solution' || !r.over) { out.push({ id: r.id, label, value: null, unit, tip: `${r.type} of ${expr} on a ${r.dataset ?? 'missing'} dataset${r.over ? '' : ' without a selection'}: not evaluated in the browser (solution dataset with 'over' only)` }); continue; }
				if (r.method !== 'nodal') { out.push({ id: r.id, label, value: null, unit, tip: `${r.type} of ${expr}: method '${r.method ?? 'none'}' not evaluated in the browser (nodal only)` }); continue; }
				// every field the expression names must be a nodal scalar field with one value per node
				const fields = new Map<string, FieldData>();
				let bad = '';
				const c = compileExpression(expr, {
					resolve: (name: string) => {
						const p = scope.get(name);
						if (p) return { kind: 'const', re: p.si, dim: p.dim };
						const f = name.includes('.') ? find(fieldName(name), r.step) : undefined;
						if (!f) return null;
						if (f.components !== 1 || (f.space !== 'H1P1' && f.space !== 'H1P2')) bad = `${name} is not a nodal scalar field`;
						fields.set(name, f);
						return { kind: 'field', key: name, dim: units.parseUnit(f.unit).dim, complex: false, continuous: true };
					},
				});
				const n = [...fields.values()][0]?.data.length ?? 0;
				if (bad || !fields.size || c.complex || [...fields.values()].some((f) => f.data.length !== n)) { out.push({ id: r.id, label, value: null, unit, tip: `${r.type} of ${expr}: form not evaluated in the browser${bad ? ` (${bad})` : ''}` }); continue; }
				const v = c.run({ n, get: (key: string) => ({ re: fields.get(key)!.data as Float64Array, im: null }) }) as { re: Float64Array };
				const sel = nodesOf(mesh, r.over);
				let red = r.type === 'max' ? -Infinity : Infinity;
				for (let i = 0; i < n; i++) if (!sel || sel.has(i)) red = r.type === 'max' ? Math.max(red, v.re[i]!) : Math.min(red, v.re[i]!);
				const space = [...fields.values()][0]!.space;
				out.push({ id: r.id, label, value: conv(red), unit, tip: `${r.type} of ${expr} over ${r.over?.join(' ') ?? 'the whole mesh'} (nodal ${space} values)` });
			} else {
				const f = find(fieldName(expr), r.step);
				const at = (r.at ?? []).map((q) => { const x = resolveQuantity(q as Parameters<typeof resolveQuantity>[0], scope); if (x.na) throw new Error('N/A position'); return x.si; });
				if (r.source !== 'solution') { out.push({ id: r.id, label, value: null, unit, tip: `${expr}: cut point on a ${r.source ?? 'missing'} dataset not evaluated in the browser (solution datasets only)` }); continue; }
				if (!f || mesh.dim !== 2 || at.length !== 2 || (f.space !== 'H1P1' && f.space !== 'H1P2' && f.space !== 'DG0')) { out.push({ id: r.id, label, value: null, unit, tip: `${expr}: probe not evaluated in the browser` }); continue; }
				const res = await post.call<'evalAt'>({ type: 'evalAt', field: { space: f.space as Space, data: f.data, components: f.components }, comp: 0, points: at });
				const v = res.values[0];
				out.push({ id: r.id, label, value: v === null || v === undefined ? null : conv(v), unit, tip: `${expr} at (${at.map((x) => x.toPrecision(4)).join(', ')}) m, exact FE evaluation`, at: [at[0]!, at[1]!] });
			}
		} catch (e) {
			out.push({ id: r.id, label, value: null, unit, tip: `${expr}: ${(e as Error).message}` });
		}
	}
	return out;
}
