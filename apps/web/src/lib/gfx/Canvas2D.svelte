<script lang="ts">
	// SPDX-License-Identifier: GPL-3.0-or-later
	// 2D graphics canvas: WebGL2 layered field renderer (renderer2d.ts), pan (drag), wheel zoom at the cursor, fit,
	// hover probe in world coordinates, and draggable handles (SVG overlay) for direct manipulation. The canvas fills
	// its container absolutely, so nothing in the page can shift or resize it except the container itself.
	import { onMount, untrack } from 'svelte';
	import { Renderer2D, type Layer2D, type View2D } from './renderer2d';

	export interface Handle {
		id: string;
		/** world position (m) */
		x: number;
		y: number;
		tip: string;
		/** drag constrained to an axis: 'x', 'y' or 'radial' about (cx, cy) */
		axis?: 'x' | 'y' | 'xy' | 'radial';
		cx?: number;
		cy?: number;
		/** radius ring drawn about (cx, cy) for radial handles */
		ring?: number;
	}

	let {
		layers,
		bbox,
		background = '#0d0d0d',
		fitKey = 0,
		handles = [],
		onhover,
		onhandle,
		onframe,
		lines = null,
		hiLines = null,
		padRight = 80
	}: {
		layers: Layer2D[];
		/** segments x0, y0, x1, y1 (m) drawn as an outline overlay (geometry boundaries) */
		lines?: Float64Array | null;
		/** highlighted segments (navigation highlight) */
		hiLines?: Float64Array | null;
		/** px reserved on the right (colorbar) and top (toolbar) when fitting */
		padRight?: number;
		bbox: [number, number, number, number] | null;
		background?: string;
		fitKey?: number;
		handles?: Handle[];
		onhover?: (p: { x: number; y: number } | null) => void;
		onhandle?: (id: string, x: number, y: number, phase: 'move' | 'end') => void;
		onframe?: (ms: number) => void;
	} = $props();

	let host: HTMLDivElement;
	let canvas: HTMLCanvasElement;
	let r: Renderer2D | null = null;
	let failed = $state('');
	let w = $state(1);
	let h = $state(1);
	let view = $state<View2D>({ cx: 0, cy: 0, scale: 1 });
	let fittedKey = -1;
	let raf = 0;

	function fit() {
		if (!bbox) return;
		const [x0, y0, x1, y1] = bbox;
		const pr = w > 2 * padRight ? padRight : 0, pt = 34, pb = 20;
		const aw = Math.max(1, w - pr - 8), ah = Math.max(1, h - pt - pb);
		const scale = Math.min((0.94 * aw) / Math.max(1e-30, x1 - x0), (0.94 * ah) / Math.max(1e-30, y1 - y0));
		// centre of the free area (left of the colorbar, below the toolbar)
		const dx = (pr - 8) / 2 / scale, dy = (pt - pb) / 2 / scale;
		view = { cx: (x0 + x1) / 2 + dx, cy: (y0 + y1) / 2 + dy, scale };
	}

	export function fitView() { fit(); }

	const toWorld = (px: number, py: number) => ({ x: view.cx + (px - w / 2) / view.scale, y: view.cy - (py - h / 2) / view.scale });
	const toPx = (x: number, y: number) => ({ px: w / 2 + (x - view.cx) * view.scale, py: h / 2 - (y - view.cy) * view.scale });

	const pathOf = (L: Float64Array | null) => {
		if (!L || !L.length) return '';
		const v = view;
		let d = '';
		const lines = L;
		for (let i = 0; i < lines.length; i += 4) {
			const a = { px: w / 2 + (lines[i]! - v.cx) * v.scale, py: h / 2 - (lines[i + 1]! - v.cy) * v.scale };
			const b = { px: w / 2 + (lines[i + 2]! - v.cx) * v.scale, py: h / 2 - (lines[i + 3]! - v.cy) * v.scale };
			d += `M${a.px.toFixed(1)} ${a.py.toFixed(1)}L${b.px.toFixed(1)} ${b.py.toFixed(1)}`;
		}
		return d;
	};
	const linePath = $derived(pathOf(lines));
	const hiPath = $derived(pathOf(hiLines));

	function schedule() {
		if (raf) return;
		raf = requestAnimationFrame(() => {
			raf = 0;
			if (!r) return;
			const t0 = performance.now();
			r.resize(w, h, devicePixelRatio || 1);
			r.draw({ view, background, layers });
			onframe?.(performance.now() - t0);
		});
	}

	onMount(() => {
		r = Renderer2D.create(canvas);
		if (!r) failed = 'WebGL2 is not available in this browser';
		const ro = new ResizeObserver(() => {
			const b = host.getBoundingClientRect();
			w = Math.max(1, b.width);
			h = Math.max(1, b.height);
		});
		ro.observe(host);
		return () => {
			ro.disconnect();
			cancelAnimationFrame(raf);
			r?.dispose();
			r = null;
		};
	});

	// fit on the first mesh and on explicit requests only: the view stays where the user put it across edits
	$effect(() => {
		if (bbox && w > 1 && fittedKey !== fitKey) {
			fittedKey = fitKey;
			untrack(fit);
		}
	});

	$effect(() => {
		void layers; void view; void w; void h; void background;
		schedule();
	});

	let drag: { kind: 'pan'; x: number; y: number; cx: number; cy: number } | { kind: 'handle'; h: Handle } | null = null;

	function down(e: PointerEvent) {
		if (e.button !== 0) return;
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		drag = { kind: 'pan', x: e.clientX, y: e.clientY, cx: view.cx, cy: view.cy };
	}
	function handleDown(e: PointerEvent, hd: Handle) {
		e.stopPropagation();
		(e.currentTarget as Element).setPointerCapture(e.pointerId);
		drag = { kind: 'handle', h: hd };
	}
	function move(e: PointerEvent) {
		const b = host.getBoundingClientRect();
		const p = toWorld(e.clientX - b.left, e.clientY - b.top);
		if (drag?.kind === 'pan') {
			view = { ...view, cx: drag.cx - (e.clientX - drag.x) / view.scale, cy: drag.cy + (e.clientY - drag.y) / view.scale };
		} else if (drag?.kind === 'handle') {
			onhandle?.(drag.h.id, p.x, p.y, 'move');
		} else onhover?.(p);
	}
	function up(e: PointerEvent) {
		if (drag?.kind === 'handle') {
			const b = host.getBoundingClientRect();
			const p = toWorld(e.clientX - b.left, e.clientY - b.top);
			onhandle?.(drag.h.id, p.x, p.y, 'end');
		}
		drag = null;
	}
	function wheel(e: WheelEvent) {
		e.preventDefault();
		const b = host.getBoundingClientRect();
		const px = e.clientX - b.left, py = e.clientY - b.top;
		const before = toWorld(px, py);
		const k = Math.exp(-e.deltaY * 0.0015);
		const scale = view.scale * k;
		view = { scale, cx: before.x - (px - w / 2) / scale, cy: before.y + (py - h / 2) / scale };
	}
