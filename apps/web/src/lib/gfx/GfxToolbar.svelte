<script lang="ts">
	// SPDX-License-Identifier: GPL-3.0-or-later
	// Graphics toolbar (split from Graphics.svelte, DevLog-064; same markup and behaviour): modes, dataset selector of a
	// sweep, region of interest, mirror, wireframe, fit, colormap, axes, camera preset, draw tools, plot-group switch,
	// field, complex part, component, step, range rule, log, animation, contours, raw, band, flux / field lines,
	// smoothing, driven-solve insets, the 3D raw toggle. The view state stays in Graphics (bound props); derived values
	// come in as props. The 3D tools (Tools3D) follow it in the same toolbar row.
	import type { FieldData, Solution } from '@amp/spec/types';
	import type { Session } from '../workbench/session.svelte';
	import type { RangeRule } from '../post/post.worker';
	import type { ScaleMode } from './renderer2d';
	import { COLORMAPS, CYCLIC, type ColormapName } from './colormaps';
	import { CAMERA_PRESETS, PRESET_TIP, setCameraPreset, type CameraPreset } from './camera';
	import type { AxesMode } from './view-link';
	import type { ComplexPart } from './complex';
	import ComplexControls from './ComplexControls.svelte';

	type Mode = 'geometry' | 'mesh' | 'results';
	let {
		s, m2, rev, focus, fullBox, mirror, mirrored, field, compact, wire, cb, g2, cmUser, map, is3d, has3d, camNow, tools, shownExpr, grp, onplot,
		sol, drawable, exprName, fieldLabel, saveQuick, names, cx, entryKey, pair, onpart, nSteps, stepLabel, scaleUser, canAnimate, eigen, contours,
		band, probePts, fluxField, flux, aphi, wave, hasS, hasBands, hasFF, mesh,
		mode = $bindable(), frameAll = $bindable(), mirrorOn = $bindable(), wireUser = $bindable(), fit = $bindable(), cmPick = $bindable(), cmRev = $bindable(),
		axes = $bindable(), tool = $bindable(), fieldKey = $bindable(), part = $bindable(), phase = $bindable(), playing = $bindable(), compUser = $bindable(),
		step = $bindable(), ruleUser = $bindable(), scalePick = $bindable(), contoursUser = $bindable(), rawField = $bindable(), bandOn = $bindable(),
		fieldLines = $bindable(), level = $bindable(), inset = $bindable()
	}: {
		s: Session; m2: unknown; rev: boolean; focus: [number, number, number, number] | null; fullBox: [number, number, number, number] | null;
		mirror: { tip: string } | null; mirrored: boolean; field: FieldData | null; compact: boolean; wire: boolean; cb: unknown; g2: unknown;
		cmUser: 'auto' | ColormapName; map: { cm: ColormapName; logOk: boolean } | null; is3d: boolean;
		/** the 3D viewer module is loaded (the camera select needs it) */
		has3d: boolean;
		/** preset the camera looks along; null after a free orbit (shown as custom) */
		camNow: CameraPreset | null;
		tools: boolean; shownExpr: string | null; grp: { id: string; type: string } | null; onplot?: ((id: string | null) => void) | undefined;
		sol: Solution | null; drawable: boolean; exprName: string | null; fieldLabel: string; saveQuick: () => void; names: string[];
		cx: { entries: string[]; groups: Map<string, unknown> }; entryKey: string; pair: unknown; onpart: () => void; nSteps: number;
		stepLabel: (i: number) => string; scaleUser: ScaleMode; canAnimate: boolean; eigen: boolean; contours: boolean;
		band: { probe: string; field: string; rel: number; tip: string } | null; probePts: Array<{ id: string }>; fluxField: FieldData | null;
		flux: { n: number } | null; aphi: FieldData | null; wave: unknown; hasS: boolean; hasBands: boolean; hasFF: boolean; mesh: { cells: { type: string } } | null;
		mode: Mode; frameAll: boolean; mirrorOn: boolean; wireUser: boolean; fit: number; cmPick: 'auto' | ColormapName; cmRev: boolean; axes: AxesMode;
		tool: 'none' | 'line' | 'point'; fieldKey: string; part: ComplexPart; phase: number; playing: boolean; compUser: number; step: number;
		ruleUser: RangeRule; scalePick: ScaleMode; contoursUser: boolean; rawField: boolean; bandOn: boolean; fieldLines: boolean; level: number;
		inset: 'none' | 'sparams' | 'farfield' | 'bands';
	} = $props();
	const modeTip: Record<Mode, string> = { geometry: 'Geometry: domains by colour (G)', mesh: 'Mesh: element quality and wireframe (M)', results: 'Results: solution fields (R)' };
