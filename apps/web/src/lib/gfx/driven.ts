// SPDX-License-Identifier: GPL-3.0-or-later
// Driven-solve plots from the Solution extras `wave2d` (DevLog-042 s.1.5, DevLog-052 s.2 item 4): S-parameters
// (|S| in dB and phase in degrees vs frequency, one series per output / input key) and the far field sigma_2D(phi).
// Pure functions on plain data (Node tests: test/e6-driven.test.ts).
import type { Wave2DExtras } from '../engine/protocol.ts';
import { unwrap } from './complex.ts';

const PREFIX: Array<[number, string]> = [[1e12, 'T'], [1e9, 'G'], [1e6, 'M'], [1e3, 'k'], [1, '']];
/** Engineering prefix for an axis of values (largest magnitude), e.g. 1.9e14 Hz -> {f: 1e-12, unit: 'THz'}. */
export function axisPrefix(values: ArrayLike<number>, unit: string): { f: number; unit: string } {
	let m = 0;
	for (let i = 0; i < values.length; i++) if (Number.isFinite(values[i]!)) m = Math.max(m, Math.abs(values[i]!));
	const [k, p] = PREFIX.find(([v]) => m >= v * 0.9995) ?? PREFIX[PREFIX.length - 1]!;
	return { f: 1 / k, unit: p + unit };
}

export interface SSeries {
	/** label S<i><j> with port ids and modes, e.g. "S21" or "S21 (mode 1 from 0)" */
	name: string;
	tip: string;
	out: number;
	inp: number;
	/** input column label, e.g. "port 1 (p1)" or "port 1 (p1) mode 0" */
	inLabel: string;
	/** frequency in the prefixed unit */
	x: number[];
	dB: number[];
	/** degrees, unwrapped along frequency unless `wrap` */
	deg: number[];
	abs: number[];
}

/** Port label: 1-based index in the key order of the ports' first appearance. */
function portIndex(keys: Array<{ port: string; mode: number }>): Map<string, number> {
	const m = new Map<string, number>();
	for (const k of keys) if (!m.has(k.port)) m.set(k.port, m.size + 1);
	return m;
}

/**
 * S-parameter series over the frequencies of a driven solve. Keys may differ between frequencies (a mode that becomes
 * evanescent is not reported): a series takes NaN where its (out, in) key pair is absent, so the plot breaks there.
 */
export function sParamSeries(w: Wave2DExtras, o: { wrap?: boolean } = {}): { series: SSeries[]; xUnit: string; nFreq: number } {
	const freqs = w.perFrequency.map((p) => p.f);
	const ax = axisPrefix(freqs, 'Hz');
	const id = (k: { port: string; mode: number }) => `${k.port}#${k.mode}`;
	const allKeys: Array<{ port: string; mode: number }> = [];
	const seen = new Set<string>();
	for (const p of w.perFrequency) for (const k of p.S?.keys ?? []) if (!seen.has(id(k))) { seen.add(id(k)); allKeys.push(k); }
	if (!allKeys.length) return { series: [], xUnit: ax.unit, nFreq: freqs.length };
	const pidx = portIndex(allKeys);
	const multiMode = allKeys.some((k) => k.mode > 0);
	const series: SSeries[] = [];
	for (let i = 0; i < allKeys.length; i++)
		for (let j = 0; j < allKeys.length; j++) {
			const ki = allKeys[i]!, kj = allKeys[j]!;
			const a = pidx.get(ki.port)!, b = pidx.get(kj.port)!;
			const name = `S${a}${b}${multiMode ? ` (mode ${ki.mode} from ${kj.mode})` : ''}`;
			const s: SSeries = { name, tip: `S${a}${b}: out port ${ki.port} mode ${ki.mode}, in port ${kj.port} mode ${kj.mode}; power-normalised (|S|^2 = power ratio)`, out: i, inp: j, inLabel: `port ${b} (${kj.port})${multiMode ? ` mode ${kj.mode}` : ''}`, x: [], dB: [], deg: [], abs: [] };
			const ph: number[] = [];
			for (const p of w.perFrequency) {
				s.x.push(p.f * ax.f);
				const S = p.S;
				const ii = S ? S.keys.findIndex((k) => id(k) === id(ki)) : -1, jj = S ? S.keys.findIndex((k) => id(k) === id(kj)) : -1;
				if (!S || ii < 0 || jj < 0) { s.dB.push(NaN); s.abs.push(NaN); ph.push(NaN); continue; }
				const n = S.keys.length, re = S.re[ii * n + jj]!, im = S.im[ii * n + jj]!, ab = Math.hypot(re, im);
				s.abs.push(ab);
				s.dB.push(20 * Math.log10(ab));
				ph.push(Math.atan2(im, re));
			}
			const p2 = o.wrap ? ph : unwrapPieces(ph);
			s.deg = p2.map((v) => (v * 180) / Math.PI);
			series.push(s);
		}
	return { series, xUnit: ax.unit, nFreq: freqs.length };
}

