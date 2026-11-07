<script lang="ts" module>
	// Ported from eo-modulator-atlas/app/src/lib/sim/LinePlot.svelte at 0546007 (GPL-3.0-or-later). Changes: CSV / PNG
	// export removed (no export of any kind, DevLog-023 s.5.1); the EO ticks helpers inlined below (linearTicks,
	// logTicks, tickLabel from app/src/lib/sim/ticks.ts at 0546007); fills its container (width and height from a
	// ResizeObserver) instead of a fixed height; crosshair (vertical and horizontal) with a marker on each series at the
	// hovered sample; series titles and units in the legend tooltips; a pen break at every non-finite value (pieces of
	// discontinuous expressions and separate chains are separated by NaN); `bindable` log toggles kept; theme hook dropped
	// (dark only); grid colour from --line; `dash` per series (an overlay on a coinciding curve stays visible).
	// SPDX-License-Identifier: GPL-3.0-or-later
	export interface Series {
		name: string;
		x: ArrayLike<number>;
		y: ArrayLike<number>;
		color?: string;
		markers?: boolean;
		line?: boolean;
		/** Right y axis (second axis, own range and label). */
		y2?: boolean;
		/** legend tooltip (expression, dataset, method) */
		tip?: string;
		/** dashed line (overlaid series stay visible where they coincide) */
		dash?: boolean;
	}
	export const SERIES_COLORS = ['#3987e5', '#e0803a', '#3fae7a', '#c160c1', '#c9a227', '#5bb5c9'];

	/** "Nice" linear ticks covering [min, max] with about `target` intervals. */
	export function linearTicks(min: number, max: number, target = 5): number[] {
		if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
		if (min === max) return [min];
		if (min > max) [min, max] = [max, min];
		const raw = (max - min) / Math.max(1, target);
		const mag = Math.pow(10, Math.floor(Math.log10(raw)));
		const norm = raw / mag;
		const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
		const out: number[] = [];
		const start = Math.ceil(min / step - 1e-9);
		const end = Math.floor(max / step + 1e-9);
		for (let k = start; k <= end; k++) out.push(Math.abs(k * step) < step * 1e-9 ? 0 : Number((k * step).toPrecision(12)));
		return out;
	}
	/** Decade ticks (and 2, 5 subdivisions when the range spans few decades) for a positive range. */
	export function logTicks(min: number, max: number): number[] {
		if (!(min > 0) || !(max > 0)) return [];
		if (min > max) [min, max] = [max, min];
		const d0 = Math.floor(Math.log10(min)), d1 = Math.ceil(Math.log10(max));
		const span = d1 - d0;
		const mult = span <= 2 ? [1, 2, 5] : [1];
		const stride = span > 10 ? Math.ceil(span / 8) : 1;
		const out: number[] = [];
		for (let d = d0; d <= d1; d += stride)
			for (const m of mult) {
				const v = m * Math.pow(10, d);
				if (v >= min * (1 - 1e-9) && v <= max * (1 + 1e-9)) out.push(v);
			}
		return out;
	}
	/** Tick label with no trailing zeros; exponent form outside [1e-3, 1e5). */
	export function tickLabel(v: number): string {
		if (v === 0) return '0';
		const a = Math.abs(v);
		if (a < 1e-3 || a >= 1e5) {
			const [m, e] = v.toExponential(2).split('e');
			return `${m!.replace(/\.?0+$/, '')}e${e!.replace('+', '')}`;
		}
		return String(Number(v.toPrecision(6)));
	}
</script>

