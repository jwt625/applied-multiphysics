// SPDX-License-Identifier: GPL-3.0-or-later
// Headline numbers of a model (audit top-10 #2): the spec's own `results` of type `scalar` and `probe`, evaluated on
// the current solution and shown in their spec unit. Supported forms (others are listed as not evaluated, never
// guessed): scalar `max(<phys>.<field>)` or `min(...)` followed by an expression over params (e.g.
// `max(solid.sxx)/sigma_inf`), reduced over the nodes of the result's `select` (boundaries or domains); probe of a
// field at `at: [x, y]` (2D, exact FE evaluation in the post worker).
import { evaluateExpression, resolveQuantity, units, type ParamInfo, type ScopeValue } from '@amp/spec';
import type { FieldData, Mesh, Solution } from '@amp/spec/types';
import type { PostClient } from './client';
import type { Space } from './field2d';

export interface Headline { id: string; label: string; value: number | null; unit: string; tip: string }

type ResultNode = { id: string; type: string; expr?: string; unit?: string; select?: string[]; at?: unknown[]; step?: number };

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

export async function headlines(results: ResultNode[], sol: Solution, mesh: Mesh, params: Map<string, ParamInfo>, post: PostClient): Promise<Headline[]> {
	const scope = new Map<string, ScopeValue>([...params].map(([k, p]) => [k, { si: p.si, dim: p.dim }]));
	const out: Headline[] = [];
	const find = (name: string, step?: number): FieldData | undefined => sol.fields.find((f) => f.name === name && (step === undefined || (f.step ?? 0) === step));
	for (const r of results) {
		if (r.type !== 'scalar' && r.type !== 'probe') continue;
		const expr = r.expr ?? '';
		const unit = r.unit && r.unit !== '1' ? r.unit : '';
		const conv = (si: number) => { try { const u = units.parseUnit(r.unit ?? '1'); return (si - u.offset) / u.factor; } catch { return si; } };
		try {
			if (r.type === 'scalar') {
				const m = /^(max|min)\(\s*([\w.]+)\s*\)(.*)$/.exec(expr.trim());
				const f = m ? find(fieldName(m[2]!), r.step) : undefined;
				if (!m || !f || f.components !== 1 || (f.space !== 'H1P1' && f.space !== 'H1P2')) { out.push({ id: r.id, label: r.id, value: null, unit, tip: `${expr}: form not evaluated in the browser` }); continue; }
				const sel = nodesOf(mesh, r.select);
				let red = m[1] === 'max' ? -Infinity : Infinity;
				for (let i = 0; i < f.data.length; i++) if (!sel || sel.has(i)) red = m[1] === 'max' ? Math.max(red, f.data[i]!) : Math.min(red, f.data[i]!);
				const dim = units.parseUnit(f.unit).dim;
				const v = evaluateExpression(`__r${m[3] ?? ''}`, new Map([...scope, ['__r', { si: red, dim }]]));
				out.push({ id: r.id, label: r.id, value: conv(v.si), unit, tip: `${expr} over ${r.select?.join(' ') ?? 'the whole mesh'} (nodal ${f.space} values)` });
			} else {
				const f = find(fieldName(expr), r.step);
				const at = (r.at ?? []).map((q) => { const x = resolveQuantity(q, scope); if (x.na) throw new Error('N/A position'); return x.si; });
				if (!f || mesh.dim !== 2 || at.length !== 2 || (f.space !== 'H1P1' && f.space !== 'H1P2' && f.space !== 'DG0')) { out.push({ id: r.id, label: r.id, value: null, unit, tip: `${expr}: probe not evaluated in the browser` }); continue; }
				const res = await post.call<'evalAt'>({ type: 'evalAt', field: { space: f.space as Space, data: f.data, components: f.components }, comp: 0, points: at });
				const v = res.values[0];
				out.push({ id: r.id, label: r.id, value: v === null || v === undefined ? null : conv(v), unit, tip: `${expr} at (${at.map((x) => x.toPrecision(4)).join(', ')}) m, exact FE evaluation` });
			}
		} catch (e) {
			out.push({ id: r.id, label: r.id, value: null, unit, tip: `${expr}: ${(e as Error).message}` });
		}
	}
	return out;
}
