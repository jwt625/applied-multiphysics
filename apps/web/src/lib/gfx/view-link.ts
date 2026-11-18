// SPDX-License-Identifier: GPL-3.0-or-later
// View state in the link (DevLog-052 s.2 item 8): the graphics view (mode, field, complex part, component, step, phase,
// colormap and reverse, range rule, log, axes, 3D camera) as one hash parameter `v=` next to the model's `d=`. Display
// only: the spec and its results are not touched. Encoding: `key:value` pairs joined by `~`, URI-encoded; unknown keys
// and invalid values are dropped on decode, so an old or edited link never breaks the page. Pure (test/e6-link.test.ts),
// plus a registry for the mounted view's state getter (the share action reads it).
import { COLORMAPS, type ColormapName } from './colormaps.ts';
import { COMPLEX_PARTS, type ComplexPart } from './complex.ts';
import { isPreset, type CameraPose, type CameraPreset } from './camera.ts';

export type GfxMode = 'geometry' | 'mesh' | 'results';
export type AxesMode = 'axes' | 'scale' | 'none';

export interface ViewState {
	mode?: GfxMode;
	/** field key (`<physics>.<name>` on multiphysics solutions) or complex group key */
	field?: string;
	part?: ComplexPart;
	/** vector component, -1 = magnitude */
	comp?: number;
	step?: number;
	/** phase of Re(u e^(j phi)), rad */
	phase?: number;
	cm?: ColormapName | 'auto';
	reverse?: boolean;
	rule?: 'full' | 'robust';
	log?: boolean;
	axes?: AxesMode;
	cam?: CameraPose | CameraPreset;
}

const MODES: GfxMode[] = ['geometry', 'mesh', 'results'];
const AXES: AxesMode[] = ['axes', 'scale', 'none'];
/** a finite number written plainly (1e999 = Infinity and NaN are rejected) */
const num = (s: string): number | null => {
	if (!/^-?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s)) return null;
	const x = Number(s);
	return Number.isFinite(x) ? x : null;
};
/** largest component index a link may carry (the drawn field bounds it again, see boundComponent) */
const COMP_MAX = 15;

/**
 * Component index `c` for a field of `n` components: kept when it is an integer in -1 .. n - 1 (-1 = magnitude, only
 * meaningful when n > 1; a scalar field keeps -1 or 0), else -1 (the default view). Out-of-range indices from a link
 * or an old view state are ignored this way instead of reading the next node's data.
 */
export function boundComponent(c: number, n: number): number {
	return Number.isInteger(c) && c >= -1 && c < Math.max(n, 1) ? c : -1;
}
/** Why an agent's component request does not fit a field of `n` components ('' when it does). */
export function componentProblem(c: number, n: number, field: string): string {
	if (!Number.isInteger(c)) return `component must be an integer (got ${c})`;
	if (n <= 1) return c === -1 || c === 0 ? '' : `field ${field} is a scalar: no component ${c} (use -1 or omit)`;
	return c >= -1 && c < n ? '' : `field ${field} has ${n} components: component ${c} is out of range (0 .. ${n - 1}, -1 = magnitude)`;
}
/** 6 significant digits keep a camera pose within 1e-6 of the model size */
const g6 = (x: number) => String(Number(x.toPrecision(6)));

export function encodeView(v: ViewState): string {
	const p: string[] = [];
	const put = (k: string, x: string | number | boolean | undefined) => { if (x !== undefined && x !== '') p.push(`${k}:${typeof x === 'boolean' ? (x ? 1 : 0) : x}`); };
	put('m', v.mode);
	if (v.field && /^[A-Za-z_][\w.]*$/.test(v.field)) put('f', v.field);
	put('p', v.part);
	if (v.comp !== undefined && Number.isInteger(v.comp)) put('c', v.comp);
	if (v.step !== undefined && Number.isInteger(v.step) && v.step >= 0) put('s', v.step);
	if (v.phase !== undefined && Number.isFinite(v.phase)) put('ph', g6(v.phase));
	put('cm', v.cm);
	put('rv', v.reverse);
	put('r', v.rule);
	put('lg', v.log);
	put('ax', v.axes);
	if (typeof v.cam === 'string') put('cam', v.cam);
	else if (v.cam && [...v.cam.pos, ...v.cam.target].every(Number.isFinite) && Math.hypot(v.cam.pos[0] - v.cam.target[0], v.cam.pos[1] - v.cam.target[1], v.cam.pos[2] - v.cam.target[2]) > 0) put('cam', [...v.cam.pos, ...v.cam.target].map(g6).join('_'));
	return encodeURIComponent(p.join('~'));
}

