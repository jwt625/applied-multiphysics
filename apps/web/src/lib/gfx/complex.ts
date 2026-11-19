// SPDX-License-Identifier: GPL-3.0-or-later
// Complex (driven, frequency-domain) field display (DevLog-052 s.2 item 2). A driven solve returns each complex field
// as a pair `<u>_re`, `<u>_im` (plus `<u>_abs`) per frequency step (DevLog-042 s.1.5); the selector shows one entry
// per pair and a part: Re, Im, |.|, arg (rad, in (-pi, pi]) or the instantaneous field Re(u e^(j phi)) at the phase
// phi = omega t (time convention exp(+j omega t)). Pure functions on plain arrays (Node tests: test/e6-complex.test.ts).

export type ComplexPart = 're' | 'im' | 'abs' | 'arg' | 'inst';
export const COMPLEX_PARTS: ComplexPart[] = ['re', 'im', 'abs', 'arg', 'inst'];
export const PART_LABEL: Record<ComplexPart, string> = { re: 'Re', im: 'Im', abs: '|.|', arg: 'phase', inst: 'Re(u e^jφ)' };
export const PART_TIP: Record<ComplexPart, string> = {
	re: 'real part',
	im: 'imaginary part',
	abs: 'magnitude |u|',
	arg: 'phase arg(u) in rad, from -π to π (cyclic colormap)',
	inst: 'instantaneous field Re(u e^(jφ)) at the phase φ = ωt (time convention e^(+jωt)); Animate sweeps φ'
};

export interface ComplexGroup {
	/** display key of the group (the base name, physics-prefixed like the field keys) */
	key: string;
	re: string;
	im: string;
	abs: string | null;
}

/**
 * Field keys grouped for the selector: every `<b>_re` with a matching `<b>_im` becomes one entry `<b>` (its `<b>_abs`
 * is folded in); other keys stay as they are. Order follows the first member of each entry.
 */
export function groupComplex(keys: string[]): { entries: string[]; groups: Map<string, ComplexGroup> } {
	const set = new Set(keys);
	const groups = new Map<string, ComplexGroup>();
	const member = new Map<string, string>();
	for (const k of keys) {
		if (!k.endsWith('_re')) continue;
		const b = k.slice(0, -3);
		if (!b || !set.has(`${b}_im`) || set.has(b)) continue;
		const g: ComplexGroup = { key: b, re: k, im: `${b}_im`, abs: set.has(`${b}_abs`) ? `${b}_abs` : null };
		groups.set(b, g);
		member.set(g.re, b); member.set(g.im, b);
		if (g.abs) member.set(g.abs, b);
	}
	const entries: string[] = [];
	const seen = new Set<string>();
	for (const k of keys) {
		const e = member.get(k) ?? k;
		if (!seen.has(e)) { seen.add(e); entries.push(e); }
	}
	return { entries, groups };
}

/**
 * One part of a complex field, component by component (same layout as the inputs: nodal or per cell, `n` values times
 * the component count). `arg` is atan2(im, re); `inst` is re cos(phi) - im sin(phi).
 */
export function complexPart(re: ArrayLike<number>, im: ArrayLike<number>, part: ComplexPart, phi = 0): Float64Array {
	const n = Math.min(re.length, im.length), out = new Float64Array(n);
	if (part === 're') for (let i = 0; i < n; i++) out[i] = re[i]!;
	else if (part === 'im') for (let i = 0; i < n; i++) out[i] = im[i]!;
	else if (part === 'abs') for (let i = 0; i < n; i++) out[i] = Math.hypot(re[i]!, im[i]!);
	else if (part === 'arg') for (let i = 0; i < n; i++) out[i] = Math.atan2(im[i]!, re[i]!);
	else {
		const c = Math.cos(phi), s = Math.sin(phi);
		for (let i = 0; i < n; i++) out[i] = c * re[i]! - s * im[i]!;
	}
	return out;
}

