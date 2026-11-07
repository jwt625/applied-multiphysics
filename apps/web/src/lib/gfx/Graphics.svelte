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
	// Workbench (DevLog-020): a click in Results adds a probe-table row (post/probe.ts) and marks the point; a sweep
	// shows its dataset selector here; probes, markers, colorbar and headlines follow the selected dataset.
	// Plot groups (DevLog-027): `plot` names a plot2d group to draw instead of the toolbar state (the quick view):
	// surface (a field reference keeps the exact FE basis; an expression is evaluated at the mesh nodes by R3's
	// ResultsClient and interpolated in the element basis), contour levels, line, max / min (method stated), point,
	// arrow, mesh, deformation (displaced lattice and outline); height / streamline are listed as not drawn. Quick view:
	// "Save as plot group" writes the toolbar state as one op. Draw tools create cut lines / cut points (one op each);
	// the selected cut line shows end handles, dragged as one coalesced op without a re-mesh.
	import { onMount, untrack } from 'svelte';
	import type { FieldData } from '@amp/spec/types';
	import type { Session } from '../workbench/session.svelte';
	import { displayScale } from '../workbench/session.svelte';
	import { perElement, type RefinedDisplay, type Space } from '../post/field2d';
	import type { LatticeOut, RangeRule } from '../post/post.worker';
	import { autoDeformScale, bbox3 } from '../post/solid3d';
	import { revolvedValues, type RevolvedSurface } from '../post/revolve';
	import { headlines } from '../post/headline';
	import { headlineItems, resultUnits, surfaceItems } from '@amp/spec';
	import { friendlyIssues } from '../state/issues';
	import type { Layer2D, ScaleMode } from './renderer2d';
	import type { Drawable } from './viewer3d';
	import { COLORMAPS, type ColormapName } from './colormaps';
	import { domainColors, lengthUnit, unitLabel } from './units';
	import { fmt, fmtMs, niceTicks } from './ticks';
	import Canvas2D, { type Handle } from './Canvas2D.svelte';
	import { probe2d, probe3d, rayHit, type ProbeRow } from '../post/probe';
	import type { ProbeTable } from '../state/probes.svelte';
	import Colorbar from './Colorbar.svelte';
	import { resolveQuantity, resultsOf, singleStep } from '@amp/spec';
	import { scopeOf } from '../engine/spec-adapter';
	import { resultsClient, runOf } from '../results/api';
	import { enabledItems, fieldRef, overlay2d, plotGroup, type Overlay2D } from '../results/plot-data';
	import { componentExpr, cutLineEndPatch, cutLinePatch, cutPointPatch, nodeAt, quickViewPatch, type PlotCtx } from '../results/plot-ops';
	import { colormapLut } from './colormaps';

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
		padTop = 0,
		probes = null,
		onprobe,
		plot = null,
		onplot,
		editLine = null,
		oncreated,
		tools = false,
		ondragms
	}: {
		/** id of a plot2d group to draw (null: the quick view, the toolbar state) */
		plot?: string | null;
		/** a plot group was saved from the quick view (its id), or the view returns to the quick view (null) */
		onplot?: (id: string | null) => void;
		/** JSON Pointer of a cut-line dataset whose ends are shown as handles (selected in the tree) */
		editLine?: string | null;
		/** a cut line / cut point dataset was drawn (and the 1D group created with a line) */
		oncreated?: (r: { dataset: string; pointer: string; group: string | null }) => void;
		/** workbench: draw tools and Save as plot group */
		tools?: boolean;
		/** time from a cut-line handle move to its op landing, ms */
		ondragms?: (ms: number) => void;
		/** probe table (workbench): clicks in Results add rows; null = no click probes (Play) */
		probes?: ProbeTable | null;
		onprobe?: (row: ProbeRow) => void;
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
	let ruleUser = $state<RangeRule>(untrack(() => rangeDefault));
	let scalePick = $state<ScaleMode>('linear');
	let cmPick = $state<'auto' | ColormapName>('auto');
	let level = $state(3);
	let contoursUser = $state(untrack(() => contoursDefault));
	/** raw element view (DevLog-019, lane W1): no per-pixel basis evaluation, DG0 flat per cell */
	let rawField = $state(false);
	let fieldLines = $state(untrack(() => fieldLinesDefault));
	let fieldKey = $state('');
	let compUser = $state(-1);
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

	// ---------------------------------------------------------------- plot group (DevLog-027)
	const grp = $derived(plotGroup(s.model.data, plot));
	const g2 = $derived(grp?.type === 'plot2d' && grp.enabled !== false ? grp : null);
	/** type of the group's dataset: only a solution dataset is drawn here (joins, mirrors, cut planes: stages R4 / R5) */
	const gDsType = $derived(g2 ? (resultsOf(s.model.data).datasets.find((d) => d.id === g2.data)?.type ?? null) : null);
	const gItems = $derived(enabledItems(g2));
	/** the item that sets the colour field: the first surface, else the first contour */
	const gBase = $derived(gItems.find((i) => i.type === 'surface') ?? gItems.find((i) => i.type === 'contour') ?? null);
	const physIds = $derived(((s.model.data as { physics?: Array<{ id?: unknown }> } | null)?.physics ?? []).map((p) => String(p.id ?? '')));
	const gRef = $derived(gBase && s.solution ? fieldRef(gBase.expr, s.solution.fields, physIds, !!s.mesh?.axisym) : null);
	/** expression (not a field reference) of the base item, evaluated at the mesh nodes in the post worker (R3 adapter) */
	let gNodal = $state.raw<{ key: string; meshHash: string; f: FieldData; unit: string; continuous: boolean } | null>(null);
	let gErr = $state('');
	let gOver = $state.raw<Overlay2D | null>(null);
	const gStep = $derived(g2 && gBase ? singleStep(gBase.steps ?? g2.steps) : undefined);
	/** the step every group request uses: the group's single step, else the toolbar step (none for a stationary solution) */
	const reqStep = $derived(!s.solution?.steps ? undefined : gStep !== undefined ? gStep : step);
	/** resolved params (results-only param edits keep the solution fresh, so they must key the cached values) */
	const paramKey = $derived([...(s.activeParams ?? new Map())].map(([k, v]) => `${k}=${(v as { si?: number }).si}`).join(','));
	const gKey = $derived(gBase && g2 && s.solution ? `${s.solution.run.startedAt}:${s.solution.meshHash}:${gBase.expr}:${gBase.unit ?? ''}:${String(reqStep)}:${g2.data ?? ''}:${paramKey}` : '');
	let gTok = 0;
	$effect(() => {
		const b = gBase, g = g2, so = s.solution, me = s.mesh, data = s.model.data, key = gKey, st = reqStep;
		if (!b || !g || gRef || gDsType !== 'solution' || !so || !me || so.meshHash !== me.hash) { gNodal = null; gErr = ''; return; }
		if (gNodal?.key === key) return;
		// the old values are dropped at once: an older expression, step or mesh is never drawn under the new label
		gNodal = null;
		const t = ++gTok;
		void (async () => {
			const run = await runOf(s);
			if (!run || t !== gTok) return;
			const nv = await resultsClient(s.post).nodalValues(data, String(b.expr), run, { ...(b.unit ? { unit: b.unit } : {}), ...(st !== undefined ? { step: st } : {}), ...(g.data ? { dataset: g.data } : {}) });
			if (t !== gTok || s.solution !== so) return;
			if (nv.error || !nv.values) { gNodal = null; gErr = `${b.id}: ${nv.error ?? 'no values'}`; return; }
			gErr = '';
			gNodal = { key, meshHash: nv.meshHash, unit: nv.unit, continuous: nv.continuous, f: { name: String(b.expr), unit: nv.unit, space: nv.space, components: 1, data: nv.values, step: nv.step } as FieldData };
		})().catch((e: unknown) => { if (t === gTok) gErr = `${b.id}: ${e instanceof Error ? e.message : String(e)}`; });
	});
	const rangeOf = (it: typeof gBase) => (it && it.range && typeof it.range === 'object' ? (it.range as { rule?: string; min?: unknown; max?: unknown }) : null);
	/** group settings that replace the toolbar state */
	const gv = $derived.by(() => {
		if (!g2) return null;
		const b = gBase, r = rangeOf(b);
		const cont = gItems.find((i) => i.type === 'contour' && (b?.type === 'contour' ? i === b : i.expr === b?.expr)) ?? null;
		return {
			comp: gRef ? gRef.comp : 0,
			rule: (r?.rule === 'p1-99' ? 'robust' : 'full') as RangeRule,
			manual: r?.rule === 'manual' ? { min: r.min, max: r.max } : null,
			cm: (typeof b?.colormap === 'string' ? b.colormap : 'auto') as 'auto' | ColormapName,
			log: b?.log === true,
			contour: cont,
			surface: b?.type === 'surface',
			wire: gItems.some((i) => i.type === 'mesh'),
			deform: gItems.find((i) => i.type === 'deformation') ?? null,
			notes: [
				...gItems.filter((i) => i.type === 'height').map((i) => `${i.id}: height is not drawn (the 2D renderer has no warp)`),
				...gItems.filter((i) => i.type === 'streamline').map((i) => `${i.id}: streamlines are not drawn yet (no tracer for general vector fields; the heat-flux and field-line views are in the quick view)`),
				...gItems.filter((i) => i.type === 'contour' && i !== cont).map((i) => `${i.id}: contour of ${i.expr} differs from the colour field ${b?.expr ?? ''}: not drawn (one colour field per group in R2)`),
				...gItems.filter((i) => i.type === 'surface' && i !== b).map((i) => `${i.id}: a second surface is not drawn (the first one sets the colour field)`)
			]
		};
	});
	const comp = $derived(gv ? gv.comp : compUser);
	const rule = $derived(gv ? gv.rule : ruleUser);
	const cmUser = $derived(gv ? gv.cm : cmPick);
	const scaleUser = $derived<ScaleMode>(gv ? (gv.log ? 'log' : 'linear') : scalePick);
	const contours = $derived(gv ? !!gv.contour : contoursUser);
	const wire = $derived(mode === 'mesh' || wireUser || !!gv?.wire);
	const mesh = $derived(s.mesh);
	const m2 = $derived(s.m2);
	// results of an axisymmetric mode solver drawn in 3D: E_rphiz revolved with its azimuthal order m (display only)
	// stable across remeshes during a drag (the canvas must not switch between 2D and 3D: a new WebGL context each time)
	const rev = $derived(revolve && !!s.mesh?.axisym && mode === 'results' && !!s.solution && s.solution.fields.some((f) => f.name === 'E_rphiz' && f.space === 'H1P1' && f.components === 3));
	const is3d = $derived((!!mesh && mesh.dim === 3) || rev);
	/** the solution is drawn only on the mesh it was computed on */
	const sol = $derived(s.solution && mesh && s.solution.meshHash === mesh.hash ? s.solution : null);
	const stale = $derived(!!sol && s.staleSolution);
	/** the model text does not validate (audit S1): its reasons, params in "name = value unit outside range" form */
	const invalid = $derived(s.model.parsed && !s.model.parsed.ok ? friendlyIssues(s.model.parsed.issues, (s.model.data as { params?: Record<string, { unit?: string }> } | null)?.params) : []);
	const coarse = $derived(!!sol && !stale && s.solutionCoarse);
	const domains = $derived(mesh?.entities.domains ?? []);
	const hiSet = $derived(new Set(highlight));
	const regionColors = $derived(hiSet.size ? domains.map((d) => (hiSet.has(d.id) || [...hiSet].some((h) => d.parent?.includes(h)) ? '#e0a526' : '#3a3a37')) : domainColors(domains.length));
	const hiLines = $derived.by(() => {
		if (!mesh || mesh.dim !== 2 || !hiSet.size) return null;
		const bs = mesh.entities.boundaries.map((b) => hiSet.has(b.id) || !!b.parent?.some((x) => hiSet.has(x)));
		if (!bs.some(Boolean)) return null;
		const f = mesh.facets, npf = f.type === 'line3' ? 3 : 2, N = mesh.nodes, seg: number[] = [];
		// mirrored like the boundary outline (the copies of the displayed symmetric model); line3 through the mid node
		const cps = copies(null) ?? [{ sx: 1, sy: 1, sign: 1 }];
		for (let i = 0; i < f.conn.length / npf; i++) if (bs[f.boundary[i]!]) {
			const ids = npf === 3 ? [f.conn[3 * i]!, f.conn[3 * i + 2]!, f.conn[3 * i + 1]!] : [f.conn[2 * i]!, f.conn[2 * i + 1]!];
			for (const c of cps) for (let k = 0; k + 1 < ids.length; k++) seg.push(c.sx * N[2 * ids[k]!]!, c.sy * N[2 * ids[k]! + 1]!, c.sx * N[2 * ids[k + 1]!]!, c.sy * N[2 * ids[k + 1]! + 1]!);
		}
		return Float64Array.from(seg);
	});

	// ---------------------------------------------------------------- field choice
	const fieldList = $derived((sol?.fields ?? []).map((f, i) => ({ f, i })));
	const names = $derived([...new Set(fieldList.map((x) => x.f.name))]);
	const exprIs = (expr: string | undefined, name: string | undefined) => !!expr && !!name && (expr === name || expr.endsWith(`.${name}`));
	/** the spec's results block (CONTRACTS C10) */
	const resultsSpec = $derived((s.model.data as { results?: unknown } | null)?.results ?? null);
	/** the spec's own 2D / 3D surface plot names the field to open on (audit M6) */
	const plotResult = $derived(surfaceItems(resultsSpec).find((r) => names.some((n) => exprIs(r.expr, n))) ?? null);
	const drawableSpace = (f: FieldData | null | undefined) => !!f && (f.space === 'H1P1' || f.space === 'H1P2' || f.space === 'DG0');
	const field = $derived.by((): FieldData | null => {
		if (!fieldList.length) return null;
		if (g2) {
			if (!gBase || gDsType !== 'solution') return null;
			if (!gRef) return gNodal && gNodal.key === gKey && gNodal.meshHash === mesh?.hash ? gNodal.f : null;
			const st = fieldList.filter((x) => x.f.name === gRef.name);
			const k = gStep === 'last' ? st.length - 1 : typeof gStep === 'number' ? gStep : step;
			return (st[Math.min(k, st.length - 1)] ?? st[0])?.f ?? null;
		}
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
		if (g2 && field && !gRef) return { a: 1, b: 0, unit: gNodal?.unit || '1', note: `${gBase?.expr} evaluated at the mesh nodes (results adapter, @amp/post) and interpolated in the element basis${gNodal && !gNodal.continuous ? '; the expression jumps across elements: each node takes its first cell' : ''}` };
		if (g2 && field) return { ...displayScale(gBase?.unit ?? field.unit), note: '' };
		const u = resultUnits(resultsSpec).find((r) => exprIs(r.expr, field?.name))?.unit ?? field?.unit;
		return { ...displayScale(u), note: '' };
	});
	const lu = $derived(lengthUnit(m2 ? Math.max(m2.bbox[2] - m2.bbox[0], m2.bbox[3] - m2.bbox[1]) : mesh ? bbox3(mesh.nodes).diag : 1));

	/** colour mapping from a value range: diverging when both signs carry >= 5 % of it */
	/** manual colour range of the group's base item, in the display unit (null when not manual or unresolved) */
	/** SI -> the unit of the drawn values (expression values arrive in the item's unit; field values are SI, scaled by disp) */
	const valueScale = $derived(g2 && !gRef && gNodal ? displayScale(gNodal.unit || undefined) : disp);
	const manualRange = $derived.by(() => {
		const mr = gv?.manual;
		if (!mr) return null;
		try {
			const sc = scopeOf(s.activeParams ?? new Map());
			const lo = resolveQuantity(mr.min as never, sc), hi = resolveQuantity(mr.max as never, sc);
			if (lo.na || hi.na) return null;
			const c = valueScale;
			return { min: c.a * lo.si + c.b, max: c.a * hi.si + c.b };
		} catch { return null; }
	});
	function mapping(lo: number, hi: number) {
		if (manualRange && manualRange.max > manualRange.min) {
			const r = manualRange, both = r.min < 0 && r.max > 0;
			const logOk = !both && r.min > 0 && r.max / r.min >= 100 && !/degC/.test(disp.unit);
			return { range: { min: r.min, max: r.max }, both, logOk, scale: (logOk && scaleUser === 'log' ? 'log' : 'linear') as ScaleMode, cm: (cmUser !== 'auto' ? cmUser : both ? 'balance' : 'viridis') as ColormapName };
		}
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
	/** refined-lattice level, lowered on large meshes (nested accuracy levels) to keep the display near 3e5 sub-triangles */
	// (audit S2: about 3e5 sub-triangles; a finer nested level needs fewer sub-triangles per element for the same look)
	const lv = $derived(m2 ? Math.max(1, Math.min(level, Math.floor(Math.sqrt(3e5 / Math.max(1, m2.nT))))) : level);
	const fkey = $derived(field && m2 ? `${m2.nT}:${sol?.run.startedAt}:${field.name}:${field.step ?? 0}:${comp}:${lv}:${rule}:${disp.a}:${rangeBox?.join(',')}:${rawField}:${gNodal?.key ?? ''}` : '');
	$effect(() => {
		const f = field, m = m2, key = fkey;
		if (!f || !m || mode !== 'results' || !drawable) return;
		const r = f.space === 'DG0' && rawField ? 1 : lv;
		// plain copies: $state proxies cannot be posted to a worker
		const a = disp.a, b = disp.b, c = f.components > 1 ? comp : 0, rl = rule, fc: [number, number, number, number] | null = rangeBox ? [rangeBox[0], rangeBox[1], rangeBox[2], rangeBox[3]] : null;
		void Promise.all([s.post.display(r), s.post.call<'lattice'>({ type: 'lattice', field: { space: f.space as Space, data: f.data, components: f.components }, comp: c, r, a, b, psi: false, rule: rl, focus: fc, smooth: !rawField })])
			.then(([d, out]) => { if (s.m2 === m && fkey === key) lat = { key, d, out }; });
	});
	// deformation attribute (plot2d group): the displacement field (a vector field reference) at the lattice points and
	// the mesh nodes, scaled; the display positions move, the per-pixel field evaluation (barycentric) does not change
	const dfmRef = $derived.by(() => {
		const e = typeof gv?.deform?.expr === 'string' ? gv.deform.expr.trim() : '';
		const m = /^([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(e);
		if (!m || !sol || !physIds.includes(m[1]!)) return null;
		const fs = sol.fields.filter((f) => f.name === m[2] && f.components === 2 && (f.space === 'H1P1' || f.space === 'H1P2'));
		// the displacement of the shown step
		return fs.find((f) => (f.step ?? 0) === (field?.step ?? 0)) ?? fs[0] ?? null;
	});
	const dfmScale = $derived.by(() => {
		const d = gv?.deform, f = dfmRef;
		if (!d || !f || !mesh) return 0;
		return typeof d.scale === 'number' && d.scale > 0 ? d.scale : autoDeformScale(bbox3(mesh.nodes).diag, f.data);
	});
	let dfmLat = $state.raw<{ key: string; ux: Float32Array; uy: Float32Array } | null>(null);
	$effect(() => {
		const f = dfmRef, m = m2, r = field?.space === 'DG0' && rawField ? 1 : lv;
		if (!f || !m || mode !== 'results') { dfmLat = null; return; }
		const key = `${sol?.run.startedAt}:${f.name}:${r}`;
		if (dfmLat?.key === key) return;
		const one = (c: number) => s.post.call<'lattice'>({ type: 'lattice', field: { space: f.space as Space, data: f.data, components: 2 }, comp: c, r, a: 1, b: 0, psi: false, rule: 'full', focus: null, smooth: false });
		void Promise.all([one(0), one(1)]).then(([x, y]) => { if (s.m2 === m) dfmLat = { key, ux: x.values, uy: y.values }; });
	});
	/** a refined display moved by s u (same lattice order as the display positions) */
	function deformed(d: RefinedDisplay): RefinedDisplay {
		const L = dfmLat, sc = dfmScale;
		if (!L || !sc || L.ux.length * 2 !== d.pos.length) return d;
		const pos = new Float32Array(d.pos.length);
		for (let i = 0; i < L.ux.length; i++) { pos[2 * i] = d.pos[2 * i]! + sc * L.ux[i]!; pos[2 * i + 1] = d.pos[2 * i + 1]! + sc * L.uy[i]!; }
		return { ...d, pos };
	}
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
	// unmirrored views (mesh mode, or mirroring off) frame the region of interest within the computed model (audit S5)
	const frameBox = $derived.by((): [number, number, number, number] | null => {
		if (frameAll || !focus || !fullBox) return fullBox;
		if (mirrored || !mirror) return focus;
		const b: [number, number, number, number] = [Math.max(focus[0], fullBox[0]), Math.max(focus[1], fullBox[1]), Math.min(focus[2], fullBox[2]), Math.min(focus[3], fullBox[3])];
		return b[2] > b[0] && b[3] > b[1] ? b : fullBox;
	});
	const frameKey = $derived(`${frameAll}:${focus?.map((v) => v.toPrecision(4)).join(',') ?? ''}:${mirrored}`);

	/** contour levels of the group's contour item: {count} = about count nice levels, {values} = those values */
	function contourLevels(r: { min: number; max: number }): number[] | null {
		const lv0 = gv?.contour?.levels as { count?: number; values?: unknown[] } | undefined;
		if (!lv0) return null;
		if (typeof lv0.count === 'number') return niceTicks(r.min, r.max, lv0.count);
		if (Array.isArray(lv0.values)) {
			try {
				const sc = scopeOf(s.activeParams ?? new Map());
				return lv0.values.map((q) => { const v = resolveQuantity(q as never, sc); return v.na ? NaN : valueScale.a * v.si + valueScale.b; }).filter((v) => Number.isFinite(v));
			} catch { return null; }
		}
		return null;
	}
	const view2d = $derived.by(() => {
		type CB = { min: number; max: number; label: string; unit: string; cm: ColormapName; scale: ScaleMode; note: string; levels?: number[] };
		const none = { layers: [] as Layer2D[], cb: null as CB | null, map: null as ReturnType<typeof mapping> | null, peak: null as LatticeOut['peak'], peakCell: false };
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
		const levels = contours && (field!.space !== 'DG0' || !rawField) && mp.scale !== 'log' ? (contourLevels(mp.range) ?? niceTicks(mp.range.min, mp.range.max, 14)) : [];
		const D = dfmRef ? deformed(L.d) : L.d;
		const layers: Layer2D[] = gv && !gv.surface ? [{ kind: 'region', disp: dfmRef ? deformed(d1) : d1, regionColors: domains.map(() => '#262624'), wire, mirror: cp } as Layer2D]
			: [{ kind: 'surface', disp: D, values: L.out.values, coef: L.out.coef, range: mp.range, scale: mp.scale, colormap: mp.cm, wire, mirror: cp }];
		const cColor = gv?.contour ? (gv.contour.color === 'colormap' || !gv.surface ? null : '#0d0d0d') : '#0d0d0d';
		if (levels.length) layers.push({ kind: 'contour', disp: D, values: L.out.values, coef: L.out.coef, range: mp.range, scale: mp.scale, colormap: mp.cm, levels, uniform: cColor, opacity: cColor ? 0.5 : 1, mirror: cp });
		const bp = band && bandOn && field!.name === band.field ? probePts.find((q) => q.id === band.probe) : undefined;
		if (bp && mp.scale !== 'log') layers.push({ kind: 'contour', disp: L.d, values: L.out.values, coef: L.out.coef, range: mp.range, scale: mp.scale, colormap: mp.cm, levels: [Math.abs(bp.v) * (1 - band!.rel), Math.abs(bp.v) * (1 + band!.rel)], uniform: '#e0a526', opacity: 1, mirror: cp });
		if (psi && fieldLines) {
			// r A_phi is even across the axis: the mirrored lines are the reflected contours
			const P = psi.out, n = 22, pl = Array.from({ length: n }, (_, i) => P.dataLo + ((i + 0.5) * (P.dataHi - P.dataLo)) / n);
			layers.push({ kind: 'contour', disp: psi.d, values: P.values, coef: P.coef, range: { min: P.dataLo, max: P.dataHi }, colormap: mp.cm, levels: pl, uniform: '#f2f1ec', opacity: 0.8, mirror: copies([1, 1]) });
		}
		const label = g2 && gBase ? `${gBase.label ?? gBase.expr}` : field!.name + (field!.components > 1 ? (comp < 0 ? ' magnitude' : ` component ${comp}`) : '');
		return { layers, map: mp, peak: L.out.peak, peakCell: !!L.out.peakCell, cb: { ...mp.range, label, unit: disp.unit, cm: mp.cm, scale: mp.scale, note: [disp.note, L.out.peakCell && L.out.coef ? `drawn smoothed: ${L.out.coef.note}; colorbar ends and peak marker are the exact per-cell values (Raw draws the cells)` : ''].filter(Boolean).join('. '), levels } };
	});
	// the spec's probe results mark their own points (e.g. T_E at E, B_center at the centre); otherwise the peak
	let probePts = $state.raw<Array<{ x: number; y: number; label: string; tip: string; id: string; v: number }>>([]);
	let bandOn = $state(true);
	$effect(() => {
		const so = sol, me = mesh, params = s.activeParams;
		const results = resultsSpec;
		if (!so || !me || me.dim !== 2 || !params || !headlineItems(results).some((r) => r.type === 'point')) { probePts = []; return; }
		void headlines(results, so, me, params, s.post).then((h) => {
			if (s.solution !== so) return;
			probePts = h.filter((x) => x.at && x.value !== null).map((x) => ({ id: x.id, v: x.value!, x: x.at![0], y: x.at![1], label: `${x.label} ${fmt(x.value!, 4)}${x.unit ? ` ${unitLabel(x.unit)}` : ''}`, tip: `probe ${x.label}: ${x.tip}` }));
		});
	});
	const fieldLabel = $derived(field ? field.name + (field.components > 1 ? (comp < 0 ? ' magnitude' : ` component ${field.name === 'E_rphiz' ? ['r', 'phi', 'z'][comp] : comp}`) : '') : '');
	const valueUnit = $derived(disp.unit || (eigen ? 'normalized' : '1'));
	/** probe-table rows of the shown dataset and field, marked on the 2D plot */
	const probeMarks = $derived(mode !== 'results' || !probes ? [] : probes.rows.filter((r) => r.dim === 2 && r.key === s.datasetKey && r.field === fieldLabel).map((r) => ({
		x: r.p[0], y: r.p[1], kind: 'probe' as const, label: `#${r.n}`,
		tip: `probe #${r.n}: ${r.field} = ${r.value === null ? 'N/A (outside the mesh)' : `${fmt(r.value, 6)} ${unitLabel(r.unit)}`} at (${fmt(r.p[0] * r.lu.f, 5)}, ${fmt(r.p[1] * r.lu.f, 5)}) ${unitLabel(r.lu.unit)}${r.dataset ? `, ${r.dataset}` : ''}`
	})));
	const markers0 = $derived(mode !== 'results' || stale ? [] : probePts.length ? probePts : view2d.peak ? [{ x: view2d.peak.x, y: view2d.peak.y, label: eigen && !disp.unit ? `max |${field?.name}|` : `${fmt(view2d.peak.v)}${disp.unit ? ` ${unitLabel(disp.unit)}` : ''}`, tip: `largest |${field?.name}| ${rangeBox ? 'in the view box' : 'on the mesh'} (${view2d.peakCell ? 'cell value, at the cell centroid' : 'lattice point of the drawn field'})` }] : []);
	const markers = $derived([...(g2 ? (mode === 'results' && !stale ? (gOver?.markers ?? []) : []) : markers0), ...probeMarks]);
	/** probe rows of the shown dataset and field in the 3D view (viewer frame: relative to the mesh centre; undeformed) */
	const probeMarks3 = $derived(mode !== 'results' || !probes || !ext || rev ? [] : probes.rows.filter((r) => r.dim === 3 && r.key === s.datasetKey && r.field === fieldLabel).map((r) => ({
		p: [r.p[0] - ext!.c0[0], r.p[1] - ext!.c0[1], r.p[2] - ext!.c0[2]] as [number, number, number], label: `#${r.n}`,
		tip: `probe #${r.n}: ${r.field} = ${r.value === null ? 'N/A (outside the mesh)' : `${fmt(r.value, 6)} ${unitLabel(r.unit)}`} at (${r.p.map((x) => fmt(x * r.lu.f, 5)).join(', ')}) ${unitLabel(r.lu.unit)}${r.dataset ? `, ${r.dataset}` : ''}`
	})));
	// group overlays: max / min, points, boundary line colours, arrows (post worker through R3's ResultsClient)
	let oTok = 0;
	const overCm = $derived(view2d.map?.cm ?? 'viridis');
	$effect(() => {
		const g = g2, so = sol, data = s.model.data, cmn = overCm, st = typeof reqStep === 'number' ? (field?.step ?? reqStep) : reqStep, eig = eigen;
		void paramKey;
		if (!g || !so || mode !== 'results' || gDsType !== 'solution' || !gItems.some((i) => ['maxmin', 'point', 'line', 'arrow'].includes(i.type))) { gOver = null; return; }
		const L = { unit: lu.unit, f: lu.f };
		const t = ++oTok;
		void (async () => {
			const run = await runOf(s);
			if (!run || t !== oTok) return;
			const lut = colormapLut(cmn);
			const o = await overlay2d(resultsClient(s.post), data, g, run, (x) => { const i = 4 * Math.max(0, Math.min(255, Math.round(255 * x))); return `rgb(${lut[i]}, ${lut[i + 1]}, ${lut[i + 2]})`; }, L, { ...(st !== undefined ? { step: st } : {}), eigen: eig });
			if (t === oTok && s.solution === so) gOver = o;
		})().catch((e: unknown) => { if (t === oTok) { gOver = null; gErr = `overlay: ${e instanceof Error ? e.message : String(e)}`; } });
	});
	/** cut lines and cut points of the model (dashed guides; the selected cut line solid, with end handles) */
	const guides = $derived.by(() => {
		if (!m2 || mode === 'mesh' || !tools) return [];
		const r = resultsOf(s.model.data), sc = scopeOf(s.activeParams ?? new Map());
		const vecSi = (v: unknown): number[] | null => {
			try {
				if (v && typeof v === 'object' && !Array.isArray(v) && Array.isArray((v as { value?: unknown }).value)) { const q = v as { value: number[]; unit: string }; return q.value.map((x) => { const r = resolveQuantity({ value: x, unit: q.unit }, sc); return r.na ? NaN : r.si; }); }
				if (Array.isArray(v)) return v.map((x) => { const r = resolveQuantity(x as never, sc); return r.na ? NaN : r.si; });
			} catch { /* unresolved */ }
			return null;
		};
		const out: Array<{ id: string; seg?: [number, number, number, number]; pt?: [number, number]; label: string; tip: string; on?: boolean }> = [];
		r.datasets.forEach((d, i) => {
			if (d.enabled === false) return;
			const ptr = `/results/datasets/${i}`;
			if (d.type === 'cutline') {
				const a = vecSi(d.from), b = vecSi(d.to);
				if (a && b && a.length === 2 && b.length === 2) out.push({ id: d.id, seg: [a[0]!, a[1]!, b[0]!, b[1]!], label: d.id, tip: `cut line ${d.id}: (${fmt(a[0]! * lu.f, 4)}, ${fmt(a[1]! * lu.f, 4)}) to (${fmt(b[0]! * lu.f, 4)}, ${fmt(b[1]! * lu.f, 4)}) ${unitLabel(lu.unit)}${d.n ? `, ${d.n} points` : ', element-crossing points'}`, on: editLine === ptr });
			} else if (d.type === 'cutpoint' && Array.isArray(d.points)) {
				d.points.forEach((p, k) => { const a = vecSi(p); if (a && a.length === 2) out.push({ id: `${d.id}#${k}`, pt: [a[0]!, a[1]!], label: d.points!.length > 1 ? `${d.id}.${k + 1}` : d.id, tip: `cut point ${d.id}${d.points!.length > 1 ? ` #${k + 1}` : ''}: (${fmt(a[0]! * lu.f, 4)}, ${fmt(a[1]! * lu.f, 4)}) ${unitLabel(lu.unit)}`, on: editLine === ptr }); });
			}
		});
		return out;
	});
	const lineHandles = $derived.by((): Handle[] => {
		const at = editLine ? nodeAt(s.model.data, editLine) : null;
		const gd = at?.node.type === 'cutline' ? guides.find((x) => x.id === at.node.id) : null;
		if (!gd?.seg) return [];
		return [{ id: 'cl:from', x: gd.seg[0], y: gd.seg[1], tip: `drag: ${gd.id} start (one operation per drag)` }, { id: 'cl:to', x: gd.seg[2], y: gd.seg[3], tip: `drag: ${gd.id} end (one operation per drag)` }];
	});
	const pctx = (): PlotCtx => ({ data: s.model.data, mesh: s.mesh, sol: s.solution });
	let dragT = 0;
	function handle(id: string, x: number, y: number, phase: 'move' | 'end') {
		if (!id.startsWith('cl:')) { onhandle?.(id, x, y, phase); return; }
		if (!editLine) return;
		const patch = cutLineEndPatch(pctx(), editLine, id === 'cl:from' ? 'from' : 'to', [x, y]);
		const t0 = performance.now();
		dragT = t0;
		if (patch.length) void s.model.dragStep(patch, `drag cut line ${id.slice(3)}`).then(() => { if (dragT === t0) ondragms?.(performance.now() - t0); });
		if (phase === 'end') s.model.endDrag();
	}
	/** arrows at their (deformed, when the group deforms) node positions */
	const arrowsShown = $derived.by(() => {
		const A = gOver?.arrows, nd = gOver?.arrowNodes, U = dfmRef && dfmScale ? dfmRef.data : null;
		if (!A || !U || !nd) return A ?? null;
		const B = Float64Array.from(A);
		for (let k = 0; k < nd.length; k++) { B[4 * k] = A[4 * k]! + dfmScale * U[2 * nd[k]!]!; B[4 * k + 1] = A[4 * k + 1]! + dfmScale * U[2 * nd[k]! + 1]!; }
		return B;
	});
	let tool = $state<'none' | 'line' | 'point'>('none');
	/** expression of the shown colour field (the line graph of a drawn cut line plots it) */
	const shownExpr = $derived.by(() => {
		if (g2) return typeof gBase?.expr === 'string' ? gBase.expr : null;
		if (!field || eigen) return null;
		const ph = physIds[0] ?? '';
		return componentExpr(ph, field.name, field.components > 1 ? comp : -1, field.components, !!mesh?.axisym);
	});
	async function drawn(p0: { x: number; y: number }, p1: { x: number; y: number } | null) {
		const t = tool;
		tool = 'none';
		const r = t === 'line' && p1 ? cutLinePatch(pctx(), [p0.x, p0.y], [p1.x, p1.y], shownExpr) : t === 'point' ? cutPointPatch(pctx(), [p0.x, p0.y]) : null;
		if (!r) return;
		const op = await s.model.apply(r.patch, t === 'line' ? `draw cut line ${r.id}` : `click cut point ${r.id}`);
		if (op) oncreated?.({ dataset: r.id, pointer: r.pointer, group: (r as { group?: string | null }).group ?? null });
	}
	async function saveQuick() {
		if (!field || g2) return;
		const q = quickViewPatch(pctx(), {
			field: field.name, comp, components: field.components, axisym: !!mesh?.axisym, step: field.step ?? step, nSteps,
			unit: eigen ? '' : disp.unit, rule, log: scaleUser === 'log' && !!map?.logOk, colormap: cmUser, contours, levels: 14, wire: wireUser
		});
		if (!q) return;
		const op = await s.model.apply(q.patch, `save quick view as plot group ${q.id}`);
		if (op) onplot?.(q.id);
	}
	const boundaryLines = $derived.by(() => {
		if (!mesh || mesh.dim !== 2 || mode === 'mesh') return null;
		const f = mesh.facets, npf = f.type === 'line3' ? 3 : 2, n = f.conn.length / npf;
		// deformed outline: x + s u at the nodes (the displacement field is nodal on this mesh)
		const U = mode === 'results' && dfmRef && dfmScale && sol ? dfmRef.data : null;
		const N = U ? mesh.nodes.map((v, i) => v + dfmScale * (i < U.length ? U[i]! : 0)) : mesh.nodes;
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
	// surface of revolution, built in the post worker (audit S2); used only with the mesh it was built from
	let revBuilt = $state.raw<{ mesh: unknown; cut: boolean; surf: RevolvedSurface } | null>(null);
	$effect(() => {
		const m = mesh, cut = cutaway;
		if (!rev || !m) return;
		void s.post.call<'revolve'>({ type: 'revolve', nPhi: 64, cut: cut ? [0, 1.5 * Math.PI] : null }).then((r) => { if (s.mesh === m) revBuilt = { mesh: m, cut, surf: r }; });
	});
	const revSurf = $derived(rev && revBuilt && revBuilt.mesh === mesh ? revBuilt.surf : null);
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
			const ps = plotResult?.step;
			const want = ps === 'last' ? (sol.steps?.values.length ?? 1) - 1 : (ps ?? (v ? v.findIndex((x) => x > 0) : 0));
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
	/** click in Results: one probe-table row at the point (exact FE value, display unit) */
	async function pick2d(p: { x: number; y: number }) {
		const f = field, so = sol;
		if (!probes || mode !== 'results' || !so || !f || !drawable || !m2) return;
		let x = p.x, y = p.y, sg = 1;
		if (mirrored && mirror) {
			const pr = parity ?? [1, 1];
			if (mirror.planes.x && x < 0) { x = -x; sg *= pr[0]; }
			if (mirror.planes.y && y < 0) { y = -y; sg *= pr[1]; }
		}
		const a = disp.a, b = disp.b, label = fieldLabel, unit = valueUnit, L = { unit: lu.unit, f: lu.f }, ds = s.activeLabel, pt = s.active, key = s.datasetKey;
		// probing a dataset pins it: a running sweep no longer switches the display (audit m8)
		s.pinView();
		const v = await probe2d(s.post, f, f.components > 1 ? comp : 0, x, y);
		if (s.solution !== so) return;
		onprobe?.(probes.add({ dim: 2, p: [p.x, p.y, 0], lu: L, field: label, value: v === null ? null : sg * (a * v) + b, unit, dataset: ds, point: pt, run: so.run.startedAt, key }));
	}
	async function pick3d(o: [number, number, number], dir: [number, number, number]) {
		const v3 = shown3d, f = field, so = sol, me = mesh;
		if (!probes || mode !== 'results' || !so || !f || !drawable || !me || me.dim !== 3 || rev || !v3?.surface || !ext) return;
		// hidden surface (slices / isosurfaces only) or a running mode animation (drawn shape moves): no pick
		if (((sliceOn || isoOn) && !clipOn) || playing) return;
		const hit = rayHit(o, dir, v3.surface.pos, v3.surface.disp, deform, clip3);
		if (!hit) return;
		const c0 = ext.c0, P: [number, number, number] = [hit.ref[0] + c0[0], hit.ref[1] + c0[1], hit.ref[2] + c0[2]];
		const a = disp.a, b = disp.b, label = fieldLabel, unit = valueUnit, L = { unit: lu.unit, f: lu.f }, ds = s.activeLabel, pt = s.active, key = s.datasetKey;
		// probing a dataset pins it: a running sweep no longer switches the display (audit m8)
		s.pinView();
		const bb = bbox3(me.nodes);
		const v = await probe3d(so, me, f, f.components > 1 ? comp : 0, P, dir, [bb.c[0]!, bb.c[1]!, bb.c[2]!], bb.diag);
		if (s.solution !== so) return;
		onprobe?.(probes.add({ dim: 3, p: P, lu: L, field: label, value: v === null ? null : a * v + b, unit, dataset: ds, point: pt, run: so.run.startedAt, key }));
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

<div class="gfx" class:stale={stale || invalid.length > 0} role="presentation" onpointerdown={firstTouch}>
	<!-- the stage excludes the colorbar strip: nothing is drawn under the colorbar -->
	<div class="stage" class:bg3={is3d}>
	{#if m2 && !rev}
			<Canvas2D layers={view2d.layers} bbox={frameBox} {frameKey} {padTop} fitKey={fitKey + fit} handles={[...handles, ...lineHandles]} onhandle={handle} onhover={hover} onpick={probes ? pick2d : undefined} onframe={(ms) => (frameMs = ms)} lines={boundaryLines} {hiLines} {markers} flow={flux && !stale && !g2 ? flux : null}
				draw={tool === 'none' ? null : tool} ondraw={drawn} colorLines={g2 && !stale ? (gOver?.lines ?? []) : []} arrows={g2 && !stale ? arrowsShown : null} {guides} />
	{:else if is3d && Canvas3D && shown3d}
		<Canvas3D surface={shown3d.surface} regionColors={shown3d.region ? regionColors : null} edges={shown3d.edges} edgeDisp={shown3d.ed} colormap={shown3d.map?.cm ?? 'viridis'} range={shown3d.range} logScale={shown3d.map?.scale === 'log'} wire={true}
			showSurface={!(sliceOn || isoOn) || clipOn || mode !== 'results'} {deform} clip={clip3} {cuts} phase={eigen && playing && canAnimate ? phase : null} smooth={!rawField} animValue={eigen && (signedField || animAbs)} {animAbs} {half} fitKey={fitKey + fit} onframe={(ms) => (frameMs = ms)} onpick={probes ? pick3d : undefined} marks={probeMarks3} />
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
		{#if s.sweep}
			{@const sw = s.sweep}
			<select class="ds" value={s.active} onchange={(e) => s.selectPoint(Number((e.currentTarget as HTMLSelectElement).value))}
				data-tip={`Dataset: point of parametric study ${sw.studyId} (inner study ${sw.innerId}), ${sw.points.length} points over ${sw.axes.map((a) => a.param).join(', ')}; ${sw.done}/${sw.points.length} done. The plot, colorbar, probes and headline numbers show this point`}>
				{#if s.active < 0 || s.status !== 'solving'}<option value={-1}>{sw.done ? 'base model (spec values)' : 'no dataset yet'}</option>{/if}
				{#each sw.points as p}<option value={p.index} disabled={!p.held && p.status !== 'solved'}>{p.label} ({p.index + 1}/{sw.points.length}){p.status === 'solved' ? (p.held ? '' : ' (re-solve)') : ` ${p.status}`}</option>{/each}
			</select>
		{/if}
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
				{#if cb && !g2}
					<select value={cmUser} data-tip="Colormap. auto: viridis, or the diverging balance map (symmetric about zero) when both signs carry at least 5 % of the range"onchange={(e) => (cmPick = (e.currentTarget as HTMLSelectElement).value as 'auto' | ColormapName)}>
					<option value="auto">auto ({map?.cm ?? 'viridis'})</option>
					{#each COLORMAPS as c}<option value={c}>{c}</option>{/each}
				</select>
			{/if}
		{/if}
			{#if tools && m2 && !rev && (mode === 'results' || mode === 'geometry')}
				<div class="modes">
					<button class:on={tool === 'line'} data-tip="Cut line: press, drag and release on the canvas. Creates a Cut Line dataset{shownExpr ? ` and a 1D plot group with a line graph of ${shownExpr}` : ''} (one operation)" onclick={() => (tool = tool === 'line' ? 'none' : 'line')}>Cut line</button>
					<button class:on={tool === 'point'} data-tip="Cut point: click on the canvas. Creates a Cut Point dataset (one operation)" onclick={() => (tool = tool === 'point' ? 'none' : 'point')}>Cut point</button>
				</div>
			{/if}
			{#if tools && grp}
				<span class="pg" data-tip={`Drawing plot group ${grp.id} (${grp.type}); its items set field, range, colormap and levels. Quick view returns to the toolbar state`}>{grp.id}</span>
				<button data-tip="Back to the quick view (the toolbar state, not in the spec)" onclick={() => onplot?.(null)}>Quick view</button>
			{:else if tools && mode === 'results' && sol && field && drawable}
				<button data-tip="Save the quick view (field, component, step, range rule, colormap, log, contours, wireframe) as a 2D plot group in the spec (one operation)" onclick={saveQuick}>Save as plot group</button>
			{/if}
			{#if mode === 'results' && sol && names.length && !g2}
				{#if names.length > 1}<select value={field?.name} onchange={(e) => (fieldKey = (e.currentTarget as HTMLSelectElement).value)} data-tip="Field">{#each names as n}<option value={n}>{n}</option>{/each}</select>{/if}
			{#if drawable}
				{#if field && field.components > 1}
						<select bind:value={compUser} data-tip="Component">
						<option value={-1}>magnitude</option>
						{#each Array.from({ length: field.components }, (_, i) => i) as i}<option value={i}>{field.name === 'E_rphiz' ? ['r', 'phi', 'z'][i] : i}</option>{/each}
					</select>
				{/if}
				{#if nSteps > 1}
					<select bind:value={step} data-tip={sol.steps ? `${sol.steps.kind} step` : 'step'}>
						{#each Array.from({ length: nSteps }, (_, i) => i) as i}<option value={i}>{sol.steps ? `${fmt(sol.steps.values[i] ?? i)} ${unitLabel(sol.steps.unit)}` : i}</option>{/each}
					</select>
				{/if}
				<select bind:value={ruleUser} data-tip="Colour range rule: full = min to max; robust = area-weighted 1st-99th percentile (values outside saturate). Over the view box when the view has one, else the whole mesh">
					<option value="full">range: full</option>
					<option value="robust">range: p1-99</option>
				</select>
				{#if map?.logOk}<button class:on={scaleUser === 'log'} data-tip="Logarithmic colour scale (the data span more than two decades)"onclick={() => (scalePick = scalePick === 'log' ? 'linear' : 'log')}>log</button>{/if}
				{#if canAnimate}<button class:on={playing} data-tip={eigen ? 'Animate the mode: Re(u e^(i phase)) (Space)' : 'Play the steps (Space)'} onclick={() => (playing = !playing)}>{playing ? 'Pause' : 'Animate'}</button>{/if}
				{#if m2 && !rev}
					{#if field?.space !== 'DG0' || !rawField}<button class:on={contours} data-tip="Contour lines at the colorbar ticks" onclick={() => (contoursUser = !contoursUser)}>Contours</button>{/if}
					<button class:on={rawField} data-tip={`Raw element field: per-cell values flat, nodal values linear between the lattice points. Off: the element basis is evaluated per pixel${field?.space === 'DG0' ? '; per-cell values recovered to the element corners (area-weighted mean within each domain)' : ''}. The probe always shows the exact FE value`} onclick={() => (rawField = !rawField)}>Raw</button>
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
			{#if g2 && mode === 'results' && sol && drawable && m2 && !rev}
				<button class:on={rawField} data-tip="Raw element field (off: the element basis evaluated per pixel). The probe always shows the exact value" onclick={() => (rawField = !rawField)}>Raw</button>
				{#if !compact}<select bind:value={level} data-tip="Smoothing: refined lattice level r">{#each [1, 2, 3, 4, 6] as l}<option value={l}>r {l}</option>{/each}</select>{/if}
			{/if}
			{#if is3d && !rev && mode === 'results' && sol && drawable && mesh?.cells.type === 'tet10'}
			<button class:on={rawField} data-tip="Raw: values linear between the 6 nodes of each exterior tet10 face (4 sub-triangles). Off: the face's P2 basis evaluated per pixel. The colour range is taken over the nodal values" onclick={() => (rawField = !rawField)}>Raw</button>
		{/if}
		{#if is3d && (!compact || rev)}
			{#if rev}<button class:on={cutaway} data-tip="Cutaway: a quarter of the revolved body removed (phi 270 to 360 deg); the two meridional section planes show the field inside (the vertex-averaged P1 projection of the (r, z) Nedelec solution times the azimuthal factor)" onclick={() => (cutaway = !cutaway)}>Cutaway</button>{/if}
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

	{#if g2 && mode === 'results'}
		{@const errs = [...(gErr ? [gErr] : []), ...(gOver?.errors ?? []).map((e) => `${e.id}: ${e.message}`)]}
		{@const notes = [...(gv?.notes ?? []), ...(gv?.deform && !dfmRef ? [`${gv.deform.id}: deformation needs a 2-component nodal vector field reference (e.g. solid.u)`] : []), ...(gDsType !== 'solution' ? [`${g2.id}: dataset ${g2.data} is ${gDsType ?? 'not found'}; only solution datasets are drawn in R2 (cut plane, mirror, join, revolve: stages R4 / R5)`] : []), ...(!m2 ? [`${g2.id}: a 2D plot group is drawn on a 2D mesh only`] : [])]}
		{@const info = [
			...(gOver?.lineRange ? [`line ${gOver.lineRange.expr} on the boundaries: ${fmt(gOver.lineRange.min)} to ${fmt(gOver.lineRange.max)} ${unitLabel(gOver.lineRange.unit)} (own colour range)`] : []),
			...(gOver?.arrowNote ? [gOver.arrowNote] : []),
			...(dfmRef && dfmScale ? [`deformation: x + s ${gv?.deform?.expr}, s = ${fmt(dfmScale)}${gv?.deform?.scale === 'auto' ? ' (auto: 10 % of the bounding-box diagonal over max |u|)' : ''}; the probe, markers and guides use the undeformed positions`] : [])
		]}
		<!-- group notes as chips; the details are in the tooltips -->
		<div class="gnotes">
			{#if errs.length}<span class="crit" data-tip={errs.join('\n')}>{errs.length} not evaluated</span>{/if}
			{#if notes.length}<span class="na" data-tip={notes.join('\n')}>{notes.length} not drawn</span>{/if}
			{#if info.length}<span data-tip={info.join('\n')}>{dfmRef && dfmScale ? `deformed x${fmt(dfmScale)}` : 'info'}</span>{/if}
		</div>
	{/if}
	{#if plot && grp && grp.type === 'plot2d' && grp.enabled === false && tools}<div class="badge co" data-tip="enabled: false: the group is not computed (Enable in the tree)">{grp.id}: disabled</div>{/if}
	{#if plot && grp && grp.type !== 'plot2d' && tools}<div class="badge co" data-tip="3D plot groups are drawn in stage R4; 1D groups in the 1D pane">{grp.id}: {grp.type} not drawn here</div>{/if}
	{#if invalid.length}<div class="badge st" data-tip="The model does not validate; the drawing is the last valid geometry{sol ? ' and result' : ''}">model invalid: earlier geometry</div>
	{:else if stale}<div class="badge st" data-tip="This result was computed for an earlier version of the model; recompute for the current one">stale: earlier spec</div>
	{:else if coarse}<div class="badge co" data-tip="Coarse preview while dragging (mesh sizes x2); the full-resolution run follows on release">coarse preview</div>{/if}

	{#if invalid.length}
		<div class="unav err">
			<div class="crit">Model invalid</div>
			{#each invalid.slice(0, 4) as r}<div>{r}</div>{/each}
			{#if invalid.length > 4}<div class="dim">{invalid.length - 4} more</div>{/if}
			<div class="dim">nothing is computed until the model validates (Undo restores the last valid state)</div>
		</div>
	{:else if mode === 'results' && !sol}
		<div class="unav">
			{#if running}
				<div>computing{longRun ? ` ${fmtMs(now - s.runStart)}` : ''}...</div>
			{:else if s.pointLoading >= 0}
				<div data-tip="Sweep points beyond the displayed one and the most recently used are not held in memory (mesh and solution); their scalars are kept and the field is re-solved on selection">re-solving {s.activeLabel}...</div>
			{:else if s.status === 'unavailable'}
				<div class="na">Results unavailable</div>
				{#each s.reasons as r}<div class="dim">{r}</div>{/each}
				{#if s.caseInfo && !s.useCase && s.reasons.some((r) => /N\/A|no value/.test(r))}
					<button onclick={() => { s.useCase = true; s.requestCompute(); }} data-tip={`Fill N/A material properties with the sourced inputs of eval case ${s.caseInfo.id}:\n${s.caseInfo.materials}`}>use eval case {s.caseInfo.id} values</button>
				{/if}
			{:else if s.status === 'error'}
				<div class="crit">Run failed</div>
				{#each s.error.split('\n').filter(Boolean).slice(0, 4) as r}<div>{r}</div>{/each}
			{:else if s.sweep && s.active < 0 && s.sweep.done}
				<div class="na">Base model (spec values)</div><div class="dim">not a dataset of parametric study {s.sweep.studyId}: pick a dataset, or Compute to run the sweep again</div>
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
		<Colorbar colormap={cb.cm} min={cb.min} max={cb.max} scale={cb.scale} label={cb.label} unit={cb.unit} note={cb.note} rule={mode === 'results' ? (manualRange ? 'manual' : rule) : 'full'} scoped={mode === 'results' && !!rangeBox} levels={'levels' in cb ? ((cb.levels as number[] | undefined) ?? []) : []} />
	{/if}

	<div class="foot mono">
		{#if probe}
			<span data-tip="exact evaluation of the FE field at the cursor (post worker)">x {fmt(probe.x * lu.f)} {unitLabel(lu.unit)}, y {fmt(probe.y * lu.f)} {unitLabel(lu.unit)}</span>
			<span>{probe.dom}</span>
			{#if probe.v !== null}<span>{field?.name ?? ''} = {fmt(probe.v)} {unitLabel(disp.unit)}</span>{/if}
		{/if}
		<span class="sp"></span>
		{#if s.sweep && s.active >= 0}<span class="dst" data-tip={`displayed dataset: point ${s.active + 1} of ${s.sweep.points.length} of parametric study ${s.sweep.studyId}`}>{s.activeLabel}</span>{/if}
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
	.ds { max-width: 260px; border-color: #e0a526; }
	.foot > span.dst { color: #f0c76a; }
	.pg { font: 11px var(--mono); color: var(--ink); background: rgba(57, 135, 229, 0.25); border: 1px solid var(--accent); padding: 0 5px; height: 22px; display: inline-flex; align-items: center; }
	.gnotes { position: absolute; left: 6px; bottom: 22px; display: flex; gap: 3px; font-size: 11px; pointer-events: auto; }
	.gnotes > span { background: rgba(13, 13, 13, 0.85); border: 1px solid var(--border); padding: 0 5px; white-space: nowrap; color: var(--ink-2); }
	.gnotes > span.crit { border-color: var(--crit); color: var(--crit); }
	@media (max-width: 760px) { .gnotes { bottom: 74px; } }
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
	.unav.err { border-color: var(--crit); }
	.unav .crit { font-size: 12px; }
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
