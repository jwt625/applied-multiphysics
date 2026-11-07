<script lang="ts">
	// SPDX-License-Identifier: GPL-3.0-or-later
	// 3D canvas around Viewer3D: the canvas fills its container absolutely; props map onto uniforms and drawables.
	// Click pick (DevLog-020): a press released within 4 px (not an orbit) reports the camera ray through the cursor in
	// the viewer frame (relative to the mesh centre); the owner intersects it with what it drew (post/probe.ts rayHit).
	import { onMount, untrack } from 'svelte';
	import { Vector3, type PerspectiveCamera } from 'three';
	import { Viewer3D, type Drawable } from './viewer3d';
	import { registerCapture } from './capture';
	import type { ColormapName } from './colormaps';

	let {
		surface,
		regionColors = null,
		edges = null,
		edgeDisp = null,
		colormap = 'viridis',
		range,
		logScale = false,
		wire = true,
		showSurface = true,
		deform = 0,
		clip = null,
		cuts = [],
		phase = null,
		animValue = false,
		animAbs = false,
		half,
		fitKey = 0,
		onframe,
		onerror,
		onpick,
		marks = [],
		smooth = true
	}: {
		/** per-fragment P2 on tet10 faces (DevLog-019); false = raw, linear on the face sub-triangles */
		smooth?: boolean;
		/** labelled points (viewer frame, relative to the mesh centre), projected on every frame (not occluded) */
		marks?: Array<{ p: [number, number, number]; label: string; tip: string }>;
		onpick?: (origin: [number, number, number], dir: [number, number, number]) => void;
		surface: Drawable | null;
		regionColors?: string[] | null;
		edges?: Float32Array | null;
		edgeDisp?: Float32Array | null;
		colormap?: ColormapName;
		range: { min: number; max: number };
		logScale?: boolean;
		wire?: boolean;
		showSurface?: boolean;
		deform?: number;
		clip?: { n: [number, number, number]; d: number } | null;
		cuts?: Drawable[];
		phase?: number | null;
		animValue?: boolean;
		/** the drawn value is a magnitude: animate |cos(phase)| */
		animAbs?: boolean;
		half: [number, number, number];
		fitKey?: number;
		onframe?: (ms: number) => void;
		onerror?: (msg: string) => void;
	} = $props();

	let host: HTMLDivElement;
	let canvas: HTMLCanvasElement;
	let v = $state.raw<Viewer3D | null>(null);
	let failed = $state('');
	let fitted = -1;
	let press: { x: number; y: number } | null = null;
	let shown = $state.raw<Array<{ x: number; y: number; label: string; tip: string }>>([]);
	function project() {
		const cam = v ? (v as unknown as { camera?: PerspectiveCamera }).camera : undefined;
		if (!cam || !marks.length) { if (shown.length) shown = []; return; }
		const r = canvas.getBoundingClientRect();
		shown = marks.map((m) => { const q = new Vector3(...m.p).project(cam); return { x: ((q.x + 1) / 2) * r.width, y: ((1 - q.y) / 2) * r.height, label: m.label, tip: m.tip, z: q.z }; })
			.filter((m) => m.z > -1 && m.z < 1);
	}
	$effect(() => { void marks; untrack(project); });
	function pdown(e: PointerEvent) { press = e.button === 0 ? { x: e.clientX, y: e.clientY } : null; }
	function pup(e: PointerEvent) {
		const p0 = press;
		press = null;
		if (!p0 || !onpick || !v || Math.hypot(e.clientX - p0.x, e.clientY - p0.y) >= 4) return;
		// Viewer3D keeps its camera private (W1 file): read it here; cross-lane request for a public ray() in DevLog-020
		const cam = (v as unknown as { camera?: PerspectiveCamera }).camera;
		if (!cam) return;
		const r = canvas.getBoundingClientRect();
		const q = new Vector3(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1, 0.5).unproject(cam);
		const d = q.sub(cam.position).normalize();
		onpick([cam.position.x, cam.position.y, cam.position.z], [d.x, d.y, d.z]);
	}

	onMount(() => {
		try {
			v = new Viewer3D(canvas);
			v.onframe = (ms) => { onframe?.(ms); project(); };
		} catch (e) {
			failed = `3D viewer unavailable: ${(e as Error).message}`;
			onerror?.(failed);
			return;
		}
		const ro = new ResizeObserver(() => {
			const b = host.getBoundingClientRect();
			v?.resize(b.width, b.height, devicePixelRatio || 1);
		});
		ro.observe(host);
		const unreg = registerCapture(() => v?.grab() ?? null);
		return () => {
			unreg();
			ro.disconnect();
			v?.dispose();
			v = null;
		};
	});

	$effect(() => { if (v) v.setSurface(surface ?? { pos: new Float32Array(0), val: new Float32Array(0), disp: null }, regionColors, edges, edgeDisp); });
	$effect(() => { if (v) v.setColormap(colormap); });
	$effect(() => { if (v) v.setSmooth(smooth); });
	$effect(() => { if (v) v.setRange(range.min, range.max, logScale); });
	$effect(() => { if (v) v.showWire(wire); });
	$effect(() => { void surface; if (v) v.showSurface(showSurface); });
	$effect(() => { if (v) v.setDeform(deform); });
	$effect(() => { if (v) { if (clip) v.setClip(true, clip.n, clip.d); else v.setClip(false); } });
	$effect(() => { if (v) v.setCuts(cuts); });
	$effect(() => { if (v) { if (phase === null) v.resetPhase(); else v.setPhase(phase, animValue, animAbs); } });
	// refit on request, and when the model size changes by more than 5 % (a parameter drag), not on every new mesh
	let fittedHalf: [number, number, number] | null = null;
	$effect(() => {
		if (!v) return;
		const moved = !fittedHalf || half.some((x, i) => Math.abs(x - fittedHalf![i]!) > 0.05 * Math.max(...fittedHalf!));
		if (fitted !== fitKey || moved) { fitted = fitKey; fittedHalf = [...half]; v.fit(half); }
	});
</script>

<div class="host" bind:this={host} role="presentation" onpointerdown={pdown} onpointerup={pup}>
	<canvas bind:this={canvas}></canvas>
	{#if shown.length}
		<svg class="ov">
			{#each shown as m}
				{@const x = Math.round(m.x) + 0.5}
				{@const y = Math.round(m.y) + 0.5}
				<g class="mk" data-tip={m.tip}>
					<path d="M{x - 7} {y}H{x - 3}M{x + 3} {y}H{x + 7}M{x} {y - 7}V{y - 3}M{x} {y + 3}V{y + 7}" />
					<rect x={x - 3} y={y - 3} width="6" height="6" />
					<rect class="b" x={x + 9} y={y - 21} width={6.7 * m.label.length + 8} height="17" />
					<text x={x + 13} y={y - 8.5}>{m.label}</text>
				</g>
			{/each}
		</svg>
	{/if}
	{#if failed}<div class="fail">{failed}</div>{/if}
</div>

<style>
	.host { position: absolute; inset: 0; overflow: hidden; touch-action: none; }
	canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
	.ov { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
	.mk { pointer-events: all; shape-rendering: crispEdges; }
	.mk path, .mk rect { fill: none; stroke: #e0a526; stroke-width: 1; }
	.mk rect.b { fill: rgba(13, 13, 13, 0.82); stroke: rgba(224, 165, 38, 0.6); }
	.mk text { fill: #f0c76a; font: 11px var(--mono); shape-rendering: auto; }
	.fail { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: var(--ink-3); }
</style>
