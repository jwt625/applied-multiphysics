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
	import { colormapLut, CYCLIC } from './colormaps';
	import { COMPLEX_PARTS, PART_LABEL, PART_TIP, complexPart, complexVectorValue, groupComplex, instNorm, latticeStats, partLabel, peakAbs, peakAbsVector, wrapPhase, type ComplexPart } from './complex';
	import { notesOf, wave2dOf } from '../engine/protocol';
	import DrivenInset from './DrivenInset.svelte';
	import GfxToolbar from './GfxToolbar.svelte';
	import Tools3D from './Tools3D.svelte';
	import GfxStatus from './GfxStatus.svelte';
	import GfxNotes from './GfxNotes.svelte';
	import GfxFoot from './GfxFoot.svelte';
	import { facetSegments } from './outline2d';
	import { applyCamera, cameraPose, currentPreset, type CameraPreset } from './camera';
	import { boundComponent, componentProblem, decodeView, registerViewState, viewCodeOf, type AxesMode, type ViewState } from './view-link';
	import { fmtEng } from './ticks';
	import { registerViewHooks, type QuickViewInfo, type QuickViewPatch } from '../state/nav.svelte';

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
	/** reversed colormap (2D, 3D, colorbar) */
	let cmRev = $state(false);
	/** part of a complex (driven) field: Re, Im, |.|, phase, Re(u e^(j phi)) (gfx/complex.ts) */
	let part = $state<ComplexPart>('re');
	let partUser = false;
	/** frame axes, scale bar or none (2D) */
	let axes = $state<AxesMode>(untrack(() => (compact ? 'scale' : 'axes')));
	/** driven-solve inset: S-parameters or far field */
	let inset = $state<'none' | 'sparams' | 'farfield' | 'bands'>('none');
	/** preset the 3D camera looks along (null after a free orbit), read from the pose on every rendered frame */
	let camNow = $state<CameraPreset | null>('iso');
	/** height of the (wrapping) toolbar: the inset opens below it */
	let topH = $state(28);
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
	/** `cx`: the Re and Im lattices of a complex field (phase animation) and the largest |u| over them */
	let lat = $state.raw<{ key: string; d: RefinedDisplay; out: LatticeOut; cx?: { re: Float32Array; im: Float32Array; peak: number }; cxv?: { re: Float32Array[]; im: Float32Array[]; peak: number } } | null>(null);
	let psi = $state.raw<{ key: string; d: RefinedDisplay; out: LatticeOut } | null>(null);

	// ---------------------------------------------------------------- plot group (DevLog-027)
	const grp = $derived(plotGroup(s.model.data, plot));
	/** the drawn group: plot2d on a 2D mesh, plot3d on a 3D mesh (same item path; the 3D view draws the surface item) */
	const g2 = $derived((grp?.type === 'plot2d' || grp?.type === 'plot3d') && grp.enabled !== false ? grp : null);
	const g3 = $derived(g2?.type === 'plot3d');
	/** type of the group's dataset: only a solution dataset is drawn here (joins, mirrors, cut planes: stages R4 / R5) */
	const gDsType = $derived(g2 ? (resultsOf(s.model.data).datasets.find((d) => d.id === g2.data)?.type ?? null) : null);
	const gItems = $derived(enabledItems(g2));
	/** the item that sets the colour field: the first surface (in a 3D group also a volume: the 3D view colours its
	 * exterior), else the first contour */
	const gBase = $derived(gItems.find((i) => i.type === 'surface' || (g3 && i.type === 'volume')) ?? gItems.find((i) => i.type === 'contour') ?? null);
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
			surface: b?.type === 'surface' || b?.type === 'volume',
			wire: gItems.some((i) => i.type === 'mesh'),
			deform: gItems.find((i) => i.type === 'deformation') ?? null,
			notes: [
				...gItems.filter((i) => i.type === 'height').map((i) => `${i.id}: height is not drawn (the 2D renderer has no warp)`),
				...gItems.filter((i) => i.type === 'streamline').map((i) => `${i.id}: streamlines are not drawn yet (no tracer for general vector fields; the heat-flux and field-line views are in the quick view)`),
				...gItems.filter((i) => i.type === 'contour' && i !== cont).map((i) => `${i.id}: contour of ${i.expr} differs from the colour field ${b?.expr ?? ''}: not drawn (one colour field per group)`),
				...(g3 ? gItems.filter((i) => !['surface', 'volume', 'mesh', 'deformation'].includes(i.type)).map((i) => `${i.id}: ${i.type} items of a 3D group are not drawn yet (the toolbar's Section, Slice and Iso work on the shown field)`) : []),
				...gItems.filter((i) => (i.type === 'surface' || (g3 && i.type === 'volume')) && i !== b).map((i) => `${i.id}: a second ${i.type} is not drawn (the first one sets the colour field)`)
			]
		};
	});
	/** the phase of a complex vector is drawn per component (a phase of a vector is not defined: magnitude shows
	 *  component 0); |u| and Re(u e^(j phi)) of a vector at magnitude are the norms over the components */
	const comp = $derived.by(() => {
		const c = gv ? gv.comp : pair && pair.re.components > 1 && compUser < 0 && part === 'arg' ? 0 : compUser;
		// bounded by the drawn field's components: an out-of-range index (old link, agent, previous field) never reads
		// the next node's data; it shows the default view instead
		return field ? boundComponent(c, field.components) : c;
	});
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
		// mirrored like the boundary outline (the copies of the displayed symmetric model); line3 through the mid node
		return facetSegments(mesh, { keep: (b) => !!bs[b], copies: copies(null) ?? [{ sx: 1, sy: 1, sign: 1 }] });
	});

	// ---------------------------------------------------------------- field choice
	const fieldList = $derived((sol?.fields ?? []).map((f, i) => ({ f, i })));
	/** field key: `<physics>.<name>` on merged multiphysics solutions (C11 FieldData.physics), else the name */
	const keyOf = (f: FieldData) => (f.physics ? `${f.physics}.${f.name}` : f.name);
	const names = $derived([...new Set(fieldList.map((x) => keyOf(x.f)))]);
	const exprIs = (expr: string | undefined, name: string | undefined) => !!expr && !!name && (expr === name || expr.endsWith(`.${name}`));
	/** the spec's results block (CONTRACTS C10) */
	const resultsSpec = $derived((s.model.data as { results?: unknown } | null)?.results ?? null);
	/** field key a plot expression names: the field itself (`ht.T`) or a component of it (`solid.u.z`) */
	const plotKeyOf = (expr: string | undefined): string | undefined => {
		if (!expr) return undefined;
		const n = names.find((x) => exprIs(expr, x));
		if (n) return n;
		const r = sol ? fieldRef(expr, sol.fields, physIds, !!mesh?.axisym) : null;
		const k = r ? (r.physics ? `${r.physics}.${r.name}` : r.name) : '';
		return names.includes(k) ? k : undefined;
	};
	/** volume items of 3D plot groups (the 3D view colours their exterior; the spec's surfaceItems lists surfaces only) */
	const volumeItems = $derived(resultsOf(s.model.data).plots.filter((p) => p.type === 'plot3d' && p.enabled !== false)
		.flatMap((p) => enabledItems(p).filter((i) => i.type === 'volume' && typeof i.expr === 'string').map((i) => ({ expr: String(i.expr), step: singleStep(i.steps ?? p.steps) }))));
	/** the spec's own 2D / 3D surface or 3D volume plot names the field to open on (audit M6) */
	const plotResult = $derived([...surfaceItems(resultsSpec), ...volumeItems].find((r) => plotKeyOf(r.expr) !== undefined) ?? null);
	/** a field with one value everywhere (e.g. a prescribed uniform temperature driving a thermal-expansion load) */
	const constantField = (f: FieldData | undefined) => { if (!f) return true; const d = f.data; for (let i = 1; i < d.length; i++) if (d[i] !== d[0]) return false; return true; };
	const drawableSpace = (f: FieldData | null | undefined) => !!f && (f.space === 'H1P1' || f.space === 'H1P2' || f.space === 'DG0');
	// complex (driven) fields: one selector entry per `<u>_re` / `<u>_im` pair, shown as the chosen part (gfx/complex.ts)
	const cx = $derived(groupComplex(names));
	const memberOf = (k: string): string | null => { for (const g of cx.groups.values()) if (k === g.re || k === g.im || k === g.abs) return g.key; return null; };
	/** selector entry: a field key, or a complex group key */
	const entryKey = $derived.by(() => {
		if (!names.length) return '';
		if (fieldKey && cx.entries.includes(fieldKey)) return fieldKey;
		if (fieldKey && names.includes(fieldKey)) return memberOf(fieldKey) ?? fieldKey;
		// no plot in the spec: the first drawable field that varies over the mesh, else the first drawable one
		const fOf = (x: string) => fieldList.find((y) => keyOf(y.f) === x)?.f;
		const n = plotKeyOf(plotResult?.expr) ?? names.find((x) => drawableSpace(fOf(x)) && !constantField(fOf(x))) ?? names.find((x) => drawableSpace(fOf(x))) ?? names[0]!;
		return memberOf(n) ?? n;
	});
	const cxGroup = $derived(g2 ? null : (cx.groups.get(entryKey) ?? null));
	/** components of a selector entry (a field key or a complex group key; 0 when unknown) */
	const componentsOf = (key: string): number => {
		const g = cx.groups.get(key);
		const k = g ? g.re : key;
		return fieldList.find((x) => keyOf(x.f) === k)?.f.components ?? 0;
	};
	/** selector entry of a field key or entry key (as entryKey resolves fieldKey) */
	const entryOf = (k: string): string => (cx.entries.includes(k) ? k : (memberOf(k) ?? k));
	/** entry the user's component belongs to: the component resets to the default when another field is shown
	 * ('' = not bound yet: a component from the link waits for the first field) */
	let compEntry = '';
	$effect(() => {
		const k = entryKey;
		if (!k) return;
		untrack(() => {
			if (compEntry && compEntry !== k) compUser = -1;
			compEntry = k;
		});
	});
	const stepsOf = (key: string) => fieldList.filter((x) => keyOf(x.f) === key).map((x) => x.f);
	/** the Re / Im pair of the shown step */
	const pair = $derived.by(() => {
		if (!cxGroup) return null;
		const R = stepsOf(cxGroup.re), I = stepsOf(cxGroup.im);
		const re = R[Math.min(step, R.length - 1)] ?? R[0];
		const im = re ? (I.find((f) => (f.step ?? 0) === (re.step ?? 0)) ?? I[Math.min(step, I.length - 1)]) : undefined;
		return re && im && re.data.length === im.data.length ? { re, im, n: R.length, base: re.name.slice(0, -3) } : null;
	});
	/** parts drawn from two lattices (Re, Im) combined at the lattice points: exact there, linear in between */
	const cxLat = $derived(!!pair && (part === 'abs' || part === 'arg' || part === 'inst'));
	/** phase of the shown static field: during the phase animation the drawing combines the lattices per frame instead */
	const phaseStatic = $derived(part === 'inst' && playing ? 0 : phase);
	/** the shown complex part as a field on the same basis (Re, Im: the solution's own; others: nodal combination) */
	const cxField = $derived.by((): FieldData | null => {
		const P = pair;
		if (!P) return null;
		if (part === 're') return P.re;
		if (part === 'im') return P.im;
		// a combination of Re and Im: Re's element values (elementNodal) do not describe it, so they are left out
		const { elementNodal: _el, ...re } = P.re;
		return { ...re, name: P.base, unit: part === 'arg' ? 'rad' : P.re.unit, data: complexPart(P.re.data, P.im.data, part, part === 'inst' ? phaseStatic : 0) };
	});
	const field = $derived.by((): FieldData | null => {
		if (!fieldList.length) return null;
		if (g2) {
			if (!gBase || gDsType !== 'solution') return null;
			if (!gRef) return gNodal && gNodal.key === gKey && gNodal.meshHash === mesh?.hash ? gNodal.f : null;
			const st = fieldList.filter((x) => x.f.name === gRef.name && (gRef.physics === undefined || x.f.physics === gRef.physics));
			const k = gStep === 'last' ? st.length - 1 : typeof gStep === 'number' ? gStep : step;
			return (st[Math.min(k, st.length - 1)] ?? st[0])?.f ?? null;
		}
		if (cxGroup) return cxField;
		const steps = fieldList.filter((x) => keyOf(x.f) === entryKey);
		return (steps[Math.min(step, steps.length - 1)] ?? steps[0])?.f ?? null;
	});
	const nSteps = $derived(pair ? pair.n : field ? fieldList.filter((x) => keyOf(x.f) === keyOf(field)).length : 0);
	/** frequency steps of a driven solve are labelled with an engineering prefix */
	const stepLabel = (i: number) => {
		const st = sol?.steps;
		if (!st) return String(i);
		const v = st.values[i] ?? i;
		// band studies: the path point and band of the field step
		const fs = wave?.bands?.fieldSteps?.find((x) => x.step === i);
		const pre = fs ? `${fs.label} band ${fs.band + 1}: ` : '';
		if (st.kind === 'freq' || st.unit === 'Hz') { const e = fmtEng(v, st.unit ?? 'Hz', 4); return `${pre}${e.num} ${e.unit}`; }
		return `${pre}${fmt(v)} ${unitLabel(st.unit)}`;
	};
	const wave = $derived(sol ? wave2dOf(sol) : null);
	const hasS = $derived(!!wave?.perFrequency.some((p) => p.S && p.S.keys.length));
	const hasFF = $derived(!!wave?.perFrequency.some((p) => p.farField && p.farField.phi.length));
	const hasBands = $derived(!!wave?.bands?.distance.length);
	const solverNotes = $derived(sol ? notesOf(sol) : []);
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
		const u = resultUnits(resultsSpec).find((r) => exprIs(r.expr, field ? keyOf(field) : undefined))?.unit ?? field?.unit;
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
	/** a field as the post worker takes it; the producer's element values at the element nodes (FieldData.elementNodal,
	 *  lane G2 DevLog-059 R3) ride along, so the worker shows per-domain values at material interfaces (field2d.ts
	 *  withPerDomain); a field without them is sent exactly as before */
	const postField = (g: FieldData, components = g.components) => ({ space: g.space as Space, data: g.data, components, ...(g.elementNodal ? { elementNodal: g.elementNodal } : {}), ...(g.cellGroup ? { cellGroup: g.cellGroup } : {}) });
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
	const fkey = $derived(field && m2 ? `${m2.nT}:${sol?.run.startedAt}:${keyOf(field)}:${field.step ?? 0}:${comp}:${lv}:${rule}:${disp.a}:${rangeBox?.join(',')}:${rawField}:${gNodal?.key ?? ''}:${pair ? (cxLat ? `cx:${part}` : `${part}`) : ''}` : '');
	$effect(() => {
		const f = field, m = m2, key = fkey;
		if (!f || !m || mode !== 'results' || !drawable) return;
		const r = f.space === 'DG0' && rawField ? 1 : lv;
		// plain copies: $state proxies cannot be posted to a worker
		const a = disp.a, b = disp.b, c = f.components > 1 ? comp : 0, rl = rule, fc: [number, number, number, number] | null = rangeBox ? [rangeBox[0], rangeBox[1], rangeBox[2], rangeBox[3]] : null;
		const P = pair, pt = part;
		if (cxLat && P) {
			// |u|, arg u, Re(u e^(j phi)): the exact Re and Im values at the lattice points, interpolated linearly and combined
			// per fragment by the renderer (Layer2D.complex); the phase is a uniform, so the animation uploads nothing.
			// Colour range and peak from the combination at the lattice points (inst: +-max |u|, phase independent)
			if (lat?.key === key && (lat.cx || lat.cxv)) return;
			const one = (g: FieldData, k = c) => s.post.call<'lattice'>({ type: 'lattice', field: postField(g), comp: k, r: lv, a: pt === 'arg' ? 1 : a, b: 0, psi: false, rule: 'full', focus: null, smooth: false });
			if (pt === 'inst' && c < 0 && P.re.components > 1) {
				// Re(u e^(j phi)) of a vector at magnitude: per-component Re and Im lattices, the norm combined per frame
				const ks = Array.from({ length: P.re.components }, (_, k) => k);
				void Promise.all([s.post.display(lv), Promise.all(ks.map((k) => one(P.re, k))), Promise.all(ks.map((k) => one(P.im, k)))]).then(([d, A, B]) => {
					if (s.m2 !== m || fkey !== key) return;
					const re = A.map((x) => x.values), im = B.map((x) => x.values), pk = peakAbsVector(re, im);
					const vals = instNorm(re, im, phase), st = latticeStats(vals, d.pos, d.c0, fc, rl);
					lat = { key, d, out: { values: vals, lo: 0, hi: pk, dataLo: st.dataLo, dataHi: st.dataHi, peak: null, ms: A.reduce((t, x) => t + x.ms, 0) + B.reduce((t, x) => t + x.ms, 0), coef: null }, cxv: { re, im, peak: pk } };
				});
				return;
			}
			void Promise.all([s.post.display(lv), one(P.re), one(P.im)]).then(([d, A, B]) => {
				if (s.m2 !== m || fkey !== key) return;
				const pk = peakAbs(A.values, B.values);
				const vals = Float32Array.from(complexPart(A.values, B.values, pt === 'inst' ? 'abs' : pt));
				const st = latticeStats(vals, d.pos, d.c0, fc, rl);
				lat = { key, d, out: { values: vals, lo: pt === 'inst' ? -pk : st.lo, hi: pt === 'inst' ? pk : st.hi, dataLo: st.dataLo, dataHi: st.dataHi, peak: pt === 'inst' ? null : st.peak, ms: A.ms + B.ms, coef: null }, cx: { re: A.values, im: B.values, peak: pk } };
			});
			return;
		}
		void Promise.all([s.post.display(r), s.post.call<'lattice'>({ type: 'lattice', field: postField(f), comp: c, r, a, b, psi: false, rule: rl, focus: fc, smooth: !rawField })])
			.then(([d, out]) => { if (s.m2 === m && fkey === key) lat = { key, d, out }; });
	});
	// deformation attribute (plot2d group): the displacement field (a vector field reference) at the lattice points and
	// the mesh nodes, scaled; the display positions move, the per-pixel field evaluation (barycentric) does not change
	const dfmRef = $derived.by(() => {
		const e = typeof gv?.deform?.expr === 'string' ? gv.deform.expr.trim() : '';
		const m = /^([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(e);
		if (!m || !sol || !physIds.includes(m[1]!)) return null;
		const fs = sol.fields.filter((f) => f.name === m[2] && (f.physics === undefined || f.physics === m[1]) && f.components === 2 && (f.space === 'H1P1' || f.space === 'H1P2'));
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
		void Promise.all([s.post.display(r), s.post.call<'lattice'>({ type: 'lattice', field: postField(f, 1), comp: 0, r, a: 1, b: 0, psi: true, rule: 'full', focus: null })])
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
			return { ...none, map: mp, layers: [{ kind: 'surface', disp: d1, values: perElement(q), range: mp.range, colormap: cmUser === 'auto' ? 'viridis' : cmUser, reverse: cmRev, wire: true } as Layer2D], cb: { ...mp.range, label: 'element shape quality q = 4 sqrt(3) A / sum(l^2), 1 = equilateral', unit: '1', cm: cmUser === 'auto' ? 'viridis' : cmUser, scale: 'linear' as ScaleMode, note: '' } };
		}
		const L = lat!;
		// phase animation of a complex field: Re(u e^(j phi)) combined per frame from the Re / Im lattices, range +-max |u|
		const inst = !!L.cx && part === 'inst';
		// complex parts: Re and Im lattices combined per fragment (renderer2d), the phase as a uniform
		const cxl = L.cx && (part === 'abs' || part === 'arg' || part === 'inst') ? { values: L.cx.re, values2: L.cx.im, complex: { mode: part, phase }, coef: null } : null;
		// a complex vector at magnitude, Re(u e^(j phi)): norm over the components combined on the CPU per frame, range 0..max |u|
		const vecInst = !!L.cxv && part === 'inst';
		const vals = vecInst ? instNorm(L.cxv!.re, L.cxv!.im, phase) : L.out.values;
		// odd fields mirrored with both signs: the range covers the reflected values too
		let lo = inst ? -L.cx!.peak : vecInst ? 0 : L.out.lo, hi = inst ? L.cx!.peak : vecInst ? L.cxv!.peak : L.out.hi;
		const cp = copies(parity);
		if (cp?.some((c) => c.sign < 0)) { const m = Math.max(Math.abs(lo), Math.abs(hi)); lo = -m; hi = m; }
		const mp0 = mapping(lo, hi);
		// phase: fixed -pi..pi on a cyclic map
		const mp = L.cx && part === 'arg' ? { range: { min: -Math.PI, max: Math.PI }, both: true, logOk: false, scale: 'linear' as ScaleMode, cm: (cmUser !== 'auto' ? cmUser : 'twilight') as ColormapName } : mp0;
		const levels = contours && (field!.space !== 'DG0' || !rawField) && mp.scale !== 'log' ? (contourLevels(mp.range) ?? niceTicks(mp.range.min, mp.range.max, 14)) : [];
		const D = dfmRef ? deformed(L.d) : L.d;
		const layers: Layer2D[] = gv && !gv.surface ? [{ kind: 'region', disp: dfmRef ? deformed(d1) : d1, regionColors: domains.map(() => '#262624'), wire, mirror: cp } as Layer2D]
			: [{ kind: 'surface', disp: D, values: vals, coef: L.out.coef, range: mp.range, scale: mp.scale, colormap: mp.cm, reverse: cmRev, wire, mirror: cp, ...cxl }];
		const cColor = gv?.contour ? (gv.contour.color === 'colormap' || !gv.surface ? null : '#0d0d0d') : '#0d0d0d';
		if (levels.length) layers.push({ kind: 'contour', disp: D, values: vals, coef: L.out.coef, range: mp.range, scale: mp.scale, colormap: mp.cm, reverse: cmRev, levels, uniform: cColor, opacity: cColor ? 0.5 : 1, mirror: cp, ...cxl });
		const bp = band && bandOn && field!.name === band.field ? probePts.find((q) => q.id === band.probe) : undefined;
		if (bp && mp.scale !== 'log') layers.push({ kind: 'contour', disp: L.d, values: L.out.values, coef: L.out.coef, range: mp.range, scale: mp.scale, colormap: mp.cm, levels: [Math.abs(bp.v) * (1 - band!.rel), Math.abs(bp.v) * (1 + band!.rel)], uniform: '#e0a526', opacity: 1, mirror: cp });
		if (psi && fieldLines) {
			// r A_phi is even across the axis: the mirrored lines are the reflected contours
			const P = psi.out, n = 22, pl = Array.from({ length: n }, (_, i) => P.dataLo + ((i + 0.5) * (P.dataHi - P.dataLo)) / n);
			layers.push({ kind: 'contour', disp: psi.d, values: P.values, coef: P.coef, range: { min: P.dataLo, max: P.dataHi }, colormap: mp.cm, levels: pl, uniform: '#f2f1ec', opacity: 0.8, mirror: copies([1, 1]) });
		}
		const label = g2 && gBase ? `${gBase.label ?? gBase.expr}` : pair ? fieldLabel : field!.name + (field!.components > 1 ? (comp < 0 ? ' magnitude' : ` component ${comp}`) : '');
		const cxNote = L.cx ? `${PART_TIP[part]}; Re and Im are the exact values at the refined lattice points, interpolated linearly and combined per pixel${inst ? `; colour range ±max |${pair?.base ?? ''}| over the mesh (fixed while the phase moves)` : ''}`
			: vecInst ? `${PART_TIP[part]}; magnitude = norm over the components of Re(u_k e^(jφ)), from the exact Re and Im of each component at the refined lattice points (interpolated linearly between them); colour range 0 to max |${pair?.base ?? ''}| over the mesh (fixed while the phase moves)` : '';
		return { layers, map: mp, peak: L.out.peak, peakCell: !!L.out.peakCell, cb: { ...mp.range, label, unit: disp.unit, cm: mp.cm, scale: mp.scale, note: [disp.note, cxNote, L.out.peakCell && L.out.coef ? `drawn smoothed: ${L.out.coef.note}; colorbar ends and peak marker are the exact per-cell values (Raw draws the cells)` : ''].filter(Boolean).join('. '), levels } };
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
	const fieldLabel = $derived(field ? (pair ? partLabel(part, pair.base) : field.name) + (field.components > 1 ? (comp < 0 ? ' magnitude' : ` component ${field.name === 'E_rphiz' ? ['r', 'phi', 'z'][comp] : comp}`) : '') : '');
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
		if (!g || !so || !m2 || g.type !== 'plot2d' || mode !== 'results' || gDsType !== 'solution' || !gItems.some((i) => ['maxmin', 'point', 'line', 'arrow'].includes(i.type))) { gOver = null; return; }
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
		if (!field || eigen || !exprName) return null;
		const ph = field.physics ?? physIds[0] ?? '';
		return componentExpr(ph, exprName, field.components > 1 ? comp : -1, field.components, !!mesh?.axisym);
	});
	/** solution field name of the shown quantity (complex parts: Re, Im and |.| are fields; phase and Re(u e^(j phi)) are not) */
	const exprName = $derived(!field ? null : !pair ? field.name : part === 're' ? pair.re.name : part === 'im' ? pair.im.name : part === 'abs' && cxGroup?.abs ? `${pair.base}_abs` : null);
	async function drawn(p0: { x: number; y: number }, p1: { x: number; y: number } | null) {
		const t = tool;
		tool = 'none';
		const r = t === 'line' && p1 ? cutLinePatch(pctx(), [p0.x, p0.y], [p1.x, p1.y], shownExpr) : t === 'point' ? cutPointPatch(pctx(), [p0.x, p0.y]) : null;
		if (!r) return;
		const op = await s.model.apply(r.patch, t === 'line' ? `draw cut line ${r.id}` : `click cut point ${r.id}`);
		if (op) oncreated?.({ dataset: r.id, pointer: r.pointer, group: (r as { group?: string | null }).group ?? null });
	}
	async function saveQuick() {
		if (!field || g2 || !exprName) return;
		const q = quickViewPatch(pctx(), {
			field: exprName, comp, components: field.components, axisym: !!mesh?.axisym, step: field.step ?? step, nSteps,
			unit: eigen ? '' : disp.unit, rule, log: scaleUser === 'log' && !!map?.logOk, colormap: cmUser, contours, levels: 14, wire: wireUser
		});
		if (!q) return;
		const op = await s.model.apply(q.patch, `save quick view as plot group ${q.id}`);
		if (op) onplot?.(q.id);
	}
	const boundaryLines = $derived.by(() => {
		if (!mesh || mesh.dim !== 2 || mode === 'mesh') return null;
		// deformed outline: x + s u at the nodes (the displacement field is nodal on this mesh)
		const U = mode === 'results' && dfmRef && dfmScale && sol ? dfmRef.data : null;
		const N = U ? mesh.nodes.map((v, i) => v + dfmScale * (i < U.length ? U[i]! : 0)) : mesh.nodes;
		const tol = 1e-9 * (m2 ? Math.max(m2.bbox[2] - m2.bbox[0], m2.bbox[3] - m2.bbox[1]) : 1);
		// facets on a symmetry plane are interior lines of the mirrored model
		return facetSegments(mesh, { nodes: N, copies: copies(null) ?? [{ sx: 1, sy: 1, sign: 1 }], skipPlanes: mirror?.planes ?? null, tol });
	});

	/** inner edge of the PML of a driven solve (dashed; the PML lies between it and the outer boundary) */
	const pmlBoxes = $derived.by(() => {
		const P = wave?.pml;
		if (!P || !m2 || mode === 'mesh') return [];
		const fmtL = (v: number) => `${fmt(v * lu.f, 4)}`;
		return [{ ...P.inner, label: 'PML', tip: `Perfectly matched layer: between this box and the outer boundary (complex coordinate stretching; the field there is not physical). Inner box x ${fmtL(P.inner.x0)} to ${fmtL(P.inner.x1)}, y ${fmtL(P.inner.y0)} to ${fmtL(P.inner.y1)} ${unitLabel(lu.unit)}` }];
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
	const canAnimate = $derived(drawable && ((eigen && (signedField || !!dispField || animAbs)) || !!pair || (!eigen && nSteps > 1)));
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
			label = g2 && gBase ? `${gBase.label ?? gBase.expr}` : field.name;
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
			// a link's step wins once, on the first solution (view state in the link)
			if (first && linkStep !== null && linkStep < (sol.steps?.values.length ?? 1)) { step = linkStep; linkStep = null; }
			else {
				const v = sol.steps?.kind === 'eigen' ? sol.steps.values : null;
				const ps = plotResult?.step;
				const want = ps === 'last' ? (sol.steps?.values.length ?? 1) - 1 : (ps ?? (v ? v.findIndex((x) => x > 0) : 0));
				step = want > 0 ? want : 0;
			}
			// a complex field opens on the part the spec's plot names (`<u>_abs` -> |.|), unless the user chose one
			if (!partUser) {
				const e = plotResult?.expr ?? '';
				part = /_abs$/.test(e) ? 'abs' : /_im$/.test(e) ? 'im' : 're';
			}
		}
	});

	// ---------------------------------------------------------------- view state in the link (gfx/view-link.ts)
	let linkStep: number | null = null;
	function applyView(v: ViewState) {
		if (v.mode) mode = v.mode;
		if (v.field) fieldKey = v.field;
		if (v.part) { part = v.part; partUser = true; }
		// the link's component belongs to the link's field (or the shown one; '' = the first field drawn)
		if (v.comp !== undefined) { compUser = v.comp; compEntry = v.field ? (names.length ? entryOf(v.field) : '') : entryKey; }
		if (v.step !== undefined) linkStep = v.step;
		if (v.phase !== undefined) phase = v.phase;
		if (v.cm) cmPick = v.cm;
		if (v.reverse !== undefined) cmRev = v.reverse;
		if (v.rule) ruleUser = v.rule;
		if (v.log !== undefined) scalePick = v.log ? 'log' : 'linear';
		if (v.axes) axes = v.axes;
		if (v.cam) applyCamera(v.cam);
	}
	function viewState(): ViewState {
		const cam = is3d ? cameraPose() : null;
		return {
			mode, ...(fieldKey || entryKey ? { field: fieldKey || entryKey } : {}), ...(pair ? { part } : {}), ...(compUser !== -1 ? { comp: compUser } : {}),
			...(nSteps > 1 ? { step } : {}), ...(pair && part === 'inst' ? { phase: wrapPhase(phase) } : {}), ...(cmPick !== 'auto' ? { cm: cmPick } : {}),
			...(cmRev ? { reverse: true } : {}), ...(ruleUser !== 'full' ? { rule: ruleUser } : {}), ...(scalePick === 'log' ? { log: true } : {}),
			...(axes !== (compact ? 'scale' : 'axes') ? { axes } : {}), ...(cam ? { cam } : {})
		};
	}
	// agent probe and quick-view tools (lane E7 request R1): this view's probe table, a probe at a point, the quick view
	$effect(() => {
		if (!probes) return;
		const P = probes;
		return registerViewHooks({
			probes: P,
			probeAt: async (p) => {
				if (mode !== 'results') return { row: null, message: 'switch to the results view first' };
				if (!sol || !field || !drawable) return { row: null, message: 'no field is drawn' };
				const n0 = P.rows.length;
				if (m2) await pick2d({ x: p[0], y: p[1] });
				else return { row: null, message: '3D probe at a point: not wired (needs probe3d at p with any ray direction)' };
				return P.rows.length > n0 ? { row: P.rows.at(-1)! } : { row: null, message: 'the solution changed while probing' };
			},
			quickView: (): QuickViewInfo | null => (mode !== 'results' || !sol || !names.length) ? null : {
				field: field ? (pair ? entryKey : keyOf(field)) : null, fields: [...cx.entries],
				component: field && field.components > 1 ? boundComponent(compUser, field.components) : null,
				components: field && field.components > 1 ? Array.from({ length: field.components }, (_, i) => (field!.name === 'E_rphiz' ? ['r', 'phi', 'z'][i]! : String(i))) : [],
				colormap: cmPick, colormaps: [...COLORMAPS], range: ruleUser === 'robust' ? 'p1-99' : 'full',
				log: scalePick === 'log', logAvailable: !!map?.logOk, contours: contoursUser, wire: wireUser, plotGroup: grp?.id ?? null
			},
			setQuickView: (q: QuickViewPatch) => {
				if (q.field !== undefined && !names.includes(q.field) && !cx.entries.includes(q.field)) return { ok: false, message: `no field ${q.field}` };
				if (q.colormap !== undefined && q.colormap !== 'auto' && !(COLORMAPS as readonly string[]).includes(q.colormap)) return { ok: false, message: `no colormap ${q.colormap}` };
				// the component is checked against the field it will apply to (the requested one, else the shown one)
				const target = q.field !== undefined ? entryOf(q.field) : entryKey;
				if (q.component !== undefined) {
					const why = componentProblem(q.component, componentsOf(target), target);
					if (why) return { ok: false, message: why };
				}
				if (q.field !== undefined) fieldKey = q.field;
				if (q.component !== undefined) { compUser = q.component; compEntry = target; }
				if (q.colormap !== undefined) cmPick = q.colormap as 'auto' | ColormapName;
				if (q.range !== undefined) ruleUser = q.range === 'p1-99' ? 'robust' : 'full';
				if (q.log !== undefined) scalePick = q.log ? 'log' : 'linear';
				if (q.contours !== undefined) contoursUser = q.contours;
				if (q.wire !== undefined) wireUser = q.wire;
				return { ok: true, ...(grp ? { message: `plot group ${grp.id} is drawn; the quick view applies after returning to it` } : {}) };
			}
		});
	});
	onMount(() => {
		const code = typeof location !== 'undefined' ? viewCodeOf(location.hash) : null;
		if (code) applyView(decodeView(code));
		return registerViewState(viewState);
	});

	onMount(() => {
		let raf = 0, last = performance.now();
		const tick = (t: number) => {
			raf = requestAnimationFrame(tick);
			if (s.status === 'solving') now = t;
			if (!playing) { last = t; return; }
			const dt = (t - last) / 1000;
			last = t;
			if (eigen || nSteps <= 1 || pair) phase = (phase + dt * 2 * Math.PI * 0.5) % (2 * Math.PI);
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
			else if (k === ' ' && canAnimate) { e.preventDefault(); if (pair && part !== 'inst') part = 'inst'; playing = !playing; }
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
		const P = cxLat ? pair : null, pt = part, ph = phase, c = field && field.components > 1 ? comp : 0, pk = pairKey;
		s.post.probe(x, y, (h) => {
			if (!h.hit || !P) { hoverTok++; probe = h.hit ? { x: p.x, y: p.y, v: h.hit.value === null ? null : sg * (a * h.hit.value) + b, dom: domains[h.hit.domain]?.id ?? String(h.hit.domain) } : null; return; }
			// |u|, phase, Re(u e^(j phi)): exact Re and Im of every component at the point from the pair resident in the
			// post worker (set once per pair and step), combined as the renderer does
			const dom = domains[h.hit.domain]?.id ?? String(h.hit.domain), t = ++hoverTok;
			if (h.hit.cx && h.hit.cx.key === pk) { probe = { x: p.x, y: p.y, v: complexVectorValue(h.hit.cx.re, h.hit.cx.im, c, pt, ph, sg, a, b), dom }; return; }
			// the worker's pair is not the shown one yet (step just changed): the exact path, once
			void complexAt(P, c, x, y).then(([re, im]) => {
				if (t === hoverTok) probe = { x: p.x, y: p.y, v: complexVectorValue(re, im, c, pt, ph, sg, a, b), dom };
			});
		});
	}
	let hoverTok = 0;
	/** Re and Im per component at a 2D point (post worker `evalAt`, posts the fields): component c, or all for c < 0 */
	async function complexAt(P: { re: FieldData; im: FieldData }, c: number, x: number, y: number): Promise<[Array<number | null>, Array<number | null>]> {
		const nc = P.re.components, ks = c >= 0 ? [c] : Array.from({ length: nc }, (_, k) => k);
		const re: Array<number | null> = Array.from({ length: nc }, () => null), im = re.slice();
		const v = await Promise.all(ks.flatMap((k) => [probe2d(s.post, P.re, k, x, y), probe2d(s.post, P.im, k, x, y)]));
		ks.forEach((k, j) => { re[k] = v[2 * j]!; im[k] = v[2 * j + 1]!; });
		return [re, im];
	}
	/** identity of the complex pair last sent to the post worker (the hover uses the worker's values only for this one) */
	let pairKey = 0;
	$effect(() => {
		if (!m2) return;
		const P = mode === 'results' && drawable && cxLat ? pair : null;
		const k = ++pairKey;
		s.post.setPair(k, P ? { re: postField(P.re), im: postField(P.im) } : null);
	});
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
		const P = cxLat ? pair : null, c = f.components > 1 ? comp : 0, pt0 = part, ph0 = phase;
		// complex |u|, phase, Re(u e^(j phi)): exact Re and Im at the point, combined
		const value = P ? complexVectorValue(...(await complexAt(P, c, x, y)), c, pt0, ph0, sg, a, b)
			: await probe2d(s.post, f, c, x, y).then((v) => (v === null ? null : sg * (a * v) + b));
		if (s.solution !== so) return;
		onprobe?.(probes.add({ dim: 2, p: [p.x, p.y, 0], lu: L, field: label, value, unit, dataset: ds, point: pt, run: so.run.startedAt, key }));
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
		if (mode === 'results' && field && drawable) s.post.setField({ ...postField(field), comp: field.components > 1 ? comp : 0 });
		else s.post.setField(null);
	});

	const running = $derived(s.status === 'solving');
	const longRun = $derived(running && s.runStart > 0 && now - s.runStart > 1000);
	const cb = $derived(m2 && !rev ? view2d.cb : (shown3d?.cb ?? null));
	const map = $derived(m2 && !rev ? view2d.map : (shown3d?.map ?? null));
	const meshChanged = $derived(!!s.solution && !!mesh && s.solution.meshHash !== mesh.hash);
	/** plot-group chips: items not evaluated, not drawn, and group info */
	const groupChips = $derived.by(() => {
		if (!g2) return { errs: [] as string[], notes: [] as string[], info: [] as string[] };
		return {
			errs: [...(gErr ? [gErr] : []), ...(gOver?.errors ?? []).map((e) => `${e.id}: ${e.message}`)],
			notes: [...(gv?.notes ?? []), ...(gv?.deform && !dfmRef && !g3 ? [`${gv.deform.id}: deformation needs a 2-component nodal vector field reference (e.g. solid.u)`] : []), ...(gDsType !== 'solution' ? [`${g2.id}: dataset ${g2.data} is ${gDsType ?? 'not found'}; only solution datasets are drawn (cut plane, mirror, join and revolve datasets are not drawn yet)`] : []), ...(!m2 && !g3 ? [`${g2.id}: a 2D plot group is drawn on a 2D mesh only`] : []), ...(g3 && mesh?.dim !== 3 ? [`${g2.id}: a 3D plot group is drawn on a 3D mesh only`] : [])],
			info: [
				...(gOver?.lineRange ? [`line ${gOver.lineRange.expr} on the boundaries: ${fmt(gOver.lineRange.min)} to ${fmt(gOver.lineRange.max)} ${unitLabel(gOver.lineRange.unit)} (own colour range)`] : []),
				...(gOver?.arrowNote ? [gOver.arrowNote] : []),
				...(dfmRef && dfmScale ? [`deformation: x + s ${gv?.deform?.expr}, s = ${fmt(dfmScale)}${gv?.deform?.scale === 'auto' ? ' (auto: 10 % of the bounding-box diagonal over max |u|)' : ''}; the probe, markers and guides use the undeformed positions`] : [])
			]
		};
	});
