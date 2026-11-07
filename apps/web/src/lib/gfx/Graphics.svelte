<script lang="ts">
	// SPDX-License-Identifier: GPL-3.0-or-later
	// Graphics panel: Geometry / Mesh / Results modes (keys G, M, R; W wireframe, F fit, Space animation), the 2D
	// WebGL2 field renderer or the 3D three.js viewer, colorbar in absolute units, exact hover probe (post worker),
	// slices / isosurfaces / section / deformation / animation (3D).
	// Honesty rules (audit B1, S1, S4, S8): a result is drawn only for the mesh it was computed on; a result whose spec
	// hash differs from the model's is drawn desaturated with a "stale" badge; a coarse drag result is badged; a pending
	// run is "computing", not "unavailable"; eigenmodes are drawn normalized (max |.| = 1, no unit: their amplitude is
	// arbitrary); only fields the viewer can draw exactly (H1P1, H1P2, DG0) get field controls.
	// Colour range rule (audit S5), stated in the colorbar tooltip: "full" = min..max, "robust" = area-weighted 1st-99th
	// percentile; both over the focus box when the view has one (Play), else over the whole mesh. A field is drawn with
	// the diverging map, symmetric about zero, when both signs carry at least 5 % of the range; else sequentially.
	// Heavy per-element work (refined lattice, values, ranges, element quality) runs in the workers (audit S6).
	import { onMount, untrack } from 'svelte';
	import type { FieldData } from '@amp/spec/types';
	import type { Session } from '../workbench/session.svelte';
	import { displayScale } from '../workbench/session.svelte';
	import { perElement, type RefinedDisplay, type Space } from '../post/field2d';
	import type { LatticeOut, RangeRule } from '../post/post.worker';
	import { autoDeformScale, bbox3 } from '../post/solid3d';
	import { revolveSurface, revolvedValues } from '../post/revolve';
	import { headlines } from '../post/headline';
	import type { Layer2D, ScaleMode } from './renderer2d';
	import type { Drawable } from './viewer3d';
	import { COLORMAPS, type ColormapName } from './colormaps';
	import { domainColors, lengthUnit, unitLabel } from './units';
	import { fmt, fmtMs, niceTicks } from './ticks';
	import Canvas2D, { type Handle } from './Canvas2D.svelte';
	import Colorbar from './Colorbar.svelte';

	export type Mode = 'geometry' | 'mesh' | 'results';
	let {
		s,
		mode = $bindable('mesh'),
		step = $bindable(0),
		playing = $bindable(false),
		handles = [],
		onhandle,
		compact = false,
		fitKey = 0,
		focus = null,
		highlight = [],
		rangeDefault = 'full',
		contoursDefault = false,
		fieldLinesDefault = false,
		autoAnimate = false,
		revolve = false,
		mirror = null,
		band = null,
		padTop = 0
	}: {
		/** px kept free above the field on phones (Play headline overlay) */
		padTop?: number;
		/** contour pair at a probe value times (1 -/+ rel), e.g. the 1 % uniformity region of a coil (play/heroes.ts BAND) */
		band?: { probe: string; field: string; rel: number; tip: string } | null;
		/** symmetry mirroring of a 2D view (play/heroes.ts MIRROR): planes and field parity; display only */
		mirror?: { planes: { x: boolean; y: boolean }; tip: string; parity(field: string, comp: number): [number, number] | null } | null;
		s: Session; mode?: Mode; step?: number; playing?: boolean; handles?: Handle[];
		onhandle?: (id: string, x: number, y: number, phase: 'move' | 'end') => void; compact?: boolean; fitKey?: number;
		focus?: [number, number, number, number] | null; highlight?: string[]; rangeDefault?: RangeRule; contoursDefault?: boolean;
		fieldLinesDefault?: boolean; autoAnimate?: boolean;
		/** axisymmetric electromagnetic modes: results drawn on the surface of revolution (post/revolve.ts) */
		revolve?: boolean;
	} = $props();

	let wireUser = $state(false);
	/** camera: region of interest (focus) or the whole model */
	let frameAll = $state(false);
	let mirrorOn = $state(true);
	let rule = $state<RangeRule>(untrack(() => rangeDefault));
	let scaleUser = $state<ScaleMode>('linear');
	let cmUser = $state<'auto' | ColormapName>('auto');
	let level = $state(3);
	let contours = $state(untrack(() => contoursDefault));
	let fieldLines = $state(untrack(() => fieldLinesDefault));
	let fieldKey = $state('');
	let comp = $state(-1);
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
	let phase = $state(0);
	let frameMs = $state(0);
	let fit = $state(0);
	let now = $state(0);
	let probe = $state<{ x: number; y: number; v: number | null; dom: string } | null>(null);
	let Canvas3D = $state.raw<typeof import('./Canvas3D.svelte').default | null>(null);
	let ext = $state.raw<{ mesh: unknown; pos: Float32Array; node: Int32Array; pair: Int32Array; nrm: Float32Array; cell: Int32Array; edges: Int32Array; features: Int32Array; c0: [number, number, number] } | null>(null);
	/** revolved view: cut away a quarter and show the meridional section planes (DevLog-015) */
	let cutaway = $state(true);
	let cuts = $state.raw<Drawable[]>([]);
	let d1 = $state.raw<RefinedDisplay | null>(null);
	let lat = $state.raw<{ key: string; d: RefinedDisplay; out: LatticeOut } | null>(null);
	let psi = $state.raw<{ key: string; d: RefinedDisplay; out: LatticeOut } | null>(null);

	const wire = $derived(mode === 'mesh' || wireUser);
	const mesh = $derived(s.mesh);
	const m2 = $derived(s.m2);
	// results of an axisymmetric mode solver drawn in 3D: E_rphiz revolved with its azimuthal order m (display only)
	// stable across remeshes during a drag (the canvas must not switch between 2D and 3D: a new WebGL context each time)
	const rev = $derived(revolve && !!s.mesh?.axisym && mode === 'results' && !!s.solution && s.solution.fields.some((f) => f.name === 'E_rphiz' && f.space === 'H1P1' && f.components === 3));
	const is3d = $derived((!!mesh && mesh.dim === 3) || rev);
	/** the solution is drawn only on the mesh it was computed on */
	const sol = $derived(s.solution && mesh && s.solution.meshHash === mesh.hash ? s.solution : null);
	const stale = $derived(!!sol && s.staleSolution);
	const coarse = $derived(!!sol && !stale && s.solutionCoarse);
	const domains = $derived(mesh?.entities.domains ?? []);
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

	// ---------------------------------------------------------------- field choice
	const fieldList = $derived((sol?.fields ?? []).map((f, i) => ({ f, i })));
	const names = $derived([...new Set(fieldList.map((x) => x.f.name))]);
	const exprIs = (expr: string | undefined, name: string | undefined) => !!expr && !!name && (expr === name || expr.endsWith(`.${name}`));
	type ResultNode = { id: string; type: string; expr?: string; unit?: string; step?: number };
	const resultsSpec = $derived(((s.model.data as { results?: ResultNode[] } | null)?.results ?? []));
	/** the spec's own plot result names the field to open on (audit M6) */
	const plotResult = $derived(resultsSpec.find((r) => (r.type === 'plot2d' || r.type === 'plot3d') && names.some((n) => exprIs(r.expr, n))) ?? null);
	const drawableSpace = (f: FieldData | null | undefined) => !!f && (f.space === 'H1P1' || f.space === 'H1P2' || f.space === 'DG0');
	const field = $derived.by((): FieldData | null => {
		if (!fieldList.length) return null;
		const name = fieldKey && names.includes(fieldKey) ? fieldKey
			: (names.find((n) => exprIs(plotResult?.expr, n)) ?? names.find((n) => drawableSpace(fieldList.find((x) => x.f.name === n)?.f)) ?? names[0]!);
		const steps = fieldList.filter((x) => x.f.name === name);
		return (steps[Math.min(step, steps.length - 1)] ?? steps[0])!.f;
	});
	const nSteps = $derived(field ? fieldList.filter((x) => x.f.name === field.name).length : 0);
	const drawable = $derived(drawableSpace(field));
	const eigen = $derived(sol?.steps?.kind === 'eigen');
	/** the phase animation Re(u e^(i phase)) is meaningful for a signed component, not for a magnitude */
	const signedField = $derived.by(() => {
		if (!field || (field.components > 1 && comp < 0)) return false;
		const c = field.components > 1 ? comp : 0, n = field.data.length / field.components;
		for (let i = 0; i < n; i++) if (field.data[field.components * i + c]! < 0) return true;
		return false;
	});
	const scalarAt = (f: FieldData, n: number, c: number) => {
		if (f.components === 1) return f.data[n]!;
		if (c >= 0) return f.data[f.components * n + c]!;
		let q = 0;
		for (let k = 0; k < f.components; k++) q += f.data[f.components * n + k]! ** 2;
		return Math.sqrt(q);
	};
	const solNorm = $derived(((sol as unknown as { normalization?: string } | null)?.normalization) ?? '');
	/** display affine: spec unit, or normalization to max |.| = 1 for eigenmodes (audit S4) */
	const disp = $derived.by(() => {
		if (field && eigen) {
			let mx = 0;
			const n = field.data.length / field.components;
			for (let i = 0; i < n; i++) mx = Math.max(mx, Math.abs(scalarAt(field, i, field.components > 1 ? comp : 0)));
			return { a: mx > 0 ? 1 / mx : 1, b: 0, unit: '', note: `normalized eigenmode: max |${field.name}| = 1 (the amplitude of an eigenmode is arbitrary)${solNorm ? `. Solver normalization: ${solNorm}` : ''}` };
		}
		const u = resultsSpec.find((r) => exprIs(r.expr, field?.name))?.unit ?? field?.unit;
		return { ...displayScale(u), note: '' };
	});
	const lu = $derived(lengthUnit(m2 ? Math.max(m2.bbox[2] - m2.bbox[0], m2.bbox[3] - m2.bbox[1]) : mesh ? bbox3(mesh.nodes).diag : 1));

	/** colour mapping from a value range: diverging when both signs carry >= 5 % of it */
	function mapping(lo: number, hi: number) {
		const m = Math.max(Math.abs(lo), Math.abs(hi));
		if (!(hi - lo > 1e-6 * m && hi > lo)) { const d = m > 0 ? 0.01 * m : 1; lo -= d; hi += d; }
		const both = lo < 0 && hi > 0 && Math.min(-lo, hi) / (hi - lo) >= 0.05;
		const range = both ? { min: -Math.max(-lo, hi), max: Math.max(-lo, hi) } : { min: lo, max: hi };
		// log only for ratio-scale quantities: not for affine units (degC) or zero-crossing data
		const logOk = !both && range.min > 0 && range.max / range.min >= 100 && !/degC/.test(disp.unit);
		const scale: ScaleMode = logOk && scaleUser === 'log' ? 'log' : 'linear';
		const cm: ColormapName = cmUser !== 'auto' ? cmUser : both ? 'balance' : 'viridis';
		return { range, both, logOk, scale, cm };
	}

	// ---------------------------------------------------------------- 2D (displays and lattices from the post worker)
	$effect(() => {
		const m = m2;
		if (!m) { d1 = null; return; }
		void s.post.display(1).then((d) => { if (s.m2 === m) d1 = d; });
	});
	/** colour-range box: the region of interest unless the view frames the whole model */
	const rangeBox = $derived(frameAll ? null : focus);
	/** refined-lattice level, lowered on large meshes (nested accuracy levels) to keep the display near 1M sub-triangles */
	const lv = $derived(m2 ? Math.max(1, Math.min(level, Math.floor(Math.sqrt(1.2e6 / Math.max(1, m2.nT))))) : level);
	const fkey = $derived(field && m2 ? `${m2.nT}:${sol?.run.startedAt}:${field.name}:${field.step ?? 0}:${comp}:${lv}:${rule}:${disp.a}:${rangeBox?.join(',')}` : '');
	$effect(() => {
		const f = field, m = m2, key = fkey;
		if (!f || !m || mode !== 'results' || !drawable) return;
		const r = f.space === 'DG0' ? 1 : lv;
		// plain copies: $state proxies cannot be posted to a worker
		const a = disp.a, b = disp.b, c = f.components > 1 ? comp : 0, rl = rule, fc: [number, number, number, number] | null = rangeBox ? [rangeBox[0], rangeBox[1], rangeBox[2], rangeBox[3]] : null;
		void Promise.all([s.post.display(r), s.post.call<'lattice'>({ type: 'lattice', field: { space: f.space as Space, data: f.data, components: f.components }, comp: c, r, a, b, psi: false, rule: rl, focus: fc })])
			.then(([d, out]) => { if (s.m2 === m && fkey === key) lat = { key, d, out }; });
	});
	// heat flux lines of a temperature field (post/flux2d.ts): traced along -grad T from the inflow boundary
	const fluxField = $derived(sol && m2 && field && field.name === 'T' && field.components === 1 && (field.space === 'H1P1' || field.space === 'H1P2') ? field : null);
	let flux = $state.raw<{ segs: Float64Array; arrows: Float64Array; n: number } | null>(null);
	$effect(() => {
		const f = fluxField, m = m2;
		if (!f || !m || !fieldLines || mode !== 'results') { flux = null; return; }
		void s.post.call<'flux'>({ type: 'flux', field: { space: f.space as Space, data: f.data, components: 1 }, n: 26 }).then((r) => { if (s.m2 === m && fluxField === f) flux = { segs: r.segs, arrows: r.arrows, n: r.nLines }; });
	});
	// field lines of an axisymmetric magnetic field: contours of the flux function r A_phi (top-10 #3)
	const aphi = $derived(sol && m2 && mesh?.axisym ? (sol.fields.find((f) => f.name === 'A_phi' && (f.space === 'H1P1' || f.space === 'H1P2')) ?? null) : null);
	$effect(() => {
		const f = aphi, m = m2;
		if (!f || !m || !fieldLines || mode !== 'results') { psi = null; return; }
		const r = lv, key = `${sol?.run.startedAt}:${r}`;
		void Promise.all([s.post.display(r), s.post.call<'lattice'>({ type: 'lattice', field: { space: f.space as Space, data: f.data, components: 1 }, comp: 0, r, a: 1, b: 0, psi: true, rule: 'full', focus: null })])
			.then(([d, out]) => { if (s.m2 === m) psi = { key, d, out }; });
	});

	/** mirrored copies of the 2D view: geometry and results (not the mesh view: it shows what was computed) */
	const parity = $derived(mirror && field ? mirror.parity(field.name, field.components > 1 ? comp : -1) : null);
	const mirrored = $derived(!!mirror && mirrorOn && !!m2 && mode !== 'mesh' && (mode === 'geometry' || !sol || !drawable || !!parity));
	function copies(p: [number, number] | null): Array<{ sx: number; sy: number; sign: number }> | undefined {
		if (!mirrored || !mirror) return undefined;
		const px = p?.[0] ?? 1, py = p?.[1] ?? 1, out = [{ sx: 1, sy: 1, sign: 1 }];
		if (mirror.planes.x) out.push({ sx: -1, sy: 1, sign: px });
		if (mirror.planes.y) out.push({ sx: 1, sy: -1, sign: py });
		if (mirror.planes.x && mirror.planes.y) out.push({ sx: -1, sy: -1, sign: px * py });
		return out;
	}
	/** whole-model box (mirrored when the view mirrors) */
	const fullBox = $derived.by((): [number, number, number, number] | null => {
		if (!m2) return null;
		const [x0, y0, x1, y1] = m2.bbox;
		if (!mirrored || !mirror) return [x0, y0, x1, y1];
		return [mirror.planes.x ? -Math.max(Math.abs(x0), Math.abs(x1)) : x0, mirror.planes.y ? -Math.max(Math.abs(y0), Math.abs(y1)) : y0, mirror.planes.x ? Math.max(Math.abs(x0), Math.abs(x1)) : x1, mirror.planes.y ? Math.max(Math.abs(y0), Math.abs(y1)) : y1];
	});
	const frameBox = $derived(frameAll || !focus ? fullBox : focus);
	const frameKey = $derived(`${frameAll}:${focus?.map((v) => v.toPrecision(4)).join(',') ?? ''}:${mirrored}`);

	const view2d = $derived.by(() => {
		type CB = { min: number; max: number; label: string; unit: string; cm: ColormapName; scale: ScaleMode; note: string; levels?: number[] };
		const none = { layers: [] as Layer2D[], cb: null as CB | null, map: null as ReturnType<typeof mapping> | null, peak: null as LatticeOut['peak'] };
		if (!m2 || !d1) return none;
		if (mode === 'geometry' || (mode === 'results' && !(sol && drawable && lat))) return { ...none, layers: [{ kind: 'region', disp: d1, regionColors, wire: mode !== 'geometry' && wire, mirror: copies(null) } as Layer2D] };
		if (mode === 'mesh') {
			const q = s.quality;
			if (!q || q.length !== m2.nT) return { ...none, layers: [{ kind: 'region', disp: d1, regionColors, wire: true } as Layer2D] };
			let lo = Infinity, hi = -Infinity;
			for (const v of q) { if (v < lo) lo = v; if (v > hi) hi = v; }
			const mp = mapping(lo, hi);
			return { ...none, map: mp, layers: [{ kind: 'surface', disp: d1, values: perElement(q), range: mp.range, colormap: cmUser === 'auto' ? 'viridis' : cmUser, wire: true } as Layer2D], cb: { ...mp.range, label: 'element shape quality q = 4 sqrt(3) A / sum(l^2), 1 = equilateral', unit: '1', cm: cmUser === 'auto' ? 'viridis' : cmUser, scale: 'linear' as ScaleMode, note: '' } };
		}
		const L = lat!;
		// odd fields mirrored with both signs: the range covers the reflected values too
		let lo = L.out.lo, hi = L.out.hi;
		const cp = copies(parity);
		if (cp?.some((c) => c.sign < 0)) { const m = Math.max(Math.abs(lo), Math.abs(hi)); lo = -m; hi = m; }
		const mp = mapping(lo, hi);
		const levels = contours && field!.space !== 'DG0' && mp.scale !== 'log' ? niceTicks(mp.range.min, mp.range.max, 14) : [];
		const layers: Layer2D[] = [{ kind: 'surface', disp: L.d, values: L.out.values, range: mp.range, scale: mp.scale, colormap: mp.cm, wire, mirror: cp }];
		if (levels.length) layers.push({ kind: 'contour', disp: L.d, values: L.out.values, range: mp.range, scale: mp.scale, colormap: mp.cm, levels, uniform: '#0d0d0d', opacity: 0.5, mirror: cp });
		const bp = band && bandOn && field!.name === band.field ? probePts.find((q) => q.id === band.probe) : undefined;
		if (bp && mp.scale !== 'log') layers.push({ kind: 'contour', disp: L.d, values: L.out.values, range: mp.range, scale: mp.scale, colormap: mp.cm, levels: [Math.abs(bp.v) * (1 - band!.rel), Math.abs(bp.v) * (1 + band!.rel)], uniform: '#e0a526', opacity: 1, mirror: cp });
		if (psi && fieldLines) {
			// r A_phi is even across the axis: the mirrored lines are the reflected contours
			const P = psi.out, n = 22, pl = Array.from({ length: n }, (_, i) => P.dataLo + ((i + 0.5) * (P.dataHi - P.dataLo)) / n);
			layers.push({ kind: 'contour', disp: psi.d, values: P.values, range: { min: P.dataLo, max: P.dataHi }, colormap: mp.cm, levels: pl, uniform: '#f2f1ec', opacity: 0.8, mirror: copies([1, 1]) });
		}
		const label = field!.name + (field!.components > 1 ? (comp < 0 ? ' magnitude' : ` component ${comp}`) : '');
		return { layers, map: mp, peak: L.out.peak, cb: { ...mp.range, label, unit: disp.unit, cm: mp.cm, scale: mp.scale, note: disp.note, levels } };
	});
	// the spec's probe results mark their own points (e.g. T_E at E, B_center at the centre); otherwise the peak
	let probePts = $state.raw<Array<{ x: number; y: number; label: string; tip: string; id: string; v: number }>>([]);
	let bandOn = $state(true);
	$effect(() => {
		const so = sol, me = mesh, params = s.model.parsed?.params;
		const results = (resultsSpec as unknown as Parameters<typeof headlines>[0]).filter((r) => r.type === 'probe');
		if (!so || !me || me.dim !== 2 || !params || !results.length) { probePts = []; return; }
		void headlines(results, so, me, params, s.post).then((h) => {
			if (s.solution !== so) return;
			probePts = h.filter((x) => x.at && x.value !== null).map((x) => ({ id: x.id, v: x.value!, x: x.at![0], y: x.at![1], label: `${x.label} ${fmt(x.value!, 4)}${x.unit ? ` ${unitLabel(x.unit)}` : ''}`, tip: `probe ${x.label}: ${x.tip}` }));
		});
	});
	const markers = $derived(mode !== 'results' || stale ? [] : probePts.length ? probePts : view2d.peak ? [{ x: view2d.peak.x, y: view2d.peak.y, label: eigen && !disp.unit ? `max |${field?.name}|` : `${fmt(view2d.peak.v)}${disp.unit ? ` ${unitLabel(disp.unit)}` : ''}`, tip: `largest |${field?.name}| ${rangeBox ? 'in the view box' : 'on the mesh'} (lattice point of the drawn field)` }] : []);
	const boundaryLines = $derived.by(() => {
		if (!mesh || mesh.dim !== 2 || mode === 'mesh') return null;
		const f = mesh.facets, npf = f.type === 'line3' ? 3 : 2, n = f.conn.length / npf, N = mesh.nodes;
		const cps = copies(null) ?? [{ sx: 1, sy: 1, sign: 1 }];
		const tol = 1e-9 * (m2 ? Math.max(m2.bbox[2] - m2.bbox[0], m2.bbox[3] - m2.bbox[1]) : 1);
		const seg: number[] = [];
		for (let i = 0; i < n; i++) {
			// line3 facets drawn as two segments through the mid node (curved boundaries)
			const ids = npf === 3 ? [f.conn[3 * i]!, f.conn[3 * i + 2]!, f.conn[3 * i + 1]!] : [f.conn[2 * i]!, f.conn[2 * i + 1]!];
			const xs = ids.map((k) => N[2 * k]!), ys = ids.map((k) => N[2 * k + 1]!);
			// facets on a symmetry plane are interior lines of the mirrored model
			if (cps.length > 1 && ((mirror?.planes.x && xs.every((x) => Math.abs(x) < tol)) || (mirror?.planes.y && ys.every((y) => Math.abs(y) < tol)))) continue;
			for (const c of cps) for (let k = 0; k + 1 < ids.length; k++) seg.push(c.sx * xs[k]!, c.sy * ys[k]!, c.sx * xs[k + 1]!, c.sy * ys[k + 1]!);
		}
		return Float64Array.from(seg);
	});

	// ---------------------------------------------------------------- 3D
	const revSurf = $derived(rev && mesh ? revolveSurface(mesh, 64, cutaway ? [0, 1.5 * Math.PI] : null) : null);
	$effect(() => {
		if (rev && !Canvas3D) void import('./Canvas3D.svelte').then((mod) => (Canvas3D = mod.default));
		if (!is3d || !mesh || mesh.dim !== 3) { ext = null; return; }
		const m = mesh;
		void s.post.call<'exterior'>({ type: 'exterior' }).then((r) => { if (s.mesh === m) ext = { mesh: m, pos: r.pos, node: r.node, pair: r.pair, nrm: r.nrm, cell: r.cell, edges: r.edges, features: r.features, c0: r.c0 }; });
		if (!Canvas3D) void import('./Canvas3D.svelte').then((mod) => (Canvas3D = mod.default));
	});
	const half = $derived.by((): [number, number, number] => {
		if (revSurf) return revSurf.half;
		if (!mesh || mesh.dim !== 3) return [1, 1, 1];
		const b = bbox3(mesh.nodes);
		return [(b.hi[0] - b.lo[0]) / 2, (b.hi[1] - b.lo[1]) / 2, (b.hi[2] - b.lo[2]) / 2];
	});
	const nodal3 = $derived(is3d && !rev && mesh?.dim === 3 && sol && field && (field.space === 'H1P1' || field.space === 'H1P2') ? field : null);
	const dispField = $derived(is3d && sol ? (sol.fields.find((f) => f.components === 3 && f.unit === 'm' && (f.space === 'H1P1' || f.space === 'H1P2') && (f.step ?? 0) === (field?.step ?? 0)) ?? null) : null);
	/** revolved magnitude of a real eigenmode: |E(t)| = |E| |cos(w t)| (exact for a lossless real mode) */
	const animAbs = $derived(rev && eigen && comp < 0);
	const canAnimate = $derived(drawable && ((eigen && (signedField || !!dispField || animAbs)) || (!eigen && nSteps > 1)));
	const autoScale = $derived(dispField && mesh ? autoDeformScale(bbox3(mesh.nodes).diag, dispField.data) : 0);
	const deform = $derived(dispField && deformOn ? (deformUser ?? autoScale) : 0);
	function pct(a: Float32Array): { lo: number; hi: number } {
		const st = Math.max(1, Math.floor(a.length / 40000)), x: number[] = [];
		for (let i = 0; i < a.length; i += st) if (Number.isFinite(a[i]!)) x.push(a[i]!);
		x.sort((p, q) => p - q);
		return { lo: x[Math.floor(0.01 * (x.length - 1))] ?? 0, hi: x[Math.ceil(0.99 * (x.length - 1))] ?? 1 };
	}
	const azimuthal = $derived(sol ? (sol.scalars[`m_${field?.step ?? 0}`]?.value ?? 0) : 0);
	const view3d = $derived.by(() => {
		if (revSurf) {
			// field and surface must come from the same mesh; otherwise keep the last view (shown3d)
			if (!sol || !field || field.name !== 'E_rphiz') return null;
			const val = revolvedValues(field.data, azimuthal, comp, revSurf, 1, field.space === 'H1P1');
			let mx = 0;
			for (const v of val) mx = Math.max(mx, Math.abs(v));
			if (mx > 0) for (let i = 0; i < val.length; i++) val[i] = val[i]! / mx;
			let lo = Infinity, hi = -Infinity;
			for (const v of val) { if (v < lo) lo = v; if (v > hi) hi = v; }
			const mp = mapping(lo, hi);
			const label = `E ${comp < 0 ? 'magnitude' : ['r', 'phi', 'z'][comp]}, azimuthal order m = ${azimuthal}`;
			const note = `normalized: max |.| on the drawn surface = 1 (eigenmode amplitude is arbitrary). Reconstructed from the (r, z) solution: E_r cos(m phi), E_phi sin(m phi), E_z cos(m phi), one partner of an m >= 1 doublet${solNorm ? `. Solver normalization: ${solNorm}` : ''}`;
			return { surface: { pos: revSurf.pos, val, disp: null, nrm: revSurf.nrm } as Drawable, region: false, map: mp, range: mp.range, edges: revSurf.rings, ed: null, cb: { ...mp.range, label, unit: '', cm: mp.cm, scale: mp.scale, note } };
		}
		// the exterior must belong to the current mesh (a remesh may be in flight)
		if (!ext || !mesh || ext.mesh !== mesh) return null;
		const nv = ext.node.length;
		const val = new Float32Array(nv);
		let lo = Infinity, hi = -Infinity, region = false, label = '', unit = '', note = '';
		if (mode === 'geometry' || (mode === 'results' && !(sol && drawable))) {
			for (let i = 0; i < nv; i++) val[i] = mesh.cells.domain[ext.cell[i]!]!;
			region = true;
		} else if (mode === 'mesh') {
			const q = s.quality;
			if (q) for (let i = 0; i < nv; i++) { const v = q[ext.cell[i]!]!; val[i] = v; if (v < lo) lo = v; if (v > hi) hi = v; }
			label = 'cell quality: min mean ratio over the tet split (1 = regular tet)';
			unit = '1';
		} else if (field) {
			const c = field.components > 1 ? comp : 0, nFieldNodes = field.data.length / field.components; const X = ext;
			for (let i = 0; i < nv; i++) {
				// tet10 mid-edge vertices: the nodal value when the field has one there (P2), else the edge mean (P1)
				const nodeV = (k: number) => (k < nFieldNodes && (field.space !== 'H1P1' || X.pair[2 * i] === X.pair[2 * i + 1]) ? scalarAt(field, k, c) : 0.5 * (scalarAt(field, X.pair[2 * i]!, c) + scalarAt(field, X.pair[2 * i + 1]!, c)));
				const vv = disp.a * (field.space === 'DG0' ? scalarAt(field, ext.cell[i]!, c) : nodeV(ext.node[i]!)) + disp.b;
				val[i] = vv; if (vv < lo) lo = vv; if (vv > hi) hi = vv;
			}
			if (rule === 'robust') ({ lo, hi } = pct(val));
			label = field.name;
			unit = disp.unit;
			note = disp.note;
		}
		const E = mode === 'mesh' || wire ? ext.edges : ext.features, N = mesh.nodes, c0 = ext.c0;
		const edges = new Float32Array(3 * E.length);
		for (let i = 0; i < E.length; i++) for (let k = 0; k < 3; k++) edges[3 * i + k] = N[3 * E[i]! + k]! - c0[k]!;
		let dv: Float32Array | null = null, ed: Float32Array | null = null;
		if (dispField) {
			dv = new Float32Array(3 * nv);
			for (let i = 0; i < nv; i++) for (let k = 0; k < 3; k++) dv[3 * i + k] = dispField.data[3 * ext.node[i]! + k]!;
			ed = new Float32Array(3 * E.length);
			for (let i = 0; i < E.length; i++) for (let k = 0; k < 3; k++) ed[3 * i + k] = dispField.data[3 * E[i]! + k]!;
		}
		if (region) return { surface: { pos: ext.pos, val, disp: dv, nrm: ext.nrm } as Drawable, region, cb: null, map: null, range: { min: 0, max: Math.max(1, domains.length - 1) }, edges, ed };
		const mp = mapping(lo, hi);
		return { surface: { pos: ext.pos, val, disp: dv, nrm: ext.nrm } as Drawable, region, map: mp, range: mp.range, edges, ed, cb: { ...mp.range, label, unit, cm: mp.cm, scale: mp.scale, note } };
	});
	// keep the last complete 3D view while a remesh is in flight: unmounting the canvas would recreate the WebGL
	// context (setSize + context loss measured at 100-400 ms per drag step; audit S6)
	let last3d: NonNullable<typeof view3d> | null = null;
	const shown3d = $derived.by(() => {
		const v = view3d;
		if (v) last3d = v;
		return v ?? (is3d ? last3d : null);
	});
	const clip3 = $derived.by(() => {
		if (!clipOn || !mesh || !is3d) return null;
		if (revSurf) { const n: [number, number, number] = [0, 0, 0]; n[clipAxis] = 1; return { n, d: (2 * clipFrac - 1) * revSurf.half[clipAxis]! }; }
		const b = bbox3(mesh.nodes);
		const n: [number, number, number] = [0, 0, 0];
		n[clipAxis] = 1;
		return { n, d: b.lo[clipAxis]! + clipFrac * (b.hi[clipAxis]! - b.lo[clipAxis]!) - b.c[clipAxis]! };
	});
	$effect(() => {
		const f = nodal3, m = mesh;
		if (!f || !m || (!sliceOn && !isoOn) || mode !== 'results') { cuts = []; return; }
		const nn = m.nodes.length / 3, c = f.components > 1 ? comp : 0;
		const nodal = new Float64Array(nn);
		for (let i = 0; i < nn; i++) nodal[i] = disp.a * scalarAt(f, i, c) + disp.b;
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

	// eigen solutions open on their first non-zero mode, or the spec's plot result step
	let solSeen: unknown = null;
	$effect(() => {
		if (sol && sol !== solSeen) {
			const first = solSeen === null;
			solSeen = sol;
			if (!first && untrack(() => step) < (sol.steps?.values.length ?? 0)) return;
			const v = sol.steps?.kind === 'eigen' ? sol.steps.values : null;
			const want = plotResult?.step ?? (v ? v.findIndex((x) => x > 0) : 0);
			step = want > 0 ? want : 0;
		}
	});

	onMount(() => {
		let raf = 0, last = performance.now();
		const tick = (t: number) => {
			raf = requestAnimationFrame(tick);
			if (s.status === 'solving') now = t;
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
			else if (k === ' ' && canAnimate) { e.preventDefault(); playing = !playing; }
		};
		window.addEventListener('keydown', key);
		return () => { cancelAnimationFrame(raf); window.removeEventListener('keydown', key); };
	});

	let interacted = false;
	function firstTouch() {
		// calm start: the mode animation begins on the first interaction with the canvas (R5 lesson 3)
		if (autoAnimate && !interacted && eigen && canAnimate) playing = true;
		interacted = true;
	}

	function hover(p: { x: number; y: number } | null) {
		if (!p) { probe = null; return; }
		const a = disp.a, b = disp.b;
		// a mirrored point is evaluated at its computed image, times the field's parity
		let x = p.x, y = p.y, sg = 1;
		if (mirrored && mirror) {
			const pr = parity ?? [1, 1];
			if (mirror.planes.x && x < 0) { x = -x; sg *= pr[0]; }
			if (mirror.planes.y && y < 0) { y = -y; sg *= pr[1]; }
		}
		s.post.probe(x, y, (h) => {
			probe = h.hit ? { x: p.x, y: p.y, v: h.hit.value === null ? null : sg * (a * h.hit.value) + b, dom: domains[h.hit.domain]?.id ?? String(h.hit.domain) } : null;
		});
	}
	$effect(() => {
		if (!m2) return;
		if (mode === 'results' && field && drawable) s.post.setField({ space: field.space as Space, data: field.data, components: field.components, comp: field.components > 1 ? comp : 0 });
		else s.post.setField(null);
	});

	const running = $derived(s.status === 'solving');
	const longRun = $derived(running && s.runStart > 0 && now - s.runStart > 1000);
	const cb = $derived(m2 && !rev ? view2d.cb : (shown3d?.cb ?? null));
	const map = $derived(m2 && !rev ? view2d.map : (shown3d?.map ?? null));
	const modeTip: Record<Mode, string> = { geometry: 'Geometry: domains by colour (G)', mesh: 'Mesh: element quality and wireframe (M)', results: 'Results: solution fields (R)' };
	const meshChanged = $derived(!!s.solution && !!mesh && s.solution.meshHash !== mesh.hash);
</script>

<div class="gfx" class:stale role="presentation" onpointerdown={firstTouch}>
	<!-- the stage excludes the colorbar strip: nothing is drawn under the colorbar -->
	<div class="stage" class:bg3={is3d}>
	{#if m2 && !rev}
		<Canvas2D layers={view2d.layers} bbox={frameBox} {frameKey} {padTop} fitKey={fitKey + fit} {handles} {onhandle} onhover={hover} onframe={(ms) => (frameMs = ms)} lines={boundaryLines} {hiLines} {markers} flow={flux && !stale ? flux : null} />
	{:else if is3d && Canvas3D && shown3d}
		<Canvas3D surface={shown3d.surface} regionColors={shown3d.region ? regionColors : null} edges={shown3d.edges} edgeDisp={shown3d.ed} colormap={shown3d.map?.cm ?? 'viridis'} range={shown3d.range} logScale={shown3d.map?.scale === 'log'} wire={true}
			showSurface={!(sliceOn || isoOn) || clipOn || mode !== 'results'} {deform} clip={clip3} {cuts} phase={eigen && playing && canAnimate ? phase : null} animValue={eigen && (signedField || animAbs)} {animAbs} {half} fitKey={fitKey + fit} onframe={(ms) => (frameMs = ms)} />
	{:else}
		<div class="empty dim">{s.status === 'meshing' ? 'Meshing...' : s.status === 'error' ? 'No mesh: see Messages' : 'No mesh yet'}</div>
	{/if}
	</div>
	{#if longRun}<div class="prog" data-tip={`${s.progress?.stage ?? 'run'} ${s.progress?.msg ?? ''}`}><span style="width: {Math.round(100 * (s.progress?.frac ?? 0))}%" class:ind={!s.progress || s.progress.frac <= 0 || s.progress.frac >= 1}></span></div>{/if}

	<div class="top">
		<div class="modes" role="tablist">
			{#each ['geometry', 'mesh', 'results'] as const as k}
				<button role="tab" aria-selected={mode === k} class:on={mode === k} data-tip={modeTip[k]} onclick={() => (mode = k)}>{k[0]!.toUpperCase() + k.slice(1)}</button>
			{/each}
		</div>
		{#if m2 && !rev && focus && fullBox && (focus[2] - focus[0] < 0.9 * (fullBox[2] - fullBox[0]) || focus[3] - focus[1] < 0.9 * (fullBox[3] - fullBox[1]))}
			<div class="modes">
				<button class:on={!frameAll} data-tip="Frame the region of interest (the colour range is taken over it)" onclick={() => (frameAll = false)}>ROI</button>
				<button class:on={frameAll} data-tip="Frame the whole model (the colour range is taken over all of it)" onclick={() => (frameAll = true)}>All</button>
			</div>
		{/if}
		{#if m2 && !rev && mirror && mode !== 'mesh'}
			<button class:on={mirrored} data-tip={`${mirror.tip}.${mirrored || !mirrorOn ? '' : ` Not mirrored: ${field?.name ?? 'this field'} has no stated parity.`} Display only; the solve uses the reduced model.`} onclick={() => (mirrorOn = !mirrorOn)}>Mirror</button>
		{/if}
		{#if !compact}
			<button class:on={wire} data-tip="Wireframe (W)" onclick={() => (wireUser = !wireUser)} disabled={mode === 'mesh'}>Wire</button>
			<button data-tip="Zoom extents (F)" onclick={() => fit++}>Fit</button>
			{#if cb}
				<select value={cmUser} data-tip="Colormap. auto: viridis, or the diverging balance map (symmetric about zero) when both signs carry at least 5 % of the range" onchange={(e) => (cmUser = (e.currentTarget as HTMLSelectElement).value as 'auto' | ColormapName)}>
					<option value="auto">auto ({map?.cm ?? 'viridis'})</option>
					{#each COLORMAPS as c}<option value={c}>{c}</option>{/each}
				</select>
			{/if}
		{/if}
		{#if mode === 'results' && sol && names.length}
			{#if names.length > 1}<select value={field?.name} onchange={(e) => (fieldKey = (e.currentTarget as HTMLSelectElement).value)} data-tip="Field">{#each names as n}<option value={n}>{n}</option>{/each}</select>{/if}
			{#if drawable}
				{#if field && field.components > 1}
					<select bind:value={comp} data-tip="Component">
						<option value={-1}>magnitude</option>
						{#each Array.from({ length: field.components }, (_, i) => i) as i}<option value={i}>{field.name === 'E_rphiz' ? ['r', 'phi', 'z'][i] : i}</option>{/each}
					</select>
				{/if}
				{#if nSteps > 1}
					<select bind:value={step} data-tip={sol.steps ? `${sol.steps.kind} step` : 'step'}>
						{#each Array.from({ length: nSteps }, (_, i) => i) as i}<option value={i}>{sol.steps ? `${fmt(sol.steps.values[i] ?? i)} ${unitLabel(sol.steps.unit)}` : i}</option>{/each}
					</select>
				{/if}
				<select bind:value={rule} data-tip="Colour range rule: full = min to max; robust = area-weighted 1st-99th percentile (values outside saturate). Over the view box when the view has one, else the whole mesh">
					<option value="full">range: full</option>
					<option value="robust">range: p1-99</option>
				</select>
				{#if map?.logOk}<button class:on={scaleUser === 'log'} data-tip="Logarithmic colour scale (the data span more than two decades)" onclick={() => (scaleUser = scaleUser === 'log' ? 'linear' : 'log')}>log</button>{/if}
				{#if canAnimate}<button class:on={playing} data-tip={eigen ? 'Animate the mode: Re(u e^(i phase)) (Space)' : 'Play the steps (Space)'} onclick={() => (playing = !playing)}>{playing ? 'Pause' : 'Animate'}</button>{/if}
				{#if m2 && !rev}
					{#if field?.space !== 'DG0'}<button class:on={contours} data-tip="Contour lines at the colorbar ticks" onclick={() => (contours = !contours)}>Contours</button>{/if}
					{#if band && field?.name === band.field && probePts.some((q) => q.id === band.probe)}<button class="amb" class:on={bandOn} data-tip={band.tip} onclick={() => (bandOn = !bandOn)}>±{band.rel * 100} %</button>{/if}
					{#if fluxField}<button class:on={fieldLines} data-tip={`Heat flux lines: tangent to q = -k grad T, traced from the boundary where heat enters, seeded at equal inflow so each line carries the same heat (line density follows |q|); arrows point downstream${flux ? `. ${flux.n} lines` : ''}`} onclick={() => (fieldLines = !fieldLines)}>Flux lines</button>{/if}
					{#if aphi}<button class:on={fieldLines} data-tip="Magnetic field lines: contours of the flux function r A_phi at equal flux steps (line density follows |B|)" onclick={() => (fieldLines = !fieldLines)}>Field lines</button>{/if}
					{#if !compact}
						<select bind:value={level} data-tip="Smoothing: refined lattice level r (r^2 sub-triangles per element, exact FE values at the lattice points)">
							{#each [1, 2, 3, 4, 6] as l}<option value={l}>r {l}</option>{/each}
						</select>
					{/if}
				{/if}
			{/if}
		{/if}
		{#if is3d && (!compact || rev)}
			{#if rev}<button class:on={cutaway} data-tip="Cutaway: a quarter of the revolved body removed (phi 270 to 360 deg); the two meridional section planes show the field inside (exact nodal values of the (r, z) solution times the azimuthal factor)" onclick={() => (cutaway = !cutaway)}>Cutaway</button>{/if}
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

	{#if stale}<div class="badge st" data-tip="This result was computed for an earlier version of the model; recompute for the current one">stale: earlier spec</div>
	{:else if coarse}<div class="badge co" data-tip="Coarse preview while dragging (mesh sizes x2); the full-resolution run follows on release">coarse preview</div>{/if}

	{#if mode === 'results' && !sol}
		<div class="unav">
			{#if running}
				<div>computing{longRun ? ` ${fmtMs(now - s.runStart)}` : ''}...</div>
			{:else if s.status === 'unavailable'}
				<div class="na">Results unavailable</div>
				{#each s.reasons as r}<div class="dim">{r}</div>{/each}
				{#if s.caseInfo && !s.useCase && s.reasons.some((r) => /N\/A|no value/.test(r))}
					<button onclick={() => { s.useCase = true; s.requestCompute(); }} data-tip={`Fill N/A material properties with the sourced inputs of eval case ${s.caseInfo.id}:\n${s.caseInfo.materials}`}>use eval case {s.caseInfo.id} values</button>
				{/if}
			{:else if meshChanged}
				<div class="na">Results out of date</div><div class="dim">the geometry or mesh changed since the last solve: Compute</div>
			{:else}
				<div class="dim">not computed: Compute runs the registered physics module</div>
			{/if}
		</div>
	{:else if mode === 'results' && sol && field && !drawable}
		<div class="unav"><div class="na">Field {field.name} ({field.space}): no display yet</div><div class="dim">the viewer draws nodal (H1) and per-cell (DG0) fields; {field.space} needs an H1 projection from @amp/physics or Nedelec evaluation in @amp/post (DevLog-011 s.5)</div></div>
	{/if}

	{#if cb}
		<Colorbar colormap={cb.cm} min={cb.min} max={cb.max} scale={cb.scale} label={cb.label} unit={cb.unit} note={cb.note} rule={mode === 'results' ? rule : 'full'} scoped={mode === 'results' && !!rangeBox} levels={'levels' in cb ? (cb.levels ?? []) : []} />
	{/if}

	<div class="foot mono">
		{#if probe}
			<span data-tip="exact evaluation of the FE field at the cursor (post worker)">x {fmt(probe.x * lu.f)} {unitLabel(lu.unit)}, y {fmt(probe.y * lu.f)} {unitLabel(lu.unit)}</span>
			<span>{probe.dom}</span>
			{#if probe.v !== null}<span>{field?.name ?? ''} = {fmt(probe.v)} {unitLabel(disp.unit)}</span>{/if}
		{/if}
		<span class="sp"></span>
		{#if s.meshInfo}<span data-tip={`mesh hash ${s.meshInfo.hash.slice(0, 16)}; mesher: ${s.meshInfo.source}; parse ${fmtMs(s.meshInfo.ms.parse)}, mesh ${fmtMs(s.meshInfo.ms.mesh)}; min quality ${fmt(s.meshInfo.qmin)}, mean ${fmt(s.meshInfo.qmean)}`}>{s.meshInfo.cells} {s.meshInfo.type}, {s.meshInfo.nodes} nodes</span>{/if}
		{#if !compact}<span data-tip="last frame draw time (CPU side)">{fmtMs(frameMs)}</span>{/if}
	</div>
</div>

<style>
	.gfx { position: absolute; inset: 0; background: #0d0d0d; overflow: hidden; user-select: none; -webkit-user-select: none; }
	.stage { position: absolute; left: 0; top: 0; bottom: 0; right: 84px; }
	.stage.bg3 { background: radial-gradient(ellipse at 50% 42%, #1d1e20 0%, #131314 55%, #0d0d0d 100%); }
	.gfx.stale :global(canvas) { filter: saturate(0.2) brightness(0.65); }
	.empty { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; }
	.top { position: absolute; left: 6px; top: 6px; right: 90px; display: flex; flex-wrap: wrap; gap: 3px; align-items: center; pointer-events: none; }
	.top > * { pointer-events: auto; }
	.modes { display: flex; }
	.modes button + button { border-left: 0; }
	.n { width: 56px; }
	.amb.on { background: #6b4e12; border-color: #e0a526; color: #fff; }
	.prog { position: absolute; left: 0; right: 0; top: 0; height: 2px; background: rgba(57, 135, 229, 0.15); }
	.prog span { position: absolute; left: 0; top: 0; bottom: 0; background: var(--accent); transition: width 0.2s; }
	.prog span.ind { width: 30% !important; animation: slide 1.2s linear infinite; }
	@keyframes slide { from { left: -30%; } to { left: 100%; } }
	.badge { position: absolute; right: 90px; top: 36px; font-size: 11px; padding: 1px 6px; border: 1px solid; background: rgba(13, 13, 13, 0.85); }
	.badge.st { color: var(--warn); border-color: var(--warn); }
	.badge.co { color: var(--ink-2); border-color: var(--border); }
	.unav { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); background: rgba(13, 13, 13, 0.88); border: 1px solid var(--border); padding: 8px 12px; max-width: 70%; font-size: 11px; display: flex; flex-direction: column; gap: 3px; align-items: flex-start; }
	.unav .na { font-size: 12px; }
	.foot { position: absolute; left: 6px; right: 90px; bottom: 4px; display: flex; gap: 12px; font-size: 11px; color: var(--ink-2); pointer-events: none; white-space: nowrap; overflow: hidden; }
	.foot > span:not(.sp) { pointer-events: auto; background: rgba(13, 13, 13, 0.75); padding: 0 3px; }
	.sp { flex: 1; }
	@media (max-width: 760px) {
		.top { right: 6px; }
		.stage { right: 0; bottom: 52px; }
		.foot { right: 6px; bottom: 54px; }
		.badge { right: 6px; top: 64px; }
	}
</style>
