<script lang="ts">
	// SPDX-License-Identifier: GPL-3.0-or-later
	// 3D canvas around Viewer3D: the canvas fills its container absolutely; props map onto uniforms and drawables.
	import { onMount } from 'svelte';
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
		onerror
	}: {
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

	onMount(() => {
		try {
			v = new Viewer3D(canvas);
			v.onframe = (ms) => onframe?.(ms);
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

<div class="host" bind:this={host}>
	<canvas bind:this={canvas}></canvas>
	{#if failed}<div class="fail">{failed}</div>{/if}
</div>

<style>
	.host { position: absolute; inset: 0; overflow: hidden; touch-action: none; }
	canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
	.fail { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: var(--ink-3); }
</style>