</script>

<div class="gfx" class:stale={stale || invalid.length > 0} role="presentation" onpointerdown={firstTouch}>
	<!-- the stage excludes the colorbar strip: nothing is drawn under the colorbar -->
	<div class="stage" class:bg3={is3d}>
	{#if m2 && !rev}
			<Canvas2D layers={view2d.layers} bbox={frameBox} {frameKey} {padTop} fitKey={fitKey + fit} handles={[...handles, ...lineHandles]} onhandle={handle} onhover={hover} onpick={probes ? pick2d : undefined} onframe={(ms) => (frameMs = ms)} lines={boundaryLines} {hiLines} {markers} flow={flux && !stale && !g2 ? flux : null}
				draw={tool === 'none' ? null : tool} ondraw={drawn} colorLines={g2 && !stale ? (gOver?.lines ?? []) : []} arrows={g2 && !stale ? arrowsShown : null} {guides}
				axes={mode === 'mesh' && axes === 'axes' ? 'scale' : axes} axesBox={fullBox} axisNames={mesh?.axisym ? ['r', 'z'] : ['x', 'y']} {lu} boxes={pmlBoxes} />
	{:else if is3d && Canvas3D && shown3d}
		<Canvas3D surface={shown3d.surface} regionColors={shown3d.region ? regionColors : null} edges={shown3d.edges} edgeDisp={shown3d.ed} colormap={shown3d.map?.cm ?? 'viridis'} reverse={cmRev} origin={revSurf ? revSurf.c0 : (ext?.c0 ?? [0, 0, 0])} range={shown3d.range} logScale={shown3d.map?.scale === 'log'} wire={true}
			showSurface={!(sliceOn || isoOn) || clipOn || mode !== 'results'} {deform} clip={clip3} {cuts} phase={eigen && playing && canAnimate ? phase : null} smooth={!rawField} animValue={eigen && (signedField || animAbs)} {animAbs} {half} fitKey={fitKey + fit} onframe={(ms) => { frameMs = ms; camNow = currentPreset(); }} onpick={probes ? pick3d : undefined} marks={probeMarks3} />
	{:else}
		<div class="empty dim">{s.status === 'meshing' ? 'Meshing...' : s.status === 'error' ? 'No mesh: see Messages' : 'No mesh yet'}</div>
	{/if}
	</div>
	{#if longRun}<div class="prog" data-tip={`${s.progress?.stage ?? 'run'} ${s.progress?.msg ?? ''}`}><span style="width: {Math.round(100 * (s.progress?.frac ?? 0))}%" class:ind={!s.progress || s.progress.frac <= 0 || s.progress.frac >= 1}></span></div>{/if}

	<div class="top" bind:clientHeight={topH}>
		<GfxToolbar {s} {m2} {rev} {focus} {fullBox} {mirror} {mirrored} {field} {compact} {wire} {cb} {g2} {cmUser} {map} {is3d} has3d={!!Canvas3D} {camNow} {tools} {shownExpr}
			grp={grp ? { id: grp.id, type: grp.type } : null} {onplot} {sol} {drawable} {exprName} {fieldLabel} {saveQuick} {names} {cx} {entryKey} {pair} onpart={() => (partUser = true)}
			{nSteps} {stepLabel} {scaleUser} {canAnimate} {eigen} {contours} {band} {probePts} {fluxField} {flux} {aphi} {wave} {hasS} {hasBands} {hasFF} {mesh}
			bind:mode bind:frameAll bind:mirrorOn bind:wireUser bind:fit bind:cmPick bind:cmRev bind:axes bind:tool bind:fieldKey bind:part bind:phase bind:playing
			bind:compUser bind:step bind:ruleUser bind:scalePick bind:contoursUser bind:rawField bind:bandOn bind:fieldLines bind:level bind:inset />
		{#if is3d && (!compact || rev)}
			<Tools3D {rev} results={mode === 'results'} nodal={!!nodal3} hasDisp={!!dispField} {deform} {autoScale} bind:cutaway bind:clipOn bind:clipAxis bind:clipFrac bind:sliceOn bind:sliceAxis bind:sliceFrac bind:isoOn bind:isoN bind:deformOn bind:deformUser />
		{/if}
	</div>

	{#if mode === 'results' && wave && inset !== 'none' && !stale}
		<DrivenInset w={wave} view={inset} step={field?.step ?? step} top={topH + 12} onclose={() => (inset = 'none')} />
	{/if}
	{#if mode === 'results'}
		<GfxNotes errs={groupChips.errs} notes={groupChips.notes} info={groupChips.info} infoLabel={dfmRef && dfmScale ? `deformed x${fmt(dfmScale)}` : 'info'} solver={solverNotes} />
	{/if}
	<GfxStatus {s} {mode} hasSol={!!sol} {field} {drawable} {invalid} {stale} {coarse} {running} {longRun} {now} {meshChanged} grp={plot && grp ? { id: grp.id, type: grp.type, ...(grp.enabled === false ? { enabled: false } : {}) } : null} showGroupBadges={tools} top={topH + 8} />

	{#if cb}
		<Colorbar colormap={cb.cm} reverse={cmRev} min={cb.min} max={cb.max} scale={cb.scale} label={cb.label} unit={cb.unit} note={cb.note} rule={mode === 'results' ? (manualRange ? 'manual' : rule) : 'full'} scoped={mode === 'results' && !!rangeBox} levels={'levels' in cb ? ((cb.levels as number[] | undefined) ?? []) : []} />
	{/if}

	<GfxFoot {s} {probe} {lu} label={pair ? fieldLabel : (field?.name ?? '')} unit={disp.unit} {compact} {frameMs} />
</div>

<style>
	.gfx { position: absolute; inset: 0; background: #0d0d0d; overflow: hidden; user-select: none; -webkit-user-select: none; }
	.stage { position: absolute; left: 0; top: 0; bottom: 0; right: 84px; }
	.stage.bg3 { background: radial-gradient(ellipse at 50% 42%, #1d1e20 0%, #131314 55%, #0d0d0d 100%); }
	.gfx.stale :global(canvas) { filter: saturate(0.2) brightness(0.65); }
	.empty { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; }
	.top { position: absolute; left: 6px; top: 6px; right: 90px; display: flex; flex-wrap: wrap; gap: 3px; align-items: center; pointer-events: none; }
	/* children of child components (complex part, 3D tools) too: scoped `*` would miss them */
	.top > :global(*) { pointer-events: auto; }
	.prog { position: absolute; left: 0; right: 0; top: 0; height: 2px; background: rgba(57, 135, 229, 0.15); }
	.prog span { position: absolute; left: 0; top: 0; bottom: 0; background: var(--accent); transition: width 0.2s; }
	.prog span.ind { width: 30% !important; animation: slide 1.2s linear infinite; }
	@keyframes slide { from { left: -30%; } to { left: 100%; } }
	@media (max-width: 760px) {
		.top { right: 6px; }
		.stage { right: 0; bottom: 52px; }
	}
</style>
