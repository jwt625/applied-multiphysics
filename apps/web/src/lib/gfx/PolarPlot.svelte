<script lang="ts">
	// SPDX-License-Identifier: GPL-3.0-or-later
	// Polar plot of a quantity over the angle phi (degrees from +x, counter-clockwise, the model's x-y frame): the 2D
	// scattering width sigma_2D(phi) of a driven solve (DevLog-052 s.2 item 4). SVG; radial axis linear in an absolute
	// unit with an engineering prefix, or dB relative to a reference with a floor; hover reads the nearest sample.
	import { niceTicks, fmt, fmtEng } from './ticks';
	import { sigmaDb } from './driven';

	let { phiDeg, r, unit, db = false, floorDb = 40, label, color = '#3987e5' }: {
		phiDeg: number[];
		/** radial values (SI, >= 0) */
		r: number[];
		unit: string;
		/** dB relative to 1 unit (10 log10), clamped `floorDb` below the maximum */
		db?: boolean;
		floorDb?: number;
		label: string;
		color?: string;
	} = $props();

	let W = $state(240), H = $state(240);
	const R = $derived(Math.max(10, Math.min(W, H) / 2 - 22));
	const cxp = $derived(W / 2), cyp = $derived(H / 2);
	const vals = $derived(db ? sigmaDb(r, floorDb) : r.slice());
	const lim = $derived.by(() => {
		let mx = -Infinity, mn = Infinity;
		for (const v of vals) if (Number.isFinite(v)) { mx = Math.max(mx, v); mn = Math.min(mn, v); }
		if (!Number.isFinite(mx)) return { lo: 0, hi: 1 };
		if (db) return { lo: Math.floor(mn / 10) * 10, hi: Math.ceil(mx / 10) * 10 === Math.floor(mn / 10) * 10 ? Math.ceil(mx / 10) * 10 + 10 : Math.ceil(mx / 10) * 10 };
		const t = niceTicks(0, mx, 4);
		return { lo: 0, hi: t.length && t[t.length - 1]! >= mx ? t[t.length - 1]! : mx };
	});
	const rad = (v: number) => (lim.hi > lim.lo ? (R * (Math.max(lim.lo, v) - lim.lo)) / (lim.hi - lim.lo) : 0);
	const xy = (deg: number, rr: number) => ({ x: cxp + rr * Math.cos((deg * Math.PI) / 180), y: cyp - rr * Math.sin((deg * Math.PI) / 180) });
	const path = $derived.by(() => {
		let d = '';
		for (let i = 0; i < phiDeg.length; i++) {
			const v = vals[i]!;
			if (!Number.isFinite(v)) continue;
			const p = xy(phiDeg[i]!, rad(v));
			d += `${d ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
		}
		return d ? `${d}Z` : '';
	});
	const rings = $derived(niceTicks(lim.lo, lim.hi, db ? Math.min(5, Math.round((lim.hi - lim.lo) / 10)) : 4).filter((t) => t > lim.lo));
	const ringLabel = (t: number) => (db ? `${fmt(t)} dB` : (() => { const e = fmtEng(t, unit); return `${e.num} ${e.unit}`; })());
	let hover = $state<{ x: number; y: number; text: string } | null>(null);
	function onMove(e: PointerEvent) {
		const b = (e.currentTarget as SVGElement).getBoundingClientRect();
		const x = e.clientX - b.left - cxp, y = cyp - (e.clientY - b.top);
		if (Math.hypot(x, y) > R + 12 || !phiDeg.length) { hover = null; return; }
		const a = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
		let k = 0, best = Infinity;
		for (let i = 0; i < phiDeg.length; i++) { const d = Math.abs(((phiDeg[i]! - a + 540) % 360) - 180); if (d < best) { best = d; k = i; } }
		const p = xy(phiDeg[k]!, rad(vals[k]!));
		const e0 = fmtEng(r[k]!, unit);
		hover = { x: p.x, y: p.y, text: `φ ${fmt(phiDeg[k]!, 4)}°  ${e0.num} ${e0.unit}${db ? ` (${fmt(vals[k]!, 3)} dB)` : ''}` };
	}
</script>

<div class="pp" bind:clientWidth={W} bind:clientHeight={H}>
	<svg width={W} height={H} role="img" aria-label={label} onpointermove={onMove} onpointerleave={() => (hover = null)}>
		{#each rings as t}
			<circle class="g" cx={cxp} cy={cyp} r={rad(t)} />
			<text class="tl" x={cxp + 3} y={cyp - rad(t) - 2}>{ringLabel(t)}</text>
		{/each}
		<circle class="g o" cx={cxp} cy={cyp} r={R} />
		{#each Array.from({ length: 12 }, (_, i) => 30 * i) as a}
			{@const p = xy(a, R)}
			{@const q = xy(a, R + 11)}
			<line class="g" x1={cxp} y1={cyp} x2={p.x} y2={p.y} />
			<text class="al" x={q.x} y={q.y + 3}>{a}°</text>
		{/each}
		{#if path}<path d={path} style:stroke={color} class="c" />{/if}
		{#if hover}<circle class="h" cx={hover.x} cy={hover.y} r="3" />{/if}
	</svg>
	{#if hover}<div class="tip mono">{hover.text}</div>{/if}
</div>

<style>
	.pp { position: relative; width: 100%; height: 100%; min-height: 0; overflow: hidden; }
	svg { display: block; }
	.g { fill: none; stroke: rgba(255, 255, 255, 0.1); stroke-width: 1; }
	.g.o { stroke: rgba(255, 255, 255, 0.22); }
	.c { fill: rgba(57, 135, 229, 0.12); stroke-width: 1.5; }
	.tl { font: 9px var(--mono); fill: var(--ink-3); }
	.al { font: 9px var(--mono); fill: var(--ink-3); text-anchor: middle; }
	.h { fill: none; stroke: #f2f1ec; stroke-width: 1; }
	.tip { position: absolute; left: 4px; top: 2px; font-size: 10px; color: var(--ink); background: rgba(13, 13, 13, 0.85); padding: 0 4px; pointer-events: none; }
</style>