/** Instantaneous lattice values cos(phi) a - sin(phi) b into `out` (the phase animation, one call per frame). */
export function instant(a: Float32Array, b: Float32Array, phi: number, out?: Float32Array): Float32Array {
	const n = Math.min(a.length, b.length), o = out && out.length === n ? out : new Float32Array(n);
	const c = Math.cos(phi), s = Math.sin(phi);
	for (let i = 0; i < n; i++) o[i] = c * a[i]! - s * b[i]!;
	return o;
}

/** Largest |u| over a lattice pair: the fixed symmetric colour range of the animation (no range jumps per frame). */
export function peakAbs(a: ArrayLike<number>, b: ArrayLike<number>): number {
	let m = 0;
	const n = Math.min(a.length, b.length);
	for (let i = 0; i < n; i++) { const v = Math.hypot(a[i]!, b[i]!); if (v > m) m = v; }
	return m;
}

/** Phase wrapped to [0, 2 pi). */
export function wrapPhase(phi: number): number {
	const t = 2 * Math.PI;
	return ((phi % t) + t) % t;
}

/** Unwrap a phase sequence (rad): steps larger than pi in magnitude are taken modulo 2 pi. */
export function unwrap(p: ArrayLike<number>): number[] {
	const out: number[] = [];
	let off = 0;
	for (let i = 0; i < p.length; i++) {
		if (i > 0 && Number.isFinite(p[i]!) && Number.isFinite(p[i - 1]!)) {
			const d = p[i]! - p[i - 1]!;
			if (d > Math.PI) off -= 2 * Math.PI * Math.round(d / (2 * Math.PI));
			else if (d < -Math.PI) off += 2 * Math.PI * Math.round(-d / (2 * Math.PI));
		}
		out.push(p[i]! + off);
	}
	return out;
}

/**
 * Colour range and peak of lattice values computed on the main thread (the combined complex parts): over the points
 * inside `focus` (world box, m) when given; `robust` = 1st to 99th percentile of the points (unweighted; the worker's
 * rule for single fields weights by element area). `pos` are lattice positions relative to `c0` (RefinedDisplay).
 */
export function latticeStats(values: ArrayLike<number>, pos: ArrayLike<number>, c0: [number, number], focus: [number, number, number, number] | null, rule: 'full' | 'robust'): { lo: number; hi: number; dataLo: number; dataHi: number; peak: { x: number; y: number; v: number } | null } {
	let lo = Infinity, hi = -Infinity, dataLo = Infinity, dataHi = -Infinity, peak: { x: number; y: number; v: number } | null = null;
	const sample: number[] = [];
	const n = values.length, st = Math.max(1, Math.floor(n / 60000));
	for (let i = 0; i < n; i++) {
		const v = values[i]!;
		if (!Number.isFinite(v)) continue;
		if (v < dataLo) dataLo = v;
		if (v > dataHi) dataHi = v;
		const x = pos[2 * i]! + c0[0], y = pos[2 * i + 1]! + c0[1];
		if (focus && !(x >= focus[0] && x <= focus[2] && y >= focus[1] && y <= focus[3])) continue;
		if (v < lo) lo = v;
		if (v > hi) hi = v;
		if (!peak || Math.abs(v) > Math.abs(peak.v)) peak = { x, y, v };
		if (rule === 'robust' && i % st === 0) sample.push(v);
	}
	if (!Number.isFinite(lo)) { lo = dataLo; hi = dataHi; }
	if (rule === 'robust' && sample.length > 10) {
		sample.sort((a, b) => a - b);
		lo = sample[Math.floor(0.01 * (sample.length - 1))]!;
		hi = sample[Math.ceil(0.99 * (sample.length - 1))]!;
	}
	return { lo, hi, dataLo, dataHi, peak };
}

/** Label of a part of the complex field `base`: Re Ez, Im Ez, |Ez|, arg Ez, Re(Ez e^jφ). */
export function partLabel(part: ComplexPart, base: string): string {
	return part === 're' ? `Re ${base}` : part === 'im' ? `Im ${base}` : part === 'abs' ? `|${base}|` : part === 'arg' ? `arg ${base}` : `Re(${base} e^jφ)`;
}

