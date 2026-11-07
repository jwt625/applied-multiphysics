// SPDX-License-Identifier: GPL-3.0-or-later
// Play view configuration per hero: canvas drag handles (one spec param each, so a drag coalesces into one op) and
// presets derived from the spec itself (the original model, `range` ends, parametric-sweep values). No physical value
// is introduced here: handles map geometry positions to the params that define them in sims/*.yaml.
import { units, type ParamInfo } from '@amp/spec';
import type { Handle } from '../gfx/Canvas2D.svelte';
import type { AccuracyDef } from '../post/accuracy';

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
		{ id: 'slab', param: 't_slab', tip: 'Drag: slab thickness t_slab', at: (p) => ({ x: 0.3 * si(p, 'W_win'), y: si(p, 't_slab'), axis: 'y' }), value: (_x, y) => y }
	],
	'heat-plate-fin': [
		{ id: 'width', param: 'Lx', tip: 'Drag: plate width Lx', at: (p) => ({ x: si(p, 'Lx'), y: si(p, 'Ly') / 2, axis: 'x' }), value: (x) => x },
		{ id: 'height', param: 'Ly', tip: 'Drag: plate height Ly', at: (p) => ({ x: si(p, 'Lx') / 2, y: si(p, 'Ly'), axis: 'y' }), value: (_x, y) => y }
	]
};

/**
 * Region of interest of the Play canvas (m, in the mirrored frame when the view mirrors): the camera frames it on load
 * and after a drag that moves it; the colour range is taken over it (stated in the colorbar tooltip). "All" frames the
 * whole model instead.
 */
export const FOCUS: Record<string, (p: P) => [number, number, number, number]> = {
	// 5 D square centred on the hole (full plate shown by mirroring)
	'kirsch-plate': (p) => { const D = si(p, 'D'); return [-2.5 * D, -2.5 * D, 2.5 * D, 2.5 * D]; },
	// both coils and the axis, both sides of the axis
	'helmholtz-coil': (p) => { const R = si(p, 'R'), d = si(p, 'd'); const z = Math.max(0.5 * d + 0.55 * R, 0.9 * R); return [-1.55 * R, -z, 1.55 * R, z]; },
	// the whole plate (re-framed after Lx / Ly change)
	'heat-plate-fin': (p) => { const x = si(p, 'Lx'), y = si(p, 'Ly'); return [-0.04 * x, -0.04 * y, 1.04 * x, 1.04 * y]; },
	// the rib and the guided field around it
	'si-rib-waveguide': (p) => { const w = si(p, 'w_rib'), H = si(p, 'H'), W = si(p, 'W_win'); const hw = Math.min(W / 2, 1.15 * w); return [-hw, -Math.min(si(p, 'D_sub'), 1.2 * H), hw, Math.min(si(p, 'H_cov'), 1.8 * H)]; },
	// core, cladding and heater (lane LP, DevLog-030): 1.5 heater widths each side; from (t_wg + t_c) below the core to
	// one heater thickness above the heater
	'si-microheater-to': (p) => { const wh = si(p, 'w_h'), up = si(p, 't_wg') + si(p, 't_c'); return [-1.5 * wh, -up, 1.5 * wh, up + 2 * si(p, 't_h')]; },
	// the rib in the electrode gap (lane LP, DevLog-030): the gap g wide (electrode edges at x = +-g/2), from mid box to
	// two electrode thicknesses above the slab
	'tfln-mzm-eo': (p) => { const g = si(p, 'g'); return [-g / 2, -si(p, 't_box') / 2, g / 2, si(p, 't_film') - si(p, 'h_rib') + 2 * si(p, 't_el')]; },
	// LN film and both electrodes (lane LP, DevLog-030): out to the electrode outer edges, from one film thickness below
	// the film to one electrode thickness above the electrodes
	'ln-fbar-2d': (p) => { const x = si(p, 'w_gap') / 2 + si(p, 'w_metal'), t = si(p, 't_LN'); return [-x, -2 * t, x, si(p, 'g_metal') + 2 * si(p, 't_metal')]; }
};

/**
 * Symmetry mirroring of a 2D view (display only; DevLog-015 s.1.1 item 7). `planes`: the model's symmetry planes
 * (x = 0 and / or y = 0, from its BCs or its axis). `parity(field, comp)` gives the sign of the field under the
 * reflection across each plane, [sx, sy] (1 even, -1 odd), or null when the field has no stated parity (then the view
 * is not mirrored). comp -1 = magnitude.
 */
export interface MirrorDef { planes: { x: boolean; y: boolean }; tip: string; parity(field: string, comp: number): [number, number] | null }
export const MIRROR: Record<string, MirrorDef> = {
	'kirsch-plate': {
		planes: { x: true, y: true },
		tip: 'Full plate drawn from the quarter model by mirroring across its symmetry planes x = 0 and y = 0 (roller BCs sym_x, sym_y). sxy and u_x / u_y change sign under the matching reflection; the other stresses and magnitudes do not',
		parity: (f, c) => {
			if (f === 'u') return c === 0 ? [-1, 1] : c === 1 ? [1, -1] : [1, 1];
			if (f === 'sxy') return [-1, -1];
			return ['sxx', 'syy', 'szz', 'mises'].includes(f) ? [1, 1] : null;
		}
	},
	'helmholtz-coil': {
		planes: { x: true, y: false },
		tip: 'Section through the axis: the axisymmetric (r, z) solution mirrored to r < 0. Br and A_phi change sign across the axis (radial and azimuthal directions reverse); |B| and Bz do not; field lines are contours of r A_phi',
		parity: (f) => (f === 'Br' || f === 'A_phi' ? [-1, 1] : f === 'normB' || f === 'Bz' ? [1, 1] : null)
	}
};

/** Symbols of headline results (display only): base and subscript. */
export const SYMBOL: Record<string, [string, string]> = { kt: ['K', 't'], neff: ['n', 'eff'], neff_0: ['n', 'eff'] };

/**
 * Full-accuracy sequence per hero (post/accuracy.ts): the quantity whose discretization error is estimated and the
 * paired case metric whose tolerance it is compared with. The cavity Play view solves cylinder-cavity-axisym (RF-21).
 */
export const ACCURACY: Record<string, AccuracyDef> = {
	'kirsch-plate': { metric: 'K_t', quantity: { headline: 'kt' }, label: 'kt' },
	'heat-plate-fin': { metric: 'T_E', quantity: { headline: 'T_E' }, label: 'T_E' },
	'helmholtz-coil': { metric: 'B_center', quantity: { headline: 'B_center' }, label: 'B_center' },
	'si-rib-waveguide': { metric: 'neff_fund_vs_t_slab', quantity: { scalar: 'neff_0' }, label: 'neff_0' },
	'cylinder-cavity': { metric: 'f_TM010', quantity: { eigen: true }, label: 'f' },
	'box-acoustics': { metric: 'f_mode1', quantity: { eigen: true }, label: 'f' }
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

/** Probe-relative contour band per hero (display only): field contours at probe value x (1 -/+ rel). */
export const BAND: Record<string, { probe: string; field: string; rel: number; tip: string }> = {
	'helmholtz-coil': { probe: 'B_center', field: 'normB', rel: 0.01, tip: 'Uniform region: amber contours where |B| = B_center x (1 -/+ 1 %); |B| stays within 1 % of the centre value between them around the centre (B_center is the probe result at r = z = 0)' }
};
