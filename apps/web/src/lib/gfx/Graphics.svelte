<script lang="ts">
	// SPDX-License-Identifier: GPL-3.0-or-later
	// Graphics panel: Geometry / Mesh / Results modes (keys G, M, R; W wireframe, F fit, Space animation), the 2D
	// WebGL2 field renderer or the 3D three.js viewer, colorbar in absolute units, exact hover probe (2D, post worker),
	// slices / isosurfaces / section / deformation / animation (3D). Results that do not exist are shown as unavailable.
	import { onMount, untrack } from 'svelte';
	import type { FieldData } from '@amp/spec/types';
	import type { Session } from '../workbench/session.svelte';
	import { displayScale } from '../workbench/session.svelte';
	import { latticeValues, perElement, refinedDisplay, type Field2D, type Space } from '../post/field2d';
	import { autoDeformScale, bbox3 } from '../post/solid3d';
	import type { Layer2D } from './renderer2d';
	import type { Drawable } from './viewer3d';
	import { COLORMAPS, DIVERGING, type ColormapName } from './colormaps';
	import { domainColors, lengthUnit } from './units';
	import { fmt, fmtMs, niceTicks } from './ticks';
	import Canvas2D, { type Handle } from './Canvas2D.svelte';
	import Colorbar from './Colorbar.svelte';

	export type Mode = 'geometry' | 'mesh' | 'results';
	let {
		s,
		mode = $bindable('mesh'),
		handles = [],
		onhandle,
		compact = false,
		fitKey = 0,
		focus = null,
		highlight = [],
		clipDefault = false
	}: { s: Session; mode?: Mode; handles?: Handle[]; onhandle?: (id: string, x: number, y: number, phase: 'move' | 'end') => void; compact?: boolean; fitKey?: number; focus?: [number, number, number, number] | null; highlight?: string[]; clipDefault?: boolean } = $props();

	let wireUser = $state(false);
	// colour range: full data range, or the 1st-99th percentile (near-singular peaks saturate; the colorbar says so)
	let clipRange = $state(untrack(() => clipDefault));
	const wire = $derived(mode === 'mesh' || wireUser);
	let colormap = $state<ColormapName>('viridis');
	let level = $state(3);
	let contours = $state(false);
	let fieldKey = $state('');
	let comp = $state(-1);
	let step = $state(0);
	let deformUser = $state<number | null>(null);
	let deformOn = $state(true);
	let clipOn = $state(false);
	let clipAxis = $state<0 | 1 | 2>(0);
	let clipFrac = $state(0.5);
	let sliceOn = $state(false);
	let sliceAxis = $state<0 | 1 | 2>(2);
	let sliceFrac = $state(0.5);
	let isoOn = $state(false);
	let isoN = $state(5);
	let playing = $state(false);
	let phase = $state(0);
	let frameMs = $state(0);
	let fit = $state(0);
	let probe = $state<{ x: number; y: number; v: number | null; dom: string } | null>(null);
	let Canvas3D = $state.raw<typeof import('./Canvas3D.svelte').default | null>(null);
	let ext = $state.raw<{ pos: Float32Array; node: Int32Array; cell: Int32Array; edges: Int32Array; c0: [number, number, number] } | null>(null);
	let cuts = $state.raw<Drawable[]>([]);

	const mesh = $derived(s.mesh);
	const m2 = $derived(s.m2);
	const is3d = $derived(!!mesh && mesh.dim === 3);
	const sol = $derived(s.solution && mesh && s.solution.meshHash === mesh.hash ? s.solution : null);
	const domains = $derived(mesh?.entities.domains ?? []);
	// navigation highlight (UI state only): highlighted domains in amber, the others dimmed; boundaries drawn in amber
	const hiSet = $derived(new Set(highlight));
	const regionColors = $derived(hiSet.size ? domains.map((d) => (hiSet.has(d.id) || [...hiSet].some((h) => d.parent?.includes(h)) ? '#e0a526' : '#3a3a37')) : domainColors(domains.length));
	const hiLines = $derived.by(() => {
		if (!mesh || mesh.dim !== 2 || !hiSet.size) return null;
		const bs = mesh.entities.boundaries.map((b) => hiSet.has(b.id) || !!b.parent?.some((x) => hiSet.has(x)));
		if (!bs.some(Boolean)) return null;
		const f = mesh.facets, npf = f.type === 'line3' ? 3 : 2, N = mesh.nodes, seg: number[] = [];
		for (let i = 0; i < f.conn.length / npf; i++) if (bs[f.boundary[i]!]) { const a = f.conn[npf * i]!, b = f.conn[npf * i + 1]!; seg.push(N[2 * a]!, N[2 * a + 1]!, N[2 * b]!, N[2 * b + 1]!); }
		return Float64Array.from(seg);
	});

	// fields: name + step, one entry per (name, step)
	const fieldList = $derived((sol?.fields ?? []).map((f, i) => ({ key: `${f.name}@${f.step ?? 0}`, f, i })));
	const names = $derived([...new Set(fieldList.map((x) => x.f.name))]);
	/** A results[].expr names a field as `<field>` or `<physics id>.<field>`. */
	const exprIs = (expr: string | undefined, name: string | undefined) => !!expr && !!name && (expr === name || expr.endsWith(`.${name}`));
	const resultsSpec = $derived(((s.model.data as { results?: Array<{ expr?: string; unit?: string }> } | null)?.results ?? []));
	const field = $derived.by((): FieldData | null => {
		if (!fieldList.length) return null;
		const name = fieldKey && names.includes(fieldKey) ? fieldKey : (names.find((n) => resultsSpec.some((r) => exprIs(r.expr, n))) ?? names[0]!);
		const steps = fieldList.filter((x) => x.f.name === name);
		return (steps[Math.min(step, steps.length - 1)] ?? steps[0])!.f;
	});
	const nSteps = $derived(field ? fieldList.filter((x) => x.f.name === field.name).length : 0);
	const disp = $derived.by(() => {
		const sc = displayScale(resultsSpec.find((r) => exprIs(r.expr, field?.name))?.unit ?? field?.unit);
		return sc;
	});
	/** spaces the viewer can draw exactly: nodal H1 (P1/P2 basis) and per-cell DG0 */
	const drawable2d = $derived(!!field && (field.space === 'H1P1' || field.space === 'H1P2' || field.space === 'DG0'));
	const lu = $derived(lengthUnit(m2 ? Math.max(m2.bbox[2] - m2.bbox[0], m2.bbox[3] - m2.bbox[1]) : mesh ? bbox3(mesh.nodes).diag : 1));

	/**
	 * 1st and 99th percentile of the drawn values, weighted (2D: element area / lattice points, so refined regions do
	 * not dominate; 3D: per vertex). Strided sample of at most 40000 values.
	 */
	function pct(a: ArrayLike<number>, w: ((i: number) => number) | null = null): { lo: number; hi: number } {
		const st = Math.max(1, Math.floor(a.length / 40000)), x: Array<[number, number]> = [];
		let W = 0;
		for (let i = 0; i < a.length; i += st) if (Number.isFinite(a[i]!)) { const wi = w ? w(i) : 1; x.push([a[i]!, wi]); W += wi; }
		x.sort((p, q) => p[0] - q[0]);
		let acc = 0, lo = x[0]?.[0] ?? 0, hi = x.at(-1)?.[0] ?? 1, gotLo = false;
		for (const [v, wi] of x) {
			acc += wi;
			if (!gotLo && acc >= 0.01 * W) { lo = v; gotLo = true; }
			if (acc >= 0.99 * W) { hi = v; break; }
		}
		return { lo, hi };
	}
	const areas = $derived.by(() => {
		if (!m2) return null;
		const out = new Float64Array(m2.nT), N = m2.nodes, c = m2.conn;
		for (let t = 0; t < m2.nT; t++) {
			const o = m2.npe * t, a = c[o]!, b = c[o + 1]!, d = c[o + 2]!;
			out[t] = 0.5 * Math.abs((N[2 * b]! - N[2 * a]!) * (N[2 * d + 1]! - N[2 * a + 1]!) - (N[2 * d]! - N[2 * a]!) * (N[2 * b + 1]! - N[2 * a + 1]!));
		}
		return out;
	});
	/** A near-constant field gets a symmetric 1 % band so float noise is not stretched over the colormap. */
	function guard(lo: number, hi: number): { min: number; max: number } {
		const m = Math.max(Math.abs(lo), Math.abs(hi));
		if (hi - lo > 1e-6 * m && hi > lo) return { min: lo, max: hi };
		const d = m > 0 ? 0.01 * m : 1;
		return { min: lo - d, max: hi + d };
	}
	const boundaryLines = $derived.by(() => {
		if (!mesh || mesh.dim !== 2 || (mode !== 'geometry' && !compact)) return null;
		const f = mesh.facets, npf = f.type === 'line3' ? 3 : 2, n = f.conn.length / npf, N = mesh.nodes;
		const out = new Float64Array(4 * n);
		for (let i = 0; i < n; i++) { const a = f.conn[npf * i]!, b = f.conn[npf * i + 1]!; out.set([N[2 * a]!, N[2 * a + 1]!, N[2 * b]!, N[2 * b + 1]!], 4 * i); }
		return out;
	});

	// ---------------------------------------------------------------- 2D layers
	const view2d = $derived.by(() => {
		if (!m2) return { layers: [] as Layer2D[], cb: null as null | { min: number; max: number; label: string; unit: string } };
		if (mode === 'geometry') return { layers: [{ kind: 'region', disp: refinedDisplay(m2, 1), regionColors, wire: false } as Layer2D], cb: null };
		if (mode === 'mesh' || !sol) {
			const q = s.quality;
			if (mode === 'results' || !q) return { layers: [{ kind: 'region', disp: refinedDisplay(m2, 1), regionColors, wire: mode === 'mesh' && wire } as Layer2D], cb: null };
			const vals = perElement(q);
			let lo = Infinity, hi = -Infinity;
			for (const v of q) { if (v < lo) lo = v; if (v > hi) hi = v; }
			const rg = guard(lo, hi);
			return { layers: [{ kind: 'surface', disp: refinedDisplay(m2, 1), values: vals, range: rg, colormap, wire } as Layer2D], cb: { ...rg, label: 'element shape quality q = 4 sqrt(3) A / sum(l^2)', unit: '1' } };
		}
		if (!field || !drawable2d) return { layers: [{ kind: 'region', disp: refinedDisplay(m2, 1), regionColors, wire } as Layer2D], cb: null };
		const r = field.space === 'DG0' ? 1 : level;
		const fd: Field2D = { space: field.space as Space, data: field.data, components: field.components };
		const lv = latticeValues(m2, fd, r, field.components > 1 ? comp : 0);
		let lo = Infinity, hi = -Infinity;
		for (let i = 0; i < lv.length; i++) { const v = disp.a * lv[i]! + disp.b; lv[i] = v; if (v < lo) lo = v; if (v > hi) hi = v; }
		if (clipRange) { const np = refinedDisplay(m2, r).np, A = areas; ({ lo, hi } = pct(lv, A ? (i) => A[Math.floor(i / np)]! : null)); }
		const signed = lo < 0 && hi > 0;
		const cm: ColormapName = signed && !DIVERGING.has(colormap) ? 'balance' : colormap;
		const range = signed ? { min: -Math.max(-lo, hi), max: Math.max(-lo, hi) } : guard(lo, hi);
		const d = refinedDisplay(m2, r);
		const layers: Layer2D[] = [{ kind: 'surface', disp: d, values: lv, range, colormap: cm, wire }];
		if (contours) layers.push({ kind: 'contour', disp: d, values: lv, range, colormap: cm, levels: niceTicks(range.min, range.max, 10), uniform: '#f2f1ec' });
		return { layers, cb: { ...range, label: field.name + (field.components > 1 ? (comp < 0 ? ' |.|' : `[${comp}]`) : ''), unit: disp.unit, cm } };
	});

	// ---------------------------------------------------------------- 3D
	$effect(() => {
		if (!is3d || !mesh) { ext = null; return; }
		const m = mesh;
		void s.post.call<'exterior'>({ type: 'exterior' }).then((r) => { if (s.mesh === m) ext = { pos: r.pos, node: r.node, cell: r.cell, edges: r.edges, c0: r.c0 }; });
		if (!Canvas3D) void import('./Canvas3D.svelte').then((mod) => (Canvas3D = mod.default));
	});
	const half = $derived.by((): [number, number, number] => {
		if (!mesh || mesh.dim !== 3) return [1, 1, 1];
		const b = bbox3(mesh.nodes);
		return [(b.hi[0] - b.lo[0]) / 2, (b.hi[1] - b.lo[1]) / 2, (b.hi[2] - b.lo[2]) / 2];
	});
	const nodal3 = $derived(is3d && sol && field && (field.space === 'H1P1' || field.space === 'H1P2') ? field : null);
	const dispField = $derived(is3d && sol ? (sol.fields.find((f) => f.components === 3 && f.unit === 'm' && (f.space === 'H1P1' || f.space === 'H1P2') && (f.step ?? 0) === (field?.step ?? 0)) ?? null) : null);
	const autoScale = $derived(dispField && mesh ? autoDeformScale(bbox3(mesh.nodes).diag, dispField.data) : 0);
	const deform = $derived(dispField && deformOn ? (deformUser ?? autoScale) : 0);
	const eigen = $derived(sol?.steps?.kind === 'eigen');
	const scalarAt = (f: FieldData, n: number) => {
		if (f.components === 1) return f.data[n]!;
		if (comp >= 0) return f.data[f.components * n + comp]!;
		let q = 0;
		for (let k = 0; k < f.components; k++) q += f.data[f.components * n + k]! ** 2;
		return Math.sqrt(q);
	};
	const view3d = $derived.by(() => {
		if (!ext || !mesh) return null;
		const nv = ext.node.length;
		const val = new Float32Array(nv);
		let cb: { min: number; max: number; label: string; unit: string } | null = null;
		let region = false;
		if (mode === 'geometry' || (mode === 'results' && !(sol && field && drawable2d))) {
			for (let i = 0; i < nv; i++) val[i] = mesh.cells.domain[ext.cell[i]!]!;
			region = true;
		} else if (mode === 'mesh') {
			const q = s.quality!;
			let lo = Infinity, hi = -Infinity;
			for (let i = 0; i < nv; i++) { const v = q[ext.cell[i]!]!; val[i] = v; if (v < lo) lo = v; if (v > hi) hi = v; }
			cb = { min: lo, max: hi, label: 'cell quality: min mean ratio over the tet split (1 = regular tet)', unit: '1' };
		} else if (field && drawable2d) {
			let lo = Infinity, hi = -Infinity;
			for (let i = 0; i < nv; i++) {
				const vv = disp.a * (field.space === 'DG0' ? scalarAt(field, ext.cell[i]!) : scalarAt(field, ext.node[i]!)) + disp.b;
				val[i] = vv; if (vv < lo) lo = vv; if (vv > hi) hi = vv;
			}
			if (clipRange) ({ lo, hi } = pct(val));
			cb = { min: lo, max: hi, label: field.name, unit: disp.unit };
		}
		let dv: Float32Array | null = null, ed: Float32Array | null = null;
		if (dispField) {
			dv = new Float32Array(3 * nv);
			for (let i = 0; i < nv; i++) for (let k = 0; k < 3; k++) dv[3 * i + k] = dispField.data[3 * ext.node[i]! + k]!;
		}
		const E = ext.edges, N = mesh.nodes, c0 = ext.c0;
		const edges = new Float32Array(3 * E.length);
		for (let i = 0; i < E.length; i++) for (let k = 0; k < 3; k++) edges[3 * i + k] = N[3 * E[i]! + k]! - c0[k]!;
		if (dispField) {
			ed = new Float32Array(3 * E.length);
			for (let i = 0; i < E.length; i++) for (let k = 0; k < 3; k++) ed[3 * i + k] = dispField.data[3 * E[i]! + k]!;
		}
		const signed = !!cb && cb.min < 0 && cb.max > 0;
		const range = region ? { min: 0, max: Math.max(1, domains.length - 1) } : cb ? (signed ? { min: -Math.max(-cb.min, cb.max), max: Math.max(-cb.min, cb.max) } : guard(cb.min, cb.max)) : { min: 0, max: 1 };
		return { surface: { pos: ext.pos, val, disp: dv } as Drawable, region, cb: cb ? { ...cb, ...range } : null, range, edges, ed, signed };
	});
	const cm3 = $derived<ColormapName>(view3d?.signed && !DIVERGING.has(colormap) ? 'balance' : colormap);
	const clip3 = $derived.by(() => {
		if (!clipOn || !mesh || !is3d) return null;
		const b = bbox3(mesh.nodes);
		const n: [number, number, number] = [0, 0, 0];
		n[clipAxis] = 1;
		return { n, d: b.lo[clipAxis]! + clipFrac * (b.hi[clipAxis]! - b.lo[clipAxis]!) - b.c[clipAxis]! };
	});
	// slices and isosurfaces of nodal fields (post worker); displacement carried for deformed display
	$effect(() => {
		const f = nodal3, m = mesh;
		if (!f || !m || (!sliceOn && !isoOn) || mode !== 'results') { cuts = []; return; }
		const nn = m.nodes.length / 3;
		const nodal = new Float64Array(nn);
		for (let i = 0; i < nn; i++) nodal[i] = disp.a * scalarAt(f, i) + disp.b;
		const dsp = dispField ? Float64Array.from(dispField.data) : null;
		const b = bbox3(m.nodes);
		const jobs: Promise<Drawable>[] = [];
		if (sliceOn) {
			const n: [number, number, number] = [0, 0, 0];
			n[sliceAxis] = 1;
			jobs.push(s.post.call<'cut'>({ type: 'slice', normal: n, d: b.lo[sliceAxis]! + sliceFrac * (b.hi[sliceAxis]! - b.lo[sliceAxis]!), nodal, disp: dsp }).then((r) => ({ pos: r.pos, val: r.val, disp: r.disp })));
		}
		if (isoOn && view3d?.cb) {
			const { min, max } = view3d.cb;
			const levels = Array.from({ length: isoN }, (_, i) => min + ((i + 1) * (max - min)) / (isoN + 1));
			jobs.push(s.post.call<'cut'>({ type: 'iso', nodal, levels, disp: dsp }).then((r) => ({ pos: r.pos, val: r.val, disp: r.disp })));
		}
		void Promise.all(jobs).then((d) => { if (s.mesh === m) cuts = d; });
	});

	let solSeen: unknown = null;
	$effect(() => {
		if (sol && sol !== solSeen) {
			solSeen = sol;
			const v = sol.steps?.kind === 'eigen' ? sol.steps.values : null;
			const first = v ? v.findIndex((x) => x > 0) : 0;
			step = first > 0 ? first : 0;
		}
	});

	// animation: eigen phase (cos) or time steps, render on demand only while playing
	onMount(() => {
		let raf = 0, last = performance.now();
		const tick = (t: number) => {
			raf = requestAnimationFrame(tick);
			if (!playing) { last = t; return; }
			const dt = (t - last) / 1000;
			last = t;
			if (eigen || nSteps <= 1) phase = (phase + dt * 2 * Math.PI * 0.5) % (2 * Math.PI);
			else if (dt > 0) step = (step + 1) % nSteps;
		};
		raf = requestAnimationFrame(tick);
		const key = (e: KeyboardEvent) => {
			const t = e.target as HTMLElement | null;
			if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
			if (e.metaKey || e.ctrlKey || e.altKey) return;
			const k = e.key.toLowerCase();
			if (k === 'g') mode = 'geometry';
			else if (k === 'm') mode = 'mesh';
			else if (k === 'r') mode = 'results';
			else if (k === 'w') wireUser = !wireUser;
			else if (k === 'f') fit++;
			else if (k === ' ' && (eigen || nSteps > 1)) { e.preventDefault(); playing = !playing; }
			else return;
		};
		window.addEventListener('keydown', key);
		return () => { cancelAnimationFrame(raf); window.removeEventListener('keydown', key); };
	});

	function hover(p: { x: number; y: number } | null) {
		if (!p) { probe = null; return; }
		s.post.probe(p.x, p.y, (h) => {
			probe = h.hit ? { x: h.x, y: h.y, v: h.hit.value === null ? null : disp.a * h.hit.value + disp.b, dom: domains[h.hit.domain]?.id ?? String(h.hit.domain) } : null;
		});
	}
	// the post worker evaluates the same field the renderer draws
	$effect(() => {
		if (!m2) return;
		if (mode === 'results' && field && drawable2d) s.post.setField({ space: field.space as Space, data: field.data, components: field.components, comp: field.components > 1 ? comp : 0 });
		else s.post.setField(null);
	});

	const unavailable = $derived(mode === 'results' && !sol);
	const modeTip: Record<Mode, string> = { geometry: 'Geometry: domains by colour (G)', mesh: 'Mesh: element quality and wireframe (M)', results: 'Results: solution fields (R)' };
