// SPDX-License-Identifier: GPL-3.0-or-later
// Nice ticks and number formatting for colorbars, probes and timings (3 significant figures, s.6).

/** Nice tick values in [a, b], about n of them. */
export function niceTicks(a: number, b: number, n = 6): number[] {
	if (!(Number.isFinite(a) && Number.isFinite(b)) || a === b) return Number.isFinite(a) ? [a] : [];
	const lo = Math.min(a, b), hi = Math.max(a, b);
	const raw = (hi - lo) / Math.max(1, n);
	const mag = 10 ** Math.floor(Math.log10(raw));
	const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((s) => s >= raw) ?? 10 * mag;
	const out: number[] = [];
	for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9 * step; v += step) out.push(Math.abs(v) < 1e-12 * step ? 0 : v);
	return out;
}

/** Decade ticks for a log axis. */
export function logTicks(a: number, b: number): number[] {
	if (!(a > 0 && b > a)) return [];
	const out: number[] = [];
	for (let e = Math.ceil(Math.log10(a)); e <= Math.floor(Math.log10(b)); e++) out.push(10 ** e);
	return out;
}

/** 3 significant figures; exponent form outside [1e-3, 1e5). */
export function fmt(v: number, sig = 3): string {
	if (!Number.isFinite(v)) return String(v);
	if (v === 0) return '0';
	const a = Math.abs(v);
	if (a >= 1e5 || a < 1e-3) return v.toExponential(sig - 1).replace('e+', 'e');
	return Number(v.toPrecision(sig)).toString();
}

export function fmtMs(ms: number): string {
	return ms < 10 ? `${ms.toFixed(1)} ms` : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}
