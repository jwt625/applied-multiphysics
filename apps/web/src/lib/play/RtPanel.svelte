<script lang="ts">
	// SPDX-License-Identifier: GPL-3.0-or-later
	// Real-time GPU panel (/play/rt/<kernel>): embeds an @amp/rt kernel (C9 + L6 optional members) and its WebGPU field
	// renderer. Paint on the canvas, sliders with exact fields, presets, colorbar in the kernel's units, fidelity badge.
	// Without WebGPU the panel says so and shows the platform probe; nothing is simulated in its place.
	import { onMount, untrack } from 'svelte';
	import type { RealtimeKernelExt, ViewSpec } from '@amp/rt';
	import { RT_DEFS, RT_KERNELS, type RtKernelId } from './rt-kernels';
	import { fmt } from '../gfx/ticks';
	import { cssGradient } from '../gfx/colormaps';
	import Tip from '../ui/Tip.svelte';

	let { kernel }: { kernel: string } = $props();
	// the kernel is fixed for the life of the panel (links between kernels reload the page)
	const id = untrack(() => ((RT_KERNELS as readonly string[]).includes(kernel) ? (kernel as RtKernelId) : 'lbm-d2q9'));
	const def = RT_DEFS[id];
	let P = $state<Record<string, number>>(Object.fromEntries(def.params.map((p) => [p.id, p.value])));
	let rt: typeof import('@amp/rt') | null = null;
	let device: GPUDevice | null = null;
	let renderer: InstanceType<typeof import('@amp/rt').FieldRenderer> | null = null;
	let k = $state.raw<RealtimeKernelExt | null>(null);
	let views = $state.raw<ViewSpec[]>([]);
	let viewId = $state(def.view);
	let lo = $state(0);
	let hi = $state(1);
	let auto = $state(def.autoRange);
	let running = $state(true);
	let tool = $state(def.tools[0]![0]);
	let unavailable = $state('');
	let probe = $state('');
	let stats = $state({ fps: 0, sps: 0 });
	let hover = $state('');
	let canvas = $state<HTMLCanvasElement>();
	let box = $state<HTMLDivElement>();
	let presets = $state.raw<Array<[string, Record<string, number>, string]>>(def.presets);
	let dirty = true;

	const spec = $derived(views.find((v) => v.id === viewId) ?? null);

	async function rebuild() {
		if (!rt || !device || !renderer) return;
		k?.dispose();
		const kk = await def.make(device, P, rt);
		renderer.bind(kk.view().buffer!, kk.overlay(), kk.grid.nx, kk.grid.ny, def.style);
		views = kk.views();
		kk.setView(viewId);
		const v = kk.view();
		lo = v.range[0];
		hi = v.range[1];
		k = kk;
		layout();
	}

	function layout() {
		if (!k || !canvas || !box) return;
		const { nx, ny } = k.grid;
		// the colorbar column (84 px) is outside the field area
		const W = box.clientWidth - 84 - 16, H = box.clientHeight - 40;
		const s = Math.min(W / nx, H / ny);
		const cw = Math.max(64, Math.floor(nx * s)), ch = Math.max(64, Math.floor(ny * s));
		canvas.style.width = `${cw}px`;
		canvas.style.height = `${ch}px`;
		const dpr = Math.min(2, devicePixelRatio || 1);
		canvas.width = Math.round(cw * dpr);
		canvas.height = Math.round(ch * dpr);
		dirty = true;
	}

	async function autoRange() {
		if (!k || !auto) return;
		const kk = k;
		const v = await kk.readback('view');
		if (kk !== k) return;
		const stride = Math.max(1, Math.floor(v.length / 20000));
		const a: number[] = [];
		for (let i = 0; i < v.length; i += stride) { if (!Number.isFinite(v[i]!)) { running = false; unavailable = 'diverged (non-finite values): lower Re or u_max, or raise D, then Reset'; return; } a.push(Math.abs(v[i]!)); }
		a.sort((x, y) => x - y);
		const m = a[Math.floor(0.99 * (a.length - 1))] ?? 0;
		if (m > 0) { if (spec?.map === 'balance') { lo = -m; hi = m; } else { lo = 0; hi = m; } }
	}

	onMount(() => {
		let raf = 0, alive = true;
		void (async () => {
			const gpu = (navigator as Navigator & { gpu?: GPU }).gpu;
			rt = await import('@amp/rt');
			const pr = await rt.probePlatform(gpu).catch(() => null);
			probe = pr ? JSON.stringify(pr.probe) : '';
			if (!gpu || !pr?.adapter) { unavailable = 'WebGPU is not available in this browser (no adapter): the real-time kernels need it'; return; }
			device = await pr.adapter.requestDevice({ requiredLimits: { maxStorageBufferBindingSize: pr.adapter.limits.maxStorageBufferBindingSize, maxBufferSize: pr.adapter.limits.maxBufferSize } });
			device.lost.then((i: GPUDeviceLostInfo) => { unavailable = `GPU device lost: ${i.message}`; });
			if (!alive || !canvas) return;
			renderer = new rt.FieldRenderer(device, canvas);
			if (id === 'gray-scott') presets = Object.entries(rt.WELL_FK).map(([n, [f, kk]]) => [n, { f, k: kk }, `The Well set: f ${f}, k ${kk}`]);
			await rebuild();
			let frame = 0, tw = performance.now(), fw = 0, sw = 0;
			const tick = () => {
				raf = requestAnimationFrame(tick);
				if (!k || !renderer) return;
				if (running) { const n = Math.max(1, Math.round(P.spf ?? 1)); k.step(n); sw += n; dirty = true; if (frame % 15 === 0) void autoRange(); }
				if (dirty) { renderer.lo = lo; renderer.hi = hi; k.view(); renderer.draw(); dirty = false; fw++; }
				frame++;
				const now = performance.now();
				if (now - tw > 500) { stats = { fps: (fw * 1000) / (now - tw), sps: (sw * 1000) / (now - tw) }; tw = now; fw = 0; sw = 0; }
			};
			raf = requestAnimationFrame(tick);
		})().catch((e) => (unavailable = (e as Error).message));
		const ro = new ResizeObserver(() => layout());
		if (box) ro.observe(box);
		return () => { alive = false; cancelAnimationFrame(raf); ro.disconnect(); k?.dispose(); device?.destroy(); };
	});

	$effect(() => { void lo; void hi; dirty = true; });
	$effect(() => { if (k && spec && renderer) { k.setView(viewId); renderer.setColormap(spec.map); dirty = true; } });

	let reinit = 0;
	function setP(p: (typeof def.params)[number], v: number, drag = false) {
		P[p.id] = v;
		if (p.id === 'spf' || !k) return;
		if (p.reinit) { if (drag) return; clearTimeout(reinit); reinit = window.setTimeout(() => void rebuild(), 50); return; }
		try { def.live(k, P); } catch (e) { unavailable = (e as Error).message; }
		dirty = true;
	}

	function cell(e: PointerEvent): [number, number] {
		const r = canvas!.getBoundingClientRect();
		return [((e.clientX - r.left) / r.width) * k!.grid.nx - 0.5, (1 - (e.clientY - r.top) / r.height) * k!.grid.ny - 0.5];
	}
	let drag: [number, number] | null = null;
	function paint(a: [number, number], b: [number, number]) {
		if (!k) return;
		k.paint({ tool: def.paintTool(tool), shape: 'line', x0: a[0], y0: a[1], x1: b[0], y1: b[1], r: 4, value: tool === 'dielectric' ? 4 : 1 });
		dirty = true;
	}
	let hb: GPUBuffer | null = null, hbusy = false;
	function hoverAt(e: PointerEvent) {
		if (!k || !device || hbusy) return;
		const [fi, fj] = cell(e), i = Math.round(fi), j = Math.round(fj);
		if (i < 0 || j < 0 || i >= k.grid.nx || j >= k.grid.ny) return;
		hbusy = true;
		hb ??= device.createBuffer({ size: 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
		const enc = device.createCommandEncoder();
		enc.copyBufferToBuffer(k.view().buffer!, (j * k.grid.nx + i) * 4, hb, 0, 4);
		device.queue.submit([enc.finish()]);
		const [x, y, u] = def.phys(k, i, j);
		const b = hb;
		b.mapAsync(GPUMapMode.READ).then(() => { const v = new Float32Array(b.getMappedRange())[0]!; b.unmap(); hover = `x ${fmt(x)} ${u}, y ${fmt(y)} ${u}, ${spec?.label ?? ''} ${fmt(v)} ${spec?.unit ?? ''}`; hbusy = false; }, () => (hbusy = false));
	}
</script>

<Tip />
<div class="rt">
	<header>
		<a href="/" class="dim" data-tip="Workbench">applied-multiphysics</a>
		<span class="t">{def.title}</span>
		<span class="badge" data-tip={def.caveat}>realtime fidelity</span>
		<span class="sp"></span>
		{#each RT_KERNELS as kid}<a class="btn" class:on={kid === id} href="/play/rt/{kid}" data-sveltekit-reload>{kid}</a>{/each}
	</header>
	<div class="cv" bind:this={box}>
		<canvas bind:this={canvas} class:hide={!!unavailable && !k}
			onpointerdown={(e) => { if (!k) return; (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); drag = cell(e); paint(drag, drag); }}
			onpointermove={(e) => { hoverAt(e); if (drag) { const c = cell(e); paint(drag, c); drag = c; } }}
			onpointerup={() => (drag = null)}></canvas>
		{#if unavailable}<div class="unav"><div class="na">{unavailable}</div>{#if probe}<div class="dim mono">{probe}</div>{/if}</div>{/if}
		{#if spec}
			<div class="cb"><span class="mono">{spec.unit}</span><div class="bar" style="background: {cssGradient(spec.map)}"></div><span class="mono hi">{fmt(hi)}</span><span class="mono lo">{fmt(lo)}</span></div>
		{/if}
		<div class="foot mono"><span>{hover}</span><span class="sp"></span>{#if k}<span>{stats.fps.toFixed(0)} fps, {fmt(stats.sps)} steps/s, {k.grid.nx} x {k.grid.ny}</span>{/if}</div>
	</div>
	<aside>
		<div class="row"><button class:on={running} onclick={() => (running = !running)}>{running ? 'Pause' : 'Run'}</button><button onclick={() => void rebuild()} data-tip="Re-initialise the kernel">Reset</button></div>
		<div class="h">view</div>
		<select bind:value={viewId}>{#each views as v}<option value={v.id}>{v.label} [{v.unit}]</option>{/each}</select>
		<div class="row"><label data-tip="Colour range from the 99th percentile of |value|"><input type="checkbox" bind:checked={auto} /> auto range</label></div>
		<div class="h">parameters</div>
		{#each def.params as p}
			<div class="pr">
				<span class="mono" data-tip={p.tip}>{p.label}</span>
				<input type="range" min={p.min} max={p.max} step={p.step} value={P[p.id]} data-tip={p.tip} oninput={(e) => setP(p, Number((e.currentTarget as HTMLInputElement).value), true)} onchange={(e) => setP(p, Number((e.currentTarget as HTMLInputElement).value))} />
				<input class="mono" type="number" min={p.min} max={p.max} step={p.step} value={P[p.id]} onchange={(e) => setP(p, Number((e.currentTarget as HTMLInputElement).value))} />
				<span class="dim mono u">{p.unit === '1' ? '' : p.unit}</span>
			</div>
		{/each}
		<div class="h">draw</div>
		<div class="row">{#each def.tools as [t, l, tip]}<button class:on={tool === t} data-tip={tip} onclick={() => (tool = t)}>{l}</button>{/each}</div>
		{#if presets.length}
			<div class="h">presets</div>
			<div class="row wrap">{#each presets as [n, pp, tip]}<button data-tip={tip} onclick={() => { Object.assign(P, pp); void rebuild(); }}>{n}</button>{/each}</div>
		{/if}
		<div class="h">fidelity</div>
		<div class="dim cav">{def.caveat}</div>
	</aside>
</div>

<style>
	.rt { height: 100%; display: grid; grid-template-columns: minmax(0, 1fr) 300px; grid-template-rows: 34px minmax(0, 1fr); background: var(--bg); }
	header { grid-column: 1 / 3; display: flex; align-items: center; gap: 8px; padding: 0 10px; border-bottom: 1px solid var(--line); background: var(--surface); min-width: 0; overflow: hidden; white-space: nowrap; }
	.t { font-weight: 600; }
	.badge { border: 1px solid var(--warn); color: var(--warn); font-size: 10px; padding: 0 4px; }
	.sp { flex: 1; }
	.btn { display: inline-flex; align-items: center; height: 22px; padding: 0 8px; border: 1px solid var(--border); color: var(--ink-2); font-size: 11px; }
	.btn.on { border-color: var(--accent); color: var(--ink); }
	.cv { position: relative; min-height: 0; min-width: 0; display: flex; align-items: center; justify-content: center; padding-right: 84px; background: #0d0d0d; overflow: hidden; }
	canvas { display: block; touch-action: none; cursor: crosshair; }
	.hide { visibility: hidden; }
	.unav { position: absolute; inset: 0; display: flex; flex-direction: column; gap: 6px; align-items: center; justify-content: center; padding: 20px; text-align: center; font-size: 11px; overflow-wrap: anywhere; }
	.cb { position: absolute; right: 8px; top: 30px; bottom: 34px; width: 50px; display: flex; flex-direction: column; font-size: 10px; color: var(--ink-2); }
	.cb .bar { flex: 1; width: 12px; border: 1px solid var(--border); margin: 3px 0; }
	.cb .hi { position: absolute; left: 16px; top: 16px; }
	.cb .lo { position: absolute; left: 16px; bottom: 0; }
	.foot { position: absolute; left: 6px; right: 6px; bottom: 4px; display: flex; font-size: 11px; color: var(--ink-2); white-space: nowrap; overflow: hidden; }
	aside { background: var(--surface); border-left: 1px solid var(--line); padding: 8px; display: flex; flex-direction: column; gap: 4px; overflow: auto; min-height: 0; }
	.h { margin-top: 6px; font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--ink-3); }
	.row { display: flex; gap: 4px; align-items: center; }
	.wrap { flex-wrap: wrap; }
	.pr { display: grid; grid-template-columns: 84px minmax(0, 1fr) 60px 40px; gap: 4px; align-items: center; }
	.pr input[type='number'] { width: 60px; }
	.pr > span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.u { font-size: 10px; }
	.cav { font-size: 11px; }
	@media (max-width: 760px) {
		.rt { grid-template-columns: minmax(0, 1fr); grid-template-rows: 34px minmax(0, 1fr) 240px; }
		header { grid-column: 1; }
		header .btn { display: none; }
		aside { border-left: 0; border-top: 1px solid var(--line); }
	}
</style>