</script>

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
				{#each COLORMAPS as c}<option value={c}>{c}{CYCLIC.has(c) ? ' (cyclic)' : ''}</option>{/each}
			</select>
			<button class:on={cmRev} data-tip="Reverse the colormap" onclick={() => (cmRev = !cmRev)}>rev</button>
		{/if}
		{#if m2 && !rev}
			<select bind:value={axes} data-tip="Axes: ticks along the model box in the length unit; scale bar; none">
				<option value="axes">axes</option>
				<option value="scale">scale bar</option>
				<option value="none">no axes</option>
			</select>
		{/if}
		{#if is3d && !rev && has3d}
			<!-- the first (hidden) option shows the current view; every preset, the shown one too, fires a change and the
			     select returns to the current-view option, so a preset can be applied again (e.g. after a zoom) -->
			<select value="" onchange={(e) => { const el = e.currentTarget as HTMLSelectElement; setCameraPreset(el.value); el.value = ''; }} data-tip={`Camera preset (z up); a preset looks at the model centre from its direction at the fit distance. ${camNow ? `Now: ${camNow}, ${PRESET_TIP[camNow]}` : 'Now: custom (free orbit or moved look-at point)'}`}>
				<option value="" disabled hidden>{camNow ?? 'custom'}</option>
				{#each CAMERA_PRESETS as p}<option value={p} title={PRESET_TIP[p]}>{p}</option>{/each}
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
			<button disabled={!exprName} data-tip={exprName ? 'Save the quick view (field, component, step, range rule, colormap, log, contours, wireframe) as a 2D plot group in the spec (one operation)' : `${fieldLabel} is not a solution field: a plot group can show Re, Im or |.| of a complex field`} onclick={saveQuick}>Save as plot group</button>
		{/if}
		{#if mode === 'results' && sol && names.length && !g2}
			{#if cx.entries.length > 1}<select value={entryKey} onchange={(e) => (fieldKey = (e.currentTarget as HTMLSelectElement).value)} data-tip={cx.groups.size ? 'Field. A complex field (driven solve) is one entry; its part is chosen next to it' : 'Field'}>{#each cx.entries as n}<option value={n}>{n}{cx.groups.has(n) ? ' (complex)' : ''}</option>{/each}</select>{/if}
			{#if pair}<ComplexControls bind:part bind:phase bind:playing {onpart} />{/if}
		{#if drawable}
			{#if field && field.components > 1}
					<select bind:value={compUser} data-tip={pair && part === 'arg' && compUser < 0 ? 'Component. The phase is defined per component: magnitude shows the phase of component 0' : pair && compUser < 0 ? 'Component. Magnitude of a complex vector: the norm over the components of the chosen part' : 'Component'}>
					<option value={-1}>magnitude</option>
					{#each Array.from({ length: field.components }, (_, i) => i) as i}<option value={i}>{field.name === 'E_rphiz' ? ['r', 'phi', 'z'][i] : i}</option>{/each}
				</select>
			{/if}
			{#if nSteps > 1}
				<select bind:value={step} data-tip={sol.steps ? `${sol.steps.kind} step` : 'step'}>
					{#each Array.from({ length: nSteps }, (_, i) => i) as i}<option value={i}>{stepLabel(i)}</option>{/each}
				</select>
			{/if}
			<select bind:value={ruleUser} data-tip="Colour range rule: full = min to max; robust = area-weighted 1st-99th percentile (values outside saturate). Over the view box when the view has one, else the whole mesh">
				<option value="full">range: full</option>
				<option value="robust">range: p1-99</option>
			</select>
			{#if map?.logOk}<button class:on={scaleUser === 'log'} data-tip="Logarithmic colour scale (the data span more than two decades)"onclick={() => (scalePick = scalePick === 'log' ? 'linear' : 'log')}>log</button>{/if}
			{#if canAnimate}<button class:on={playing} data-tip={eigen ? 'Animate the mode: Re(u e^(i phase)) (Space)' : pair ? 'Animate the phase: Re(u e^(jφ)), φ from 0 to 360° (Space)' : 'Play the steps (Space)'} onclick={() => { if (pair && part !== 'inst') part = 'inst'; playing = !playing; }}>{playing ? 'Pause' : 'Animate'}</button>{/if}
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
		{#if mode === 'results' && wave && sol}
			<div class="modes">
				{#if hasS}<button class:on={inset === 'sparams'} data-tip="S-parameters of the ports vs frequency (|S| in dB, phase)" onclick={() => (inset = inset === 'sparams' ? 'none' : 'sparams')}>S-params</button>{/if}
				{#if hasBands}<button class:on={inset === 'bands'} data-tip="Band diagram: eigenfrequencies along the wave-vector path" onclick={() => (inset = inset === 'bands' ? 'none' : 'bands')}>Bands</button>{/if}
				{#if hasFF}<button class:on={inset === 'farfield'} data-tip="Far field: 2D scattering width σ2D(φ) at the shown frequency (polar)" onclick={() => (inset = inset === 'farfield' ? 'none' : 'farfield')}>Far field</button>{/if}
			</div>
		{/if}
		{#if g2 && mode === 'results' && sol && drawable && m2 && !rev}
			<button class:on={rawField} data-tip="Raw element field (off: the element basis evaluated per pixel). The probe always shows the exact value" onclick={() => (rawField = !rawField)}>Raw</button>
			{#if !compact}<select bind:value={level} data-tip="Smoothing: refined lattice level r">{#each [1, 2, 3, 4, 6] as l}<option value={l}>r {l}</option>{/each}</select>{/if}
		{/if}
		{#if is3d && !rev && mode === 'results' && sol && drawable && mesh?.cells.type === 'tet10'}
		<button class:on={rawField} data-tip="Raw: values linear between the 6 nodes of each exterior tet10 face (4 sub-triangles). Off: the face's P2 basis evaluated per pixel. The colour range is taken over the nodal values" onclick={() => (rawField = !rawField)}>Raw</button>
	{/if}

<style>
	.modes { display: flex; }
	.modes button + button { border-left: 0; }
	.ds { max-width: 260px; border-color: #e0a526; }
	.pg { font: 11px var(--mono); color: var(--ink); background: rgba(57, 135, 229, 0.25); border: 1px solid var(--accent); padding: 0 5px; height: 22px; display: inline-flex; align-items: center; }
	.amb.on { background: #6b4e12; border-color: #e0a526; color: #fff; }
</style>
