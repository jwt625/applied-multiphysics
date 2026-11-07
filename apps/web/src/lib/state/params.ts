// SPDX-License-Identifier: GPL-3.0-or-later
// Parameter access for sliders and exact fields: the editable numeric value of a param, its unit, its slider span and
// the pointer an edit goes to. Slider span: the spec's `range` when given; otherwise 0.5x to 2x of the value in the
// original model (a UI choice, stated in the tooltip; no physical meaning).
import { classifyString, units } from '@amp/spec';

export interface ParamView {
	name: string;
	/** numeric value in `unit`, or null for an expression param */
	value: number | null;
	unit: string;
	expr: string | null;
	pointer: string;
	span: [number, number] | null;
	spanFromSpec: boolean;
	description: string;
}

type Def = number | string | { value: number | string; unit?: string; range?: [number, number]; description?: string };

function numeric(d: Def): { value: number | null; unit: string; expr: string | null; pointer: (k: string) => string } {
	if (typeof d === 'number') return { value: d, unit: '', expr: null, pointer: (k) => `/params/${k}` };
	if (typeof d === 'string') {
		const c = classifyString(d);
		if (c.kind === 'literal') return { value: c.value, unit: c.unit, expr: null, pointer: (k) => `/params/${k}` };
		return { value: null, unit: '', expr: d, pointer: (k) => `/params/${k}` };
	}
	if (typeof d.value === 'number') return { value: d.value, unit: d.unit ?? '', expr: null, pointer: (k) => `/params/${k}/value` };
	return { value: null, unit: d.unit ?? '', expr: String(d.value), pointer: (k) => `/params/${k}/value` };
}

export function paramViews(params: Record<string, Def> | undefined, original: Record<string, Def> | undefined): ParamView[] {
	if (!params) return [];
	return Object.entries(params).map(([name, d]) => {
		const n = numeric(d);
		const range = typeof d === 'object' && d.range ? (d.range as [number, number]) : null;
		const o = original?.[name] !== undefined ? numeric(original[name]!) : null;
		const base = o?.value ?? n.value;
		const span: [number, number] | null = range ?? (base !== null && base !== 0 ? (base > 0 ? [0.5 * base, 2 * base] : [2 * base, 0.5 * base]) : null);
		return { name, value: n.value, unit: n.unit, expr: n.expr, pointer: n.pointer(name), span, spanFromSpec: !!range, description: typeof d === 'object' && d.description ? d.description : '' };
	});
}

/** Spec value for a new numeric param value, in the param's own form. */
export function paramValue(p: ParamView, v: number): unknown {
	if (p.pointer.endsWith('/value')) return v;
	return p.unit ? `${v} ${p.unit}` : v;
}

/**
 * Patch setting param `name` to an SI value, written in the param's own unit (handles and Play sliders). The pointer
 * is the same for every step of a gesture (object params are written whole), so the steps coalesce into one op. A
 * param defined by an expression is replaced by a literal in its SI unit (the user's explicit drag breaks the link).
 */
export function paramPatchSI(params: Record<string, unknown> | undefined, name: string, siValue: number, dim: readonly number[]): { op: 'replace'; path: string; value: unknown }[] {
	const d = params?.[name];
	const sig = (v: number) => Number(v.toPrecision(6));
	if (d === undefined) return [];
	if (typeof d === 'number') return [{ op: 'replace', path: `/params/${name}`, value: sig(siValue) }];
	if (typeof d === 'string') {
		const c = classifyString(d);
		const unit = c.kind === 'literal' && c.unit !== '1' ? c.unit : units.formatUnit(dim);
		return [{ op: 'replace', path: `/params/${name}`, value: `${sig(fromUnitSI(siValue, unit))} ${unit}` }];
	}
	const o = d as { value: unknown; unit?: string };
	const unit = typeof o.value === 'number' && o.unit ? o.unit : units.formatUnit(dim);
	return [{ op: 'replace', path: `/params/${name}`, value: { ...o, value: sig(fromUnitSI(siValue, unit)), unit } }];
}

function fromUnitSI(v: number, unit: string): number {
	const u = units.parseUnit(unit);
	return (v - u.offset) / u.factor;
}