/** Unwrap each finite run separately (NaN breaks the run). */
function unwrapPieces(p: number[]): number[] {
	const out: number[] = [];
	let run: number[] = [];
	const flush = () => { out.push(...unwrap(run)); run = []; };
	for (const v of p) {
		if (Number.isFinite(v)) run.push(v);
		else { flush(); out.push(NaN); }
	}
	flush();
	return out;
}

/** Sum over outputs of |S_ij|^2 for each input j (1 for a lossless network with all propagating modes reported). */
export function powerBalance(w: Wave2DExtras): Array<{ f: number; inp: string; sum: number }> {
	const out: Array<{ f: number; inp: string; sum: number }> = [];
	for (const p of w.perFrequency) {
		const S = p.S;
		if (!S) continue;
		const n = S.keys.length;
		for (let j = 0; j < n; j++) {
			let q = 0;
			for (let i = 0; i < n; i++) q += S.re[i * n + j]! ** 2 + S.im[i * n + j]! ** 2;
			out.push({ f: p.f, inp: `${S.keys[j]!.port} mode ${S.keys[j]!.mode}`, sum: q });
		}
	}
	return out;
}

export interface FarField { f: number; phiDeg: number[]; sigma: number[]; max: number }
/** Far fields per frequency (phi in degrees from +x, sigma_2D in m). */
export function farFields(w: Wave2DExtras): FarField[] {
	const out: FarField[] = [];
	for (const p of w.perFrequency) {
		const ff = p.farField;
		if (!ff || !Array.isArray(ff.phi) || !Array.isArray(ff.sigma2d) || !ff.phi.length) continue;
		let mx = 0;
		for (const v of ff.sigma2d) if (Number.isFinite(v) && v > mx) mx = v;
		out.push({ f: p.f, phiDeg: ff.phi.map((v) => (v * 180) / Math.PI), sigma: ff.sigma2d.slice(), max: mx });
	}
	return out;
}

/** dB of sigma_2D relative to 1 m (10 log10(sigma / 1 m)); values below `floorDb` under the maximum are clamped. */
export function sigmaDb(sigma: ArrayLike<number>, floorDb = 60): number[] {
	let mx = 0;
	for (let i = 0; i < sigma.length; i++) if (sigma[i]! > mx) mx = sigma[i]!;
	const lo = mx > 0 ? 10 * Math.log10(mx) - floorDb : -floorDb;
	return Array.from(sigma, (v) => (v > 0 ? Math.max(lo, 10 * Math.log10(v)) : lo));
}

/** Band diagram series: one per band, x = path length (1/m), y = frequency in the prefixed unit; labelled points. */
export function bandSeries(w: Wave2DExtras, o: { normalized?: boolean } = {}): { series: Array<{ name: string; x: number[]; y: number[] }>; yUnit: string; marks: Array<{ x: number; label: string }> } | null {
	const b = w.bands;
	if (!b || !b.distance.length) return null;
	const nb = Math.max(0, ...b.f.map((r) => r.length));
	const all: number[] = [];
	for (const r of b.f) for (const v of r) all.push(v);
	const a = latticeConstant(w);
	const ax = o.normalized && a ? { f: a / C0, unit: 'f a / c0' } : axisPrefix(all, 'Hz');
	const series = Array.from({ length: nb }, (_, j) => ({ name: `band ${j + 1}`, x: b.distance.slice(), y: b.f.map((r) => (r[j] === undefined ? NaN : r[j]! * ax.f)) }));
	return { series, yUnit: ax.unit, marks: b.labels.filter((l) => l.index >= 0 && l.index < b.distance.length).map((l) => ({ x: b.distance[l.index]!, label: l.label })) };
}

/** speed of light in vacuum, m/s (exact by the SI definition of the metre) */
export const C0 = 299792458;
/** Lattice constant |a_1| (m) of a band study, null when the lattice is not given. */
export function latticeConstant(w: Wave2DExtras): number | null {
	const a = w.bands?.lattice?.a?.[0];
	const v = a && a.length >= 2 ? Math.hypot(a[0]!, a[1]!) : NaN;
	return Number.isFinite(v) && v > 0 ? v : null;
}