<script lang="ts">
	import { onMount } from 'svelte';

	interface Props {
		series: Series[];
		xLabel: string;
		yLabel: string;
		logX?: boolean;
		logY?: boolean;
		ariaLabel: string;
		toggles?: boolean;
		/** Label of the right y axis (series with y2). */
		y2Label?: string;
		/** extra legend / status text (right of the toggles) */
		note?: string;
	}
	let { series, xLabel, yLabel, logX = $bindable(false), logY = $bindable(false), ariaLabel, toggles = true, y2Label = '', note = '' }: Props = $props();
	const hasY2 = $derived(series.some((s) => s.y2));

	let wrap: HTMLDivElement;
	let cv: HTMLDivElement;
	let canvas: HTMLCanvasElement;
	let width = $state(300);
	let height = $state(200);
	let hover = $state<{ px: number; py: number; lines: string[]; marks: Array<{ x: number; y: number; c: string }> } | null>(null);
	let frame: { x0: number; x1: number; y0: number; y1: number; z0: number; z1: number; left: number; top: number; w: number; h: number } | null = null;

	const tx = (v: number) => (logX ? Math.log10(v) : v);
	const ty = (v: number) => (logY ? Math.log10(v) : v);
	const okX = (v: number) => Number.isFinite(v) && (!logX || v > 0);
	const okY = (v: number) => Number.isFinite(v) && (!logY || v > 0);
	const colorOf = (s: Series, k: number) => s.color ?? SERIES_COLORS[k % SERIES_COLORS.length]!;

	function extent() {
		let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
		const add = (x: number, y: number, right = false) => {
			if (!okX(x) || !okY(y)) return;
			x0 = Math.min(x0, tx(x)); x1 = Math.max(x1, tx(x));
			if (right) { z0 = Math.min(z0, ty(y)); z1 = Math.max(z1, ty(y)); }
			else { y0 = Math.min(y0, ty(y)); y1 = Math.max(y1, ty(y)); }
		};
		for (const s of series) for (let i = 0; i < s.x.length; i++) add(s.x[i]!, s.y[i]!, !!s.y2);
		if (!Number.isFinite(x0)) return null;
		const pad = (a: number, b: number) => (a === b ? [a - (Math.abs(a) || 1) * 0.05, b + (Math.abs(b) || 1) * 0.05] : [a - (b - a) * 0.04, b + (b - a) * 0.04]);
		if (!Number.isFinite(y0)) { y0 = 0; y1 = 1; }
		if (!Number.isFinite(z0)) { z0 = y0; z1 = y1; }
		[x0, x1] = pad(x0, x1) as [number, number];
		[y0, y1] = pad(y0, y1) as [number, number];
		[z0, z1] = pad(z0, z1) as [number, number];
		return { x0, x1, y0, y1, z0, z1 };
	}

	function css(name: string) {
		return getComputedStyle(wrap).getPropertyValue(name).trim() || '#888';
	}

	function draw() {
		if (!canvas || !wrap) return;
		const dpr = window.devicePixelRatio || 1;
		const W = width, H = height;
		canvas.width = Math.round(W * dpr);
		canvas.height = Math.round(H * dpr);
		const ctx = canvas.getContext('2d')!;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, W, H);
		const ink = css('--ink-2'), ink3 = css('--ink-3'), grid = 'rgba(255, 255, 255, 0.07)', line = css('--line');
		ctx.font = '10px system-ui, sans-serif';
		const e = extent();
		const left = 58, right = hasY2 ? 58 : 10, top = 8, bottom = 32;
		const w = Math.max(10, W - left - right), h = Math.max(10, H - top - bottom);
		ctx.fillStyle = ink3;
		ctx.textAlign = 'center';
		ctx.fillText(xLabel, left + w / 2, H - 4);
		ctx.save();
		ctx.translate(11, top + h / 2);
		ctx.rotate(-Math.PI / 2);
		ctx.fillText(yLabel, 0, 0);
		ctx.restore();
		if (hasY2) {
			ctx.save();
			ctx.translate(W - 6, top + h / 2);
			ctx.rotate(Math.PI / 2);
			ctx.fillText(y2Label, 0, 0);
			ctx.restore();
		}
		ctx.strokeStyle = line;
		ctx.strokeRect(left + 0.5, top + 0.5, w, h);
		if (!e) {
			frame = null;
			ctx.fillText('No data', left + w / 2, top + h / 2);
			return;
		}
		frame = { ...e, left, top, w, h };
		const X = (v: number) => left + ((v - e.x0) / (e.x1 - e.x0)) * w;
		const Y = (v: number) => top + h - ((v - e.y0) / (e.y1 - e.y0)) * h;
		const Z = (v: number) => top + h - ((v - e.z0) / (e.z1 - e.z0)) * h;
		const xt = logX ? logTicks(10 ** e.x0, 10 ** e.x1) : linearTicks(e.x0, e.x1, Math.max(2, Math.floor(w / 70)));
		const yt = logY ? logTicks(10 ** e.y0, 10 ** e.y1) : linearTicks(e.y0, e.y1, Math.max(2, Math.floor(h / 40)));
		ctx.lineWidth = 1;
		for (const t of xt) {
			const px = Math.round(X(tx(t))) + 0.5;
			ctx.strokeStyle = grid;
			ctx.beginPath(); ctx.moveTo(px, top); ctx.lineTo(px, top + h); ctx.stroke();
			ctx.fillStyle = ink;
			ctx.fillText(tickLabel(t), px, top + h + 12);
		}
		ctx.textAlign = 'right';
		for (const t of yt) {
			const py = Math.round(Y(ty(t))) + 0.5;
			ctx.strokeStyle = grid;
			ctx.beginPath(); ctx.moveTo(left, py); ctx.lineTo(left + w, py); ctx.stroke();
			ctx.fillStyle = ink;
			ctx.fillText(tickLabel(t), left - 4, py + 3);
		}
		if (hasY2) {
			ctx.textAlign = 'left';
			const zt = logY ? logTicks(10 ** e.z0, 10 ** e.z1) : linearTicks(e.z0, e.z1, Math.max(2, Math.floor(h / 40)));
			for (const t of zt) {
				const py = Math.round(Z(ty(t))) + 0.5;
				ctx.strokeStyle = line;
				ctx.beginPath(); ctx.moveTo(left + w, py); ctx.lineTo(left + w + 4, py); ctx.stroke();
				ctx.fillStyle = ink;
				ctx.fillText(tickLabel(t), left + w + 6, py + 3);
			}
		}
		ctx.save();
		ctx.beginPath();
		ctx.rect(left, top, w, h);
		ctx.clip();
		series.forEach((s, k) => {
			const color = colorOf(s, k);
			ctx.strokeStyle = color;
			ctx.fillStyle = color;
			ctx.lineWidth = 1.6;
			const YY = s.y2 ? Z : Y;
			if (s.y2 || s.dash) ctx.setLineDash(s.y2 ? [6, 3] : [7, 4]);
			if (s.line !== false) {
				ctx.beginPath();
				let pen = false;
				for (let i = 0; i < s.x.length; i++) {
					if (!okX(s.x[i]!) || !okY(s.y[i]!)) { pen = false; continue; }
					const px = X(tx(s.x[i]!)), py = YY(ty(s.y[i]!));
					if (pen) ctx.lineTo(px, py); else ctx.moveTo(px, py);
					pen = true;
				}
				ctx.stroke();
			}
			ctx.setLineDash([]);
			if (s.markers) for (let i = 0; i < s.x.length; i++) {
				if (!okX(s.x[i]!) || !okY(s.y[i]!)) continue;
				ctx.fillRect(X(tx(s.x[i]!)) - 2.5, YY(ty(s.y[i]!)) - 2.5, 5, 5);
			}
		});
		ctx.restore();
		if (hover) {
			ctx.strokeStyle = ink3;
			ctx.setLineDash([3, 3]);
			ctx.beginPath(); ctx.moveTo(Math.round(hover.px) + 0.5, top); ctx.lineTo(Math.round(hover.px) + 0.5, top + h); ctx.stroke();
			ctx.beginPath(); ctx.moveTo(left, Math.round(hover.py) + 0.5); ctx.lineTo(left + w, Math.round(hover.py) + 0.5); ctx.stroke();
			ctx.setLineDash([]);
			for (const m of hover.marks) { ctx.strokeStyle = m.c; ctx.lineWidth = 1.5; ctx.strokeRect(m.x - 3.5, m.y - 3.5, 7, 7); }
		}
	}

	function onMove(ev: PointerEvent) {
		if (!frame) return;
		const r = canvas.getBoundingClientRect();
		const mx = ev.clientX - r.left, my = ev.clientY - r.top;
		const f = frame;
		if (mx < f.left || mx > f.left + f.w || my < f.top || my > f.top + f.h) { hover = null; return; }
		const X = (v: number) => f.left + ((v - f.x0) / (f.x1 - f.x0)) * f.w;
		const Y = (v: number) => f.top + f.h - ((v - f.y0) / (f.y1 - f.y0)) * f.h;
		const Z = (v: number) => f.top + f.h - ((v - f.z0) / (f.z1 - f.z0)) * f.h;
		const lines: string[] = [];
		const marks: Array<{ x: number; y: number; c: string }> = [];
		let snap = mx, sy = my;
		series.forEach((s, k) => {
			let best = -1, bd = Infinity;
			for (let i = 0; i < s.x.length; i++) {
				if (!okX(s.x[i]!) || !okY(s.y[i]!)) continue;
				const d = Math.abs(X(tx(s.x[i]!)) - mx);
				if (d < bd) { bd = d; best = i; }
			}
			if (best >= 0 && bd < 40) {
				const px = X(tx(s.x[best]!)), py = (s.y2 ? Z : Y)(ty(s.y[best]!));
				if (!lines.length) { lines.push(`${xLabel}: ${tickLabel(Number(s.x[best]!.toPrecision(6)))}`); snap = px; sy = py; }
				lines.push(`${s.name}: ${tickLabel(Number(s.y[best]!.toPrecision(6)))}`);
				marks.push({ x: px, y: py, c: colorOf(s, k) });
			}
		});
		hover = lines.length ? { px: snap, py: sy, lines, marks } : null;
	}

	onMount(() => {
		const ro = new ResizeObserver(() => { width = Math.max(60, cv.clientWidth); height = Math.max(60, cv.clientHeight); });
		ro.observe(cv);
		width = Math.max(60, cv.clientWidth);
		height = Math.max(60, cv.clientHeight);
		return () => ro.disconnect();
	});

	$effect(() => {
		void [series, logX, logY, width, height, hover, xLabel, yLabel, y2Label];
		draw();
	});