/**
 * Probe value of a complex part from the exact Re and Im at a point (DevLog-064): the same combination the renderer
 * makes per pixel, so |u|, phase and Re(u e^(j phi)) are exact at the point instead of interpolated nodal parts.
 * `sign` is a mirror parity (applied to u), `a`, `b` the display affine (not applied to the phase, which stays in
 * rad). null when either part is not available (outside the mesh).
 */
export function complexValue(re: number | null, im: number | null, part: ComplexPart, phi: number, sign = 1, a = 1, b = 0): number | null {
	if (re === null || im === null || !Number.isFinite(re) || !Number.isFinite(im)) return null;
	const v = complexPart([sign * re], [sign * im], part, phi)[0]!;
	return part === 'arg' ? v : a * v + b;
}

/**
 * Probe value of a complex part from the exact Re and Im of every component at a point (index = component). `comp` >= 0
 * (or a scalar field): that component, as complexValue. `comp` < 0 on a vector: |u| and Re(u e^(j phi)) are the norm
 * over the components of the per-component part (sqrt(sum_k |u_k|^2), the length of the instantaneous real vector),
 * Re and Im the norms of the real and imaginary vectors; the phase of a vector is not defined (null: the view shows
 * a component). The renderer combines the same per-component values (instNorm), so hover, click and drawing agree.
 */
export function complexVectorValue(re: ReadonlyArray<number | null>, im: ReadonlyArray<number | null>, comp: number, part: ComplexPart, phi: number, sign = 1, a = 1, b = 0): number | null {
	if (comp >= 0 || re.length === 1) return complexValue(re[Math.max(0, comp)] ?? null, im[Math.max(0, comp)] ?? null, part, phi, sign, a, b);
	if (part === 'arg' || !re.length || re.length !== im.length) return null;
	let s2 = 0;
	for (let k = 0; k < re.length; k++) {
		const r = re[k], i = im[k];
		if (r === null || i === null || r === undefined || i === undefined || !Number.isFinite(r) || !Number.isFinite(i)) return null;
		const v = complexPart([sign * r], [sign * i], part, phi)[0]!;
		s2 += v * v;
	}
	return a * Math.sqrt(s2) + b;
}

/** Norm over the components of Re(u e^(j phi)) at lattice points: `re[k]`, `im[k]` are the lattice values of component k
 *  (the phase animation of a complex vector shown as a magnitude, one call per frame). */
export function instNorm(re: ReadonlyArray<ArrayLike<number>>, im: ReadonlyArray<ArrayLike<number>>, phi: number, out?: Float32Array): Float32Array {
	const n = Math.min(...re.map((x) => x.length), ...im.map((x) => x.length)), o = out && out.length === n ? out : new Float32Array(n);
	const c = Math.cos(phi), s = Math.sin(phi), nc = Math.min(re.length, im.length);
	for (let i = 0; i < n; i++) {
		let s2 = 0;
		for (let k = 0; k < nc; k++) { const v = c * re[k]![i]! - s * im[k]![i]!; s2 += v * v; }
		o[i] = Math.sqrt(s2);
	}
	return o;
}

/** Largest |u| = sqrt(sum_k |u_k|^2) over lattice points of a complex vector (colour range of its phase animation). */
export function peakAbsVector(re: ReadonlyArray<ArrayLike<number>>, im: ReadonlyArray<ArrayLike<number>>): number {
	const n = Math.min(...re.map((x) => x.length), ...im.map((x) => x.length)), nc = Math.min(re.length, im.length);
	let m = 0;
	for (let i = 0; i < n; i++) {
		let s2 = 0;
		for (let k = 0; k < nc; k++) s2 += re[k]![i]! * re[k]![i]! + im[k]![i]! * im[k]![i]!;
		if (s2 > m) m = s2;
	}
	return Math.sqrt(m);
}