</script>

<div class="gfx">
	{#if m2}
		<Canvas2D layers={view2d.layers} bbox={focus ?? m2.bbox} fitKey={fitKey + fit} {handles} {onhandle} onhover={hover} onframe={(ms) => (frameMs = ms)} lines={boundaryLines} hiLines={hiLines} />
	{:else if is3d && Canvas3D && view3d}
		<Canvas3D surface={view3d.surface} regionColors={view3d.region ? regionColors : null} edges={view3d.edges} edgeDisp={view3d.ed} colormap={cm3} range={view3d.range} {wire}
			showSurface={!(sliceOn || isoOn) || clipOn || mode !== 'results'} deform={deform} clip={clip3} {cuts} phase={eigen && playing ? phase : null} animValue={eigen} {half} fitKey={fitKey + fit} onframe={(ms) => (frameMs = ms)} />
	{:else}
		<div class="empty dim">{s.status === 'meshing' ? 'Meshing...' : s.status === 'error' ? 'No mesh: see Messages' : 'No mesh yet'}</div>
	{/if}

	<div class="top">
		<div class="modes" role="tablist">
			{#each ['geometry', 'mesh', 'results'] as const as k}
				<button role="tab" aria-selected={mode === k} class:on={mode === k} data-tip={modeTip[k]} onclick={() => (mode = k)}>{k[0]!.toUpperCase() + k.slice(1)}</button>
			{/each}
		</div>
		{#if !compact}
			<button class:on={wire} data-tip="Wireframe (W)" onclick={() => (wireUser = !wireUser)} disabled={mode === 'mesh'}>Wire</button>
			<button data-tip="Zoom extents (F)" onclick={() => fit++}>Fit</button>
			<select bind:value={colormap} data-tip="Colormap (perceptual; signed fields switch to the diverging balance map)">
				{#each COLORMAPS as c}<option value={c}>{c}</option>{/each}
			</select>
		{/if}
		{#if mode === 'results' && sol}
			{#if names.length > 1}<select value={field?.name} onchange={(e) => (fieldKey = (e.currentTarget as HTMLSelectElement).value)} data-tip="Field">{#each names as n}<option value={n}>{n}</option>{/each}</select>{/if}
			{#if field && field.components > 1}
				<select bind:value={comp} data-tip="Component">
					<option value={-1}>|.|</option>
					{#each Array.from({ length: field.components }, (_, i) => i) as i}<option value={i}>{i}</option>{/each}
				</select>
			{/if}
			{#if nSteps > 1}
				<select bind:value={step} data-tip={sol.steps ? `${sol.steps.kind} step` : 'step'}>
					{#each Array.from({ length: nSteps }, (_, i) => i) as i}<option value={i}>{sol.steps ? `${fmt(sol.steps.values[i] ?? i)} ${sol.steps.unit}` : i}</option>{/each}
				</select>
			{/if}
			<button class:on={clipRange} data-tip="Colour range: 1st-99th percentile of the drawn values (on) or the full data range (off); values outside saturate" onclick={() => (clipRange = !clipRange)}>p1-99</button>
			{#if eigen || nSteps > 1}<button class:on={playing} data-tip={eigen ? 'Animate the mode phase (Space)' : 'Play the steps (Space)'} onclick={() => (playing = !playing)}>{playing ? 'Pause' : 'Play'}</button>{/if}
			{#if m2 && !compact}
				<button class:on={contours} data-tip="Contour lines at nice levels" onclick={() => (contours = !contours)}>Contours</button>
				<select bind:value={level} data-tip="Smoothing: refined lattice level r (r^2 sub-triangles per element, exact FE values at the lattice points)">
					{#each [1, 2, 3, 4, 6] as l}<option value={l}>r {l}</option>{/each}
				</select>
			{/if}
		{/if}
		{#if is3d && !compact}
			<button class:on={clipOn} data-tip="Section: cut away the half space beyond the plane" onclick={() => (clipOn = !clipOn)}>Section</button>
			{#if clipOn}
				<select bind:value={clipAxis}>{#each ['x', 'y', 'z'] as a, i}<option value={i}>{a}</option>{/each}</select>
				<input type="range" min="0" max="1" step="0.005" bind:value={clipFrac} data-tip="Section position (fraction of the bounding box)" />
			{/if}
			{#if mode === 'results' && nodal3}
				<button class:on={sliceOn} data-tip="Slice plane of the field" onclick={() => (sliceOn = !sliceOn)}>Slice</button>
				{#if sliceOn}
					<select bind:value={sliceAxis}>{#each ['x', 'y', 'z'] as a, i}<option value={i}>{a}</option>{/each}</select>
					<input type="range" min="0" max="1" step="0.005" bind:value={sliceFrac} />
				{/if}
				<button class:on={isoOn} data-tip="Isosurfaces at evenly spaced levels inside the colour range" onclick={() => (isoOn = !isoOn)}>Iso</button>
				{#if isoOn}<input class="n" type="number" min="1" max="12" bind:value={isoN} data-tip="Number of isosurfaces" />{/if}
			{/if}
			{#if dispField}
				<button class:on={deformOn} data-tip="Deformation p + s u" onclick={() => (deformOn = !deformOn)}>Deform</button>
				<input class="n" type="number" value={fmt(deform, 3)} data-tip={`deformation scale s; auto = 10 % of the bounding-box diagonal over max |u| = ${fmt(autoScale)}`} onchange={(e) => { const v = Number((e.currentTarget as HTMLInputElement).value); deformUser = Number.isFinite(v) && v >= 0 ? v : null; }} />
				{#if deformUser !== null}<button data-tip="Back to the automatic scale" onclick={() => (deformUser = null)}>auto</button>{/if}
			{/if}
		{/if}
	</div>

	{#if unavailable}
		<div class="unav">
			<div class="na">Results unavailable</div>
			{#if s.status === 'unavailable'}{#each s.reasons as r}<div class="dim">{r}</div>{/each}
			{:else if s.status === 'solving'}<div class="dim">computing...</div>
			{:else}<div class="dim">not computed: Compute runs the registered physics module</div>{/if}
		</div>
	{:else if mode === 'results' && sol && field && !drawable2d}
		<div class="unav"><div class="na">Field {field.name} ({field.space}): no display yet</div><div class="dim">the viewer draws nodal (H1) and per-cell (DG0) fields; {field.space} needs an H1 projection from @amp/physics or Nedelec evaluation in @amp/post (DevLog-011 s.5)</div></div>
	{/if}

	{#if m2 ? view2d.cb : view3d?.cb}
		{@const cb = (m2 ? view2d.cb : view3d?.cb)!}
		<Colorbar colormap={m2 ? ((cb as { cm?: ColormapName }).cm ?? colormap) : cm3} min={cb.min} max={cb.max} label={cb.label} unit={cb.unit} clipped={clipRange && mode === 'results'} />
	{/if}

	<div class="foot mono">
		{#if probe}
			<span data-tip="exact evaluation of the FE field at the cursor (post worker)">x {fmt(probe.x * lu.f)} {lu.unit}, y {fmt(probe.y * lu.f)} {lu.unit}</span>
			<span>{probe.dom}</span>
			{#if probe.v !== null}<span>{field?.name ?? ''} = {fmt(probe.v)} {disp.unit}</span>{/if}
		{/if}
		<span class="sp"></span>
		{#if s.meshInfo}<span data-tip={`mesher: ${s.meshInfo.source}; parse ${fmtMs(s.meshInfo.ms.parse)}, geometry ${fmtMs(s.meshInfo.ms.geometry)}, mesh ${fmtMs(s.meshInfo.ms.mesh)}; min quality ${fmt(s.meshInfo.qmin)}, mean ${fmt(s.meshInfo.qmean)}`}>{s.meshInfo.cells} {s.meshInfo.type}, {s.meshInfo.nodes} nodes</span>{/if}
		{#if s.staleMesh}<span class="warn">mesh stale</span>{/if}
		{#if s.staleSolution}<span class="warn">solution stale</span>{/if}
		<span data-tip="last frame draw time (CPU side)">{fmtMs(frameMs)}</span>
	</div>
</div>

<style>
	.gfx { position: absolute; inset: 0; background: #0d0d0d; overflow: hidden; user-select: none; -webkit-user-select: none; }
	.empty { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; }
	.top { position: absolute; left: 6px; top: 6px; right: 80px; display: flex; flex-wrap: wrap; gap: 3px; align-items: center; pointer-events: none; }
	.top > * { pointer-events: auto; }
	.modes { display: flex; }
	.modes button + button { border-left: 0; }
	.n { width: 56px; }
	.unav { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); background: rgba(13, 13, 13, 0.85); border: 1px solid var(--border); padding: 8px 12px; max-width: 70%; font-size: 11px; display: flex; flex-direction: column; gap: 2px; }
	.unav .na { font-size: 12px; }
	.foot { position: absolute; left: 6px; right: 6px; bottom: 4px; display: flex; gap: 12px; font-size: 11px; color: var(--ink-2); pointer-events: none; white-space: nowrap; overflow: hidden; }
	.foot > span:not(.sp) { pointer-events: auto; background: rgba(13, 13, 13, 0.75); padding: 0 3px; }
	.sp { flex: 1; }
</style>