export function decodeView(code: string): ViewState {
	let text: string;
	try { text = decodeURIComponent(code); } catch { return {}; }
	const v: ViewState = {};
	for (const pair of text.split('~')) {
		const i = pair.indexOf(':');
		if (i <= 0) continue;
		const k = pair.slice(0, i), x = pair.slice(i + 1);
		const n = num(x);
		switch (k) {
			case 'm': if ((MODES as string[]).includes(x)) v.mode = x as GfxMode; break;
			case 'f': if (/^[A-Za-z_][\w.]*$/.test(x)) v.field = x; break;
			case 'p': if ((COMPLEX_PARTS as string[]).includes(x)) v.part = x as ComplexPart; break;
			case 'c': if (n !== null && Number.isInteger(n) && n >= -1 && n <= COMP_MAX) v.comp = n; break;
			case 's': if (n !== null && Number.isInteger(n) && n >= 0) v.step = n; break;
			case 'ph': if (n !== null) v.phase = n; break;
			case 'cm': if (x === 'auto' || (COLORMAPS as string[]).includes(x)) v.cm = x as ColormapName | 'auto'; break;
			case 'rv': if (x === '0' || x === '1') v.reverse = x === '1'; break;
			case 'r': if (x === 'full' || x === 'robust') v.rule = x; break;
			case 'lg': if (x === '0' || x === '1') v.log = x === '1'; break;
			case 'ax': if ((AXES as string[]).includes(x)) v.axes = x as AxesMode; break;
			case 'cam': {
				if (isPreset(x)) { v.cam = x; break; }
				const a = x.split('_').map(num);
				if (a.length === 6 && a.every((q) => q !== null)) {
					const b = a as number[];
					// a pose with the eye on the target (zero distance) has no view direction; an overflowing distance: ignored
					const dist = Math.hypot(b[0]! - b[3]!, b[1]! - b[4]!, b[2]! - b[5]!);
					if (Number.isFinite(dist) && dist > 0) v.cam = { pos: [b[0]!, b[1]!, b[2]!], target: [b[3]!, b[4]!, b[5]!] };
				}
				break;
			}
		}
	}
	return v;
}

/** The `v=` code of a location hash (`#d=...&v=...`), or null. */
export function viewCodeOf(hash: string): string | null {
	return /(?:^#|&)v=([^&]*)/.exec(hash)?.[1] ?? null;
}

/** `url` with its hash parameter `v=` set to `code` (other hash parameters kept; an empty code removes it). */
export function withView(url: string, code: string): string {
	const i = url.indexOf('#');
	const base = i < 0 ? url : url.slice(0, i), hash = i < 0 ? '' : url.slice(i + 1);
	const parts = hash.split('&').filter((x) => x && !x.startsWith('v='));
	if (code) parts.push(`v=${code}`);
	return parts.length ? `${base}#${parts.join('&')}` : base;
}

let getter: (() => ViewState) | null = null;
/** The mounted graphics view registers its state getter (one at a time; the latest mount wins). */
export function registerViewState(g: () => ViewState): () => void {
	getter = g;
	return () => { if (getter === g) getter = null; };
}
/** Code of the mounted view's state ('' when no view is mounted). */
export function currentViewCode(): string {
	return getter ? encodeView(getter()) : '';
}
/** `url` with the mounted view's state attached (the share action). */
export function withViewCode(url: string): string {
	return withView(url, currentViewCode());
}
