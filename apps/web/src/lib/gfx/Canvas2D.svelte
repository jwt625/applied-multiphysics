<script lang="ts">
	// SPDX-License-Identifier: GPL-3.0-or-later
	// 2D graphics canvas: WebGL2 layered field renderer (renderer2d.ts), pan (drag), wheel zoom at the cursor, fit,
	// hover probe in world coordinates, click pick (a press released within 4 px: probe table, DevLog-020), and
	// draggable handles (SVG overlay) for direct manipulation. The canvas fills its container absolutely, so nothing in
	// the page can shift or resize it except the container itself.
	// Results (DevLog-027): a draw tool ('line': press-drag-release, 'point': click) reports world points instead of
	// panning; overlays for coloured boundary lines (plot2d line item), arrows (arrow surface) and dataset guides (cut
	// lines and cut points, dashed, labelled).
	import { onMount, untrack } from 'svelte';
	import { Renderer2D, type Layer2D, type View2D } from './renderer2d';
	import { grabCanvas, registerCapture } from './capture';

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
		onpick,
		onhandle,
		onframe,
		lines = null,
		hiLines = null,
		markers = [],
		padRight = 0,
		padTop = 0,
		flow = null,
		frameKey = '',
		draw = null,
		ondraw,
		colorLines = [],
		arrows = null,
		guides = []
	}: {
		/** draw tool: 'line' = press-drag-release reports both ends, 'point' = a click reports the point; no pan */
		draw?: 'line' | 'point' | null;
		ondraw?: (p0: { x: number; y: number }, p1: { x: number; y: number } | null) => void;
		/** boundary segments x0 y0 x1 y1 (m) per colour */
		colorLines?: Array<{ segs: Float64Array; color: string }>;
		/** arrows x y vx vy (m) */
		arrows?: Float64Array | null;
		/** dataset guides: a cut line (seg) or cut point (pt), world m */
		guides?: Array<{ id: string; seg?: [number, number, number, number]; pt?: [number, number]; label: string; tip: string; on?: boolean }>;
		/** flux / stream lines: segments x0, y0, x1, y1 and direction marks x, y, dx, dy (m) */
		flow?: { segs: Float64Array; arrows: Float64Array } | null;
		/** extra px kept free at the top on phones (an overlay such as the Play headline) when fitting */
		padTop?: number;
		/** a change re-frames the view to `bbox` with an eased camera move (ROI / All, ROI after a drag) */
		frameKey?: string;
		/** labelled point markers (e.g. the peak of the drawn field), world coordinates */
		markers?: Array<{ x: number; y: number; label: string; tip: string; kind?: 'probe' }>;
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
		/** click (press and release within 4 px, no handle): world point in m */
		onpick?: (p: { x: number; y: number }) => void;
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
	/** the user panned or zoomed since the last fit: a container resize then keeps the view (else it re-fits) */
	let userMoved = false;
	let raf = 0;

	// eased camera (DevLog-015): log-scale zoom and linear pan over EASE_MS; any pan or wheel stops it
	const EASE_MS = 380;
	let anim = 0;
	function animateTo(t: View2D) {
		cancelAnimationFrame(anim);
		const a = { ...view }, t0 = performance.now();
		const step = (now: number) => {
			const k = Math.min(1, (now - t0) / EASE_MS), e = k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2;
			view = { cx: a.cx + (t.cx - a.cx) * e, cy: a.cy + (t.cy - a.cy) * e, scale: a.scale * (t.scale / a.scale) ** e };
			if (k < 1) anim = requestAnimationFrame(step);
		};
		anim = requestAnimationFrame(step);
	}

	function fit(ease = false) {
		if (!bbox) return;
		userMoved = false;
		const [x0, y0, x1, y1] = bbox;
		// desktop: colorbar on the right; phones (<= 760 px): horizontal colorbar at the bottom
		const narrow = typeof window !== 'undefined' && window.innerWidth <= 760;
		const pr = !narrow && w > 2 * padRight ? padRight : 0, pt = narrow ? 64 + padTop : 34, pb = narrow ? 22 : 20;
		const aw = Math.max(1, w - pr - 8), ah = Math.max(1, h - pt - pb);
		const scale = Math.min((0.94 * aw) / Math.max(1e-30, x1 - x0), (0.94 * ah) / Math.max(1e-30, y1 - y0));
		// centre of the free area (left of the colorbar, below the toolbar)
		const dx = (pr - 8) / 2 / scale, dy = (pt - pb) / 2 / scale;
		const t = { cx: (x0 + x1) / 2 + dx, cy: (y0 + y1) / 2 + dy, scale };
		if (ease && Number.isFinite(view.scale) && view.scale > 0) animateTo(t);
		else view = t;
	}

	export function fitView() { fit(true); }

	const toWorld = (px: number, py: number) => ({ x: view.cx + (px - w / 2) / view.scale, y: view.cy - (py - h / 2) / view.scale });
	const toPx = (x: number, y: number) => ({ px: w / 2 + (x - view.cx) * view.scale, py: h / 2 - (y - view.cy) * view.scale });

	// handle size: 12 px with a mouse, 26 px on touch-sized screens (audit M3)
	const hs = $derived(typeof window !== 'undefined' && window.innerWidth <= 760 ? 26 : 12);

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
	const flowPath = $derived(pathOf(flow?.segs ?? null));
	const flowMarks = $derived.by(() => {
		const A = flow?.arrows;
		if (!A || !A.length) return '';
		let d = '';
		for (let i = 0; i < A.length; i += 4) {
			const p = toPx(A[i]!, A[i + 1]!), dx = A[i + 2]!, dy = -A[i + 3]!;
			const s = 5, bx = p.px - dx * s, by = p.py - dy * s;
			d += `M${(bx - dy * 3.5).toFixed(1)} ${(by + dx * 3.5).toFixed(1)}L${(p.px + dx * 2).toFixed(1)} ${(p.py + dy * 2).toFixed(1)}L${(bx + dy * 3.5).toFixed(1)} ${(by - dx * 3.5).toFixed(1)}`;
		}
		return d;
	});
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
			const changed = Math.abs(b.width - w) > 1 || Math.abs(b.height - h) > 1;
			w = Math.max(1, b.width);
			h = Math.max(1, b.height);
			// e.g. the agent column opens: re-fit unless the user has moved the view (audit S5)
			if (changed && fittedKey !== -1 && !userMoved) fit(false);
		});
		ro.observe(host);
		const unreg = registerCapture(() => (r ? grabCanvas(canvas, () => r!.draw({ view, background, layers })) : null));
		return () => {
			unreg();
			ro.disconnect();
			cancelAnimationFrame(raf);
			cancelAnimationFrame(anim);
			r?.dispose();
			r = null;
		};
	});

	// fit on the first mesh and on explicit requests only: the view stays where the user put it across edits
	let framed: string | null = null;
	$effect(() => {
		if (bbox && w > 1 && fittedKey !== fitKey) {
			const first = fittedKey === -1;
			fittedKey = fitKey;
			framed = frameKey;
			untrack(() => fit(!first));
		}
	});
	$effect(() => {
		if (bbox && w > 1 && framed !== null && frameKey !== framed) {
			framed = frameKey;
			untrack(() => fit(true));
		}
	});

	$effect(() => {
		void layers; void view; void w; void h; void background;
		schedule();
	});

	let drag = $state.raw<{ kind: 'pan'; x: number; y: number; cx: number; cy: number; moved: boolean } | { kind: 'handle'; h: Handle } | { kind: 'draw'; p0: { x: number; y: number }; p1: { x: number; y: number } } | null>(null);
	const colorPaths = $derived(colorLines.map((c) => ({ d: pathOf(c.segs), color: c.color })));
	const arrowPath = $derived.by(() => {
		const A = arrows;
		if (!A || !A.length) return '';
		let d = '';
		for (let i = 0; i < A.length; i += 4) {
			const a = toPx(A[i]!, A[i + 1]!), b = toPx(A[i]! + A[i + 2]!, A[i + 1]! + A[i + 3]!);
			const dx = b.px - a.px, dy = b.py - a.py, L = Math.hypot(dx, dy);
			if (L < 0.5) continue;
			const ux = dx / L, uy = dy / L, hl = Math.min(6, 0.35 * L);
			d += `M${a.px.toFixed(1)} ${a.py.toFixed(1)}L${b.px.toFixed(1)} ${b.py.toFixed(1)}M${(b.px - hl * ux - 0.5 * hl * uy).toFixed(1)} ${(b.py - hl * uy + 0.5 * hl * ux).toFixed(1)}L${b.px.toFixed(1)} ${b.py.toFixed(1)}L${(b.px - hl * ux + 0.5 * hl * uy).toFixed(1)} ${(b.py - hl * uy - 0.5 * hl * ux).toFixed(1)}`;
		}
		return d;
	});
	/** peak label placement inside the canvas: px, py of the point, text width estimate (11 px mono) */
	function labelBox(px: number, py: number, text: string) {
		const tw = 6.7 * text.length + 8, th = 17;
		const right = px + 12 + tw < w - 4, up = py - 12 - th > 40;
		const lx = right ? px + 12 : px - 12 - tw, ly = up ? py - 12 - th : py + 12;
		return { lx: Math.round(lx) + 0.5, ly: Math.round(ly) + 0.5, tw, th, ax: Math.round(right ? lx : lx + tw) + 0.5, ay: Math.round(up ? ly + th : ly) + 0.5 };
	}

	function down(e: PointerEvent) {
		if (e.button !== 0) return;
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		if (draw) {
			const b = host.getBoundingClientRect(), p = toWorld(e.clientX - b.left, e.clientY - b.top);
			drag = { kind: 'draw', p0: p, p1: p };
			return;
		}
		drag = { kind: 'pan', x: e.clientX, y: e.clientY, cx: view.cx, cy: view.cy, moved: false };
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
			// a press that has not moved 4 px is still a click candidate (no pan yet)
			if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 4) return;
			if (!drag.moved) { drag = { ...drag, moved: true }; cancelAnimationFrame(anim); userMoved = true; }
			view = { ...view, cx: drag.cx - (e.clientX - drag.x) / view.scale, cy: drag.cy + (e.clientY - drag.y) / view.scale };
		} else if (drag?.kind === 'handle') {
			onhandle?.(drag.h.id, p.x, p.y, 'move');
		} else if (drag?.kind === 'draw') {
			drag = { ...drag, p1: p };
		} else onhover?.(p);
	}
	function up(e: PointerEvent) {
		if (drag?.kind === 'draw') {
			const d = drag, a = toPx(d.p0.x, d.p0.y), b = toPx(d.p1.x, d.p1.y);
			drag = null;
			if (draw === 'point') ondraw?.(d.p0, null);
			else if (Math.hypot(b.px - a.px, b.py - a.py) >= 6) ondraw?.(d.p0, d.p1);
			return;
		}
		if (drag?.kind === 'handle') {
			const b = host.getBoundingClientRect();
			const p = toWorld(e.clientX - b.left, e.clientY - b.top);
			onhandle?.(drag.h.id, p.x, p.y, 'end');
		} else if (drag?.kind === 'pan' && !drag.moved && onpick) {
			const b = host.getBoundingClientRect();
			onpick(toWorld(e.clientX - b.left, e.clientY - b.top));
		}
		drag = null;
	}
	function wheel(e: WheelEvent) {
		e.preventDefault();
		cancelAnimationFrame(anim);
		userMoved = true;
		const b = host.getBoundingClientRect();
		const px = e.clientX - b.left, py = e.clientY - b.top;
		const before = toWorld(px, py);
		const k = Math.exp(-e.deltaY * 0.0015);
		const scale = view.scale * k;
		view = { scale, cx: before.x - (px - w / 2) / scale, cy: before.y + (py - h / 2) / scale };
	}