</script>

<div class="lp" bind:this={wrap} data-series={series.length}>
	{#if toggles}
		<div class="bar">
			<label data-tip="Logarithmic x axis (non-positive values are not drawn)"><input type="checkbox" bind:checked={logX} /> log x</label>
			<label data-tip="Logarithmic y axis (non-positive values are not drawn)"><input type="checkbox" bind:checked={logY} /> log y</label>
			<span class="grow"></span>
			{#if note}<span class="note">{note}</span>{/if}
			{#each series as s, k}<span class="key" data-tip="{s.tip ?? s.name}{s.y2 ? '\n(right axis, dashed)' : ''}"><i class:dash={s.y2 || s.dash} style:background={colorOf(s, k)}></i>{s.name}</span>{/each}
		</div>
	{/if}
	<div class="cv" bind:this={cv} role="img" aria-label={ariaLabel}>
		<canvas bind:this={canvas} style:width="{width}px" style:height="{height}px" onpointermove={onMove} onpointerleave={() => (hover = null)}></canvas>
		{#if hover}
			<div class="tip" style:left="{Math.max(0, Math.min(hover.px + 12, width - 190))}px" style:top="{Math.max(0, Math.min(hover.py - 10, height - 16 * hover.lines.length - 10))}px">
				{#each hover.lines as l}<div>{l}</div>{/each}
			</div>
		{/if}
	</div>
</div>

<style>
	.lp { min-width: 0; width: 100%; height: 100%; display: flex; flex-direction: column; }
	.bar { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; padding: 2px 4px 4px; color: var(--ink-3); font-size: 11px; flex: none; }
	.bar label { display: flex; align-items: center; gap: 4px; }
	.grow { flex: 1; }
	.note { color: var(--ink-3); }
	.key { display: inline-flex; align-items: center; gap: 4px; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ink-2); }
	.key i { display: inline-block; width: 10px; height: 2px; flex: none; }
	.key i.dash { width: 4px; box-shadow: 6px 0 0 0 currentColor; }
	.cv { position: relative; flex: 1; min-height: 0; }
	canvas { display: block; touch-action: none; }
	.tip { position: absolute; pointer-events: none; background: var(--surface); border: 1px solid var(--line); padding: 4px 6px; font-size: 11px; font-family: var(--mono); white-space: nowrap; z-index: 2; }
</style>
