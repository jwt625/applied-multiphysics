// SPDX-License-Identifier: GPL-3.0-or-later
// Play view configuration per hero: canvas drag handles (one spec param each, so a drag coalesces into one op) and
// presets derived from the spec itself (the original model, `range` ends, parametric-sweep values). No physical value
// is introduced here: handles map geometry positions to the params that define them in sims/*.yaml.
import { units, type ParamInfo } from '@amp/spec';
import type { Handle } from '../gfx/Canvas2D.svelte';

type P = Map<string, ParamInfo>;

export interface HandleDef {
	id: string;
	param: string;
	tip: string;
	/** handle position (m) and ring from the resolved params (SI) */
	at(p: P): Omit<Handle, 'id' | 'tip'> | null;
	/** new SI value of `param` from the dragged world point (m) */
	value(x: number, y: number, p: P): number;
}

const si = (p: P, k: string) => p.get(k)?.si ?? NaN;

export const HANDLES: Record<string, HandleDef[]> = {
	'kirsch-plate': [{
		id: 'hole', param: 'D', tip: 'Drag: hole diameter D',
		at: (p) => { const r = si(p, 'D') / 2; return { x: r * Math.SQRT1_2, y: r * Math.SQRT1_2, axis: 'radial', cx: 0, cy: 0, ring: r }; },
		value: (x, y) => 2 * Math.hypot(x, y)
	}],
	'helmholtz-coil': [
		{ id: 'spacing', param: 'd', tip: 'Drag: coil spacing d (centre of coil 1 at z = d/2)', at: (p) => ({ x: si(p, 'R'), y: si(p, 'd') / 2, axis: 'y' }), value: (_x, y) => 2 * y },
		{ id: 'radius', param: 'R', tip: 'Drag: coil radius R', at: (p) => ({ x: si(p, 'R'), y: -si(p, 'd') / 2, axis: 'x' }), value: (x) => x }
	],
	'si-rib-waveguide': [
		{ id: 'height', param: 'H', tip: 'Drag: rib height H', at: (p) => ({ x: 0, y: si(p, 'H'), axis: 'y' }), value: (_x, y) => y },
		{ id: 'width', param: 'w_rib', tip: 'Drag: rib width w_rib', at: (p) => ({ x: si(p, 'w_rib') / 2, y: si(p, 'H') / 2, axis: 'x' }), value: (x) => 2 * x },
		{ id: 'slab', param: 't', tip: 'Drag: slab thickness t', at: (p) => ({ x: 0.35 * si(p, 'W_win'), y: si(p, 't'), axis: 'y' }), value: (_x, y) => y }
	],
	'heat-plate-fin': [
		{ id: 'width', param: 'Lx', tip: 'Drag: plate width Lx', at: (p) => ({ x: si(p, 'Lx'), y: si(p, 'Ly') / 2, axis: 'x' }), value: (x) => x },
		{ id: 'height', param: 'Ly', tip: 'Drag: plate height Ly', at: (p) => ({ x: si(p, 'Lx') / 2, y: si(p, 'Ly'), axis: 'y' }), value: (_x, y) => y }
	]
};

/** Initial view of the Play canvas (m): the region the handles act on, from the resolved params. */
export const FOCUS: Record<string, (p: P) => [number, number, number, number]> = {
	'kirsch-plate': (p) => { const D = si(p, 'D'); return [-0.3 * D, -0.3 * D, 3 * D, 3 * D]; },
	'helmholtz-coil': (p) => { const R = si(p, 'R'); return [-0.1 * R, -1.3 * R, 1.6 * R, 1.3 * R]; }
};

/** SI value -> value in the param's own unit. */
export function fromSI(v: number, unit: string): number {
	if (!unit) return v;
	const u = units.parseUnit(unit);
	return (v - u.offset) / u.factor;
}

export interface Preset { name: string; tip: string; values: Record<string, number> }

type Def = number | string | { value: number | string; unit?: string; range?: [number, number] };
const num = (d: Def | undefined): number | null => (typeof d === 'number' ? d : d && typeof d === 'object' && typeof d.value === 'number' ? d.value : null);

/** Presets from the spec: the original model, `range` ends, parametric-sweep values (in the params' own units). */
export function presetsFor(original: Record<string, unknown> | null): Preset[] {
	if (!original) return [];
	const params = (original.params ?? {}) as Record<string, Def>;
	const out: Preset[] = [];
	const base: Record<string, number> = {};
	for (const [k, d] of Object.entries(params)) { const v = num(d); if (v !== null) base[k] = v; }
	out.push({ name: 'model', tip: 'Parameter values of the original sims file', values: base });
	for (const [k, d] of Object.entries(params)) {
		if (typeof d === 'object' && d.range) {
			out.push({ name: `${k} min`, tip: `${k} = ${d.range[0]} ${d.unit ?? ''} (lower end of the spec range)`, values: { [k]: d.range[0] } });
			out.push({ name: `${k} max`, tip: `${k} = ${d.range[1]} ${d.unit ?? ''} (upper end of the spec range)`, values: { [k]: d.range[1] } });
		}
	}
	for (const st of (original.studies ?? []) as Array<{ id: string; type: string; settings?: { sweep?: Array<{ param: string; values?: unknown[] }> } }>) {
		if (st.type !== 'parametric') continue;
		for (const ax of st.settings?.sweep ?? []) {
			const d = params[ax.param];
			const unit = typeof d === 'object' ? d.unit ?? '' : '';
			for (const v of ax.values ?? []) {
				const m = typeof v === 'string' ? /^\s*([-+]?[\d.]+(?:e[-+]?\d+)?)\s*(\S*)\s*$/i.exec(v) : null;
				let x: number | null = typeof v === 'number' ? v : null;
				if (m) { const u = m[2] || ''; x = u && unit && u !== unit ? fromSI(Number(m[1]) * units.parseUnit(u).factor, unit) : Number(m[1]); }
				if (x !== null && Number.isFinite(x) && !out.some((o) => JSON.stringify(o.values) === JSON.stringify({ [ax.param]: x }))) out.push({ name: `${ax.param} ${typeof v === 'string' ? v : x}`, tip: `value from the parametric study ${st.id}`, values: { [ax.param]: x } });
			}
		}
	}
	return out;
}