</script>

<div class="host" class:drawing={!!draw} bind:this={host} role="presentation" onpointerdown={down} onpointermove={move} onpointerup={up} onpointerleave={() => !drag && onhover?.(null)} onwheel={wheel}>
	<canvas bind:this={canvas}></canvas>
	<svg class="ov" width={w} height={h}>
		{#if flowPath}<path class="fl" d={flowPath} /><path class="fm" d={flowMarks} />{/if}
		{#if linePath}<path class="ln" d={linePath} />{/if}
		{#if hiPath}<path class="hl" d={hiPath} />{/if}
		{#each colorPaths as c, k (k)}<path class="cl" d={c.d} style:stroke={c.color} />{/each}
		{#if arrowPath}<path class="ar" d={arrowPath} />{/if}
		{#each guides as g (g.id)}
			{#if g.seg}
				{@const a = toPx(g.seg[0], g.seg[1])}
				{@const b = toPx(g.seg[2], g.seg[3])}
				<g class="gd" class:on={g.on} data-tip={g.tip}><line x1={a.px} y1={a.py} x2={b.px} y2={b.py} /><line class="hit" x1={a.px} y1={a.py} x2={b.px} y2={b.py} /><text x={b.px + 6} y={b.py - 4}>{g.label}</text></g>
			{:else if g.pt}
				{@const a = toPx(g.pt[0], g.pt[1])}
				<g class="gd" class:on={g.on} data-tip={g.tip}><path d="M{a.px - 4} {a.py - 4}L{a.px + 4} {a.py + 4}M{a.px - 4} {a.py + 4}L{a.px + 4} {a.py - 4}" /><text x={a.px + 6} y={a.py - 4}>{g.label}</text></g>
			{/if}
		{/each}
		{#if drag?.kind === 'draw'}
			{@const a = toPx(drag.p0.x, drag.p0.y)}
			{@const b = toPx(drag.p1.x, drag.p1.y)}
			{#if draw === 'line'}<line class="rub" x1={a.px} y1={a.py} x2={b.px} y2={b.py} />{:else}<circle class="rub" cx={a.px} cy={a.py} r="4" />{/if}
		{/if}
		{#each markers as mk}
			{@const p = toPx(mk.x, mk.y)}
			{@const px = Math.round(p.px) + 0.5}
			{@const py = Math.round(p.py) + 0.5}
			{#if px > -20 && px < w + 20 && py > -20 && py < h + 20}
				{@const b = labelBox(px, py, mk.label)}
				<g class="mk" class:pr={mk.kind === 'probe'} data-tip={mk.tip}>
					<path class="mkx" d="M{px - 7} {py}H{px - 3}M{px + 3} {py}H{px + 7}M{px} {py - 7}V{py - 3}M{px} {py + 3}V{py + 7}" />
					<rect class="mkr" x={px - 3} y={py - 3} width="6" height="6" />
					<path class="mkl" d="M{px} {py}L{b.ax} {b.ay}" />
					<rect class="mkb" x={b.lx} y={b.ly} width={b.tw} height={b.th} />
					<text x={b.lx + 4} y={b.ly + 12.5}>{mk.label}</text>
				</g>
			{/if}
		{/each}
		<!-- handles above the markers (a marker at a cut-line end must not hide the handle) -->
		{#each handles as hd (hd.id)}
			{@const p = toPx(hd.x, hd.y)}
			{#if hd.ring !== undefined && hd.cx !== undefined && hd.cy !== undefined && drag?.kind === 'handle' && drag.h.id === hd.id}
				{@const c = toPx(hd.cx, hd.cy)}
				<circle class="ring" cx={c.px} cy={c.py} r={hd.ring * view.scale} />
			{/if}
			<rect class="hd" x={p.px - hs / 2} y={p.py - hs / 2} width={hs} height={hs} data-tip={hd.tip} role="slider" aria-valuenow={0} tabindex="-1" onpointerdown={(e) => handleDown(e, hd)} />
		{/each}
	</svg>
	{#if failed}<div class="fail">{failed}</div>{/if}
</div>

<style>
	.host { position: absolute; inset: 0; overflow: hidden; touch-action: none; cursor: crosshair; }
	.host.drawing { cursor: cell; }
	canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
	.ov { position: absolute; inset: 0; pointer-events: none; }
	.hd { fill: rgba(57, 135, 229, 0.25); stroke: #8ab8f0; stroke-width: 1.5; pointer-events: all; cursor: grab; }
	.hd:hover { fill: rgba(57, 135, 229, 0.6); }
	.fl { fill: none; stroke: #f2f1ec; stroke-width: 1.1; opacity: 0.62; }
	.fm { fill: none; stroke: #f2f1ec; stroke-width: 1.3; opacity: 0.85; }
	.ln { fill: none; stroke: #e8e8e8; stroke-width: 1; opacity: 0.85; }
	.hl { fill: none; stroke: #e0a526; stroke-width: 3; }
	.mk { pointer-events: all; shape-rendering: crispEdges; }
	.mkx { stroke: #f2f1ec; stroke-width: 1; fill: none; }
	.mkr { fill: none; stroke: #f2f1ec; stroke-width: 1; }
	.mkl { stroke: rgba(242, 241, 236, 0.7); stroke-width: 1; fill: none; shape-rendering: auto; }
	.mkb { fill: rgba(13, 13, 13, 0.82); stroke: rgba(242, 241, 236, 0.35); stroke-width: 1; }
	.mk text { fill: #f2f1ec; font: 11px var(--mono); shape-rendering: auto; }
	.pr .mkx, .pr .mkr { stroke: #e0a526; }
	.pr .mkb { stroke: rgba(224, 165, 38, 0.6); }
	.pr text { fill: #f0c76a; }
	.cl { fill: none; stroke-width: 3; stroke-linecap: round; }
	.ar { fill: none; stroke: #f2f1ec; stroke-width: 1.1; opacity: 0.9; }
	.gd { pointer-events: all; }
	.gd line, .gd path { stroke: #e0a526; stroke-width: 1.2; stroke-dasharray: 5 3; fill: none; }
	.gd line.hit { stroke: transparent; stroke-width: 9; stroke-dasharray: none; }
	.gd.on line:not(.hit), .gd.on path { stroke-width: 2; stroke-dasharray: none; }
	.gd text { fill: #f0c76a; font: 10px var(--mono); }
	.rub { fill: none; stroke: #8ab8f0; stroke-width: 1.5; stroke-dasharray: 4 3; }
	.ring { fill: none; stroke: #8ab8f0; stroke-width: 1; stroke-dasharray: 4 3; }
	.fail { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: var(--ink-3); }
</style>