</script>

<div class="host" bind:this={host} role="presentation" onpointerdown={down} onpointermove={move} onpointerup={up} onpointerleave={() => !drag && onhover?.(null)} onwheel={wheel}>
	<canvas bind:this={canvas}></canvas>
	<svg class="ov" width={w} height={h}>
		{#if linePath}<path class="ln" d={linePath} />{/if}
		{#if hiPath}<path class="hl" d={hiPath} />{/if}
		{#each handles as hd (hd.id)}
			{@const p = toPx(hd.x, hd.y)}
			{#if hd.ring !== undefined && hd.cx !== undefined && hd.cy !== undefined}
				{@const c = toPx(hd.cx, hd.cy)}
				<circle class="ring" cx={c.px} cy={c.py} r={hd.ring * view.scale} />
			{/if}
			<rect class="hd" x={p.px - 6} y={p.py - 6} width="12" height="12" data-tip={hd.tip} role="slider" aria-valuenow={0} tabindex="-1" onpointerdown={(e) => handleDown(e, hd)} />
		{/each}
	</svg>
	{#if failed}<div class="fail">{failed}</div>{/if}
</div>

<style>
	.host { position: absolute; inset: 0; overflow: hidden; touch-action: none; cursor: crosshair; }
	canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
	.ov { position: absolute; inset: 0; pointer-events: none; }
	.hd { fill: rgba(57, 135, 229, 0.25); stroke: #8ab8f0; stroke-width: 1.5; pointer-events: all; cursor: grab; }
	.hd:hover { fill: rgba(57, 135, 229, 0.6); }
	.ln { fill: none; stroke: #e8e8e8; stroke-width: 1; opacity: 0.85; }
	.hl { fill: none; stroke: #e0a526; stroke-width: 3; }
	.ring { fill: none; stroke: #8ab8f0; stroke-width: 1; stroke-dasharray: 4 3; }
	.fail { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: var(--ink-3); }
</style>
