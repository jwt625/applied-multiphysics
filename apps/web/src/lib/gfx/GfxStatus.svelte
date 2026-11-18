<script lang="ts">
	// SPDX-License-Identifier: GPL-3.0-or-later
	// Status of the graphics view (split from Graphics.svelte, DevLog-052): badges (invalid model, stale, coarse,
	// disabled or 1D plot group) and the centre message when no result is drawn (computing, re-solving, unavailable with
	// its reasons, failed run, base model of a sweep, out of date, not computed, field without a display).
	import type { FieldData } from '@amp/spec/types';
	import type { Session } from '../workbench/session.svelte';
	import { fmtMs } from './ticks';

	let { s, mode, hasSol, field, drawable, invalid, stale, coarse, running, longRun, now, meshChanged, grp, showGroupBadges, top = 36 }: {
		s: Session; mode: 'geometry' | 'mesh' | 'results'; hasSol: boolean; field: FieldData | null; drawable: boolean; invalid: string[]; stale: boolean; coarse: boolean;
		running: boolean; longRun: boolean; now: number; meshChanged: boolean; grp: { id: string; type: string; enabled?: boolean } | null; showGroupBadges: boolean;
		/** px from the top (below the wrapping toolbar) */
		top?: number;
	} = $props();
</script>

<div class="badges" style:top="{top}px">
	{#if showGroupBadges && grp && (grp.type === 'plot2d' || grp.type === 'plot3d') && grp.enabled === false}<div class="badge co" data-tip="enabled: false: the group is not computed (Enable in the tree)">{grp.id}: disabled</div>{/if}
	{#if showGroupBadges && grp && grp.type === 'plot1d'}<div class="badge co" data-tip="1D plot groups are drawn in the 1D pane">{grp.id}: {grp.type} not drawn here</div>{/if}
	{#if invalid.length}<div class="badge st" data-tip="The model does not validate; the drawing is the last valid geometry{hasSol ? ' and result' : ''}">model invalid: earlier geometry</div>
	{:else if stale}<div class="badge st" data-tip="This result was computed for an earlier version of the model; recompute for the current one">stale: earlier spec</div>
	{:else if coarse}<div class="badge co" data-tip="Coarse preview while dragging (mesh sizes x2); the full-resolution run follows on release">coarse preview</div>{/if}
</div>

{#if invalid.length}
	<div class="unav err">
		<div class="crit">Model invalid</div>
		{#each invalid.slice(0, 4) as r}<div>{r}</div>{/each}
		{#if invalid.length > 4}<div class="dim">{invalid.length - 4} more</div>{/if}
		<div class="dim">nothing is computed until the model validates (Undo restores the last valid state)</div>
	</div>
{:else if mode === 'results' && !hasSol}
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
{:else if mode === 'results' && hasSol && field && !drawable}
	<div class="unav"><div class="na">Field {field.name} ({field.space}): no display yet</div><div class="dim">the viewer draws nodal (H1) and per-cell (DG0) fields; {field.space} needs an H1 projection from @amp/physics or Nedelec evaluation in @amp/post</div></div>
{/if}

<style>
	.badges { position: absolute; right: 90px; display: flex; flex-direction: column; align-items: flex-end; gap: 3px; pointer-events: none; }
	.badge { font-size: 11px; padding: 1px 6px; border: 1px solid; background: rgba(13, 13, 13, 0.85); pointer-events: auto; }
	.badge.st { color: var(--warn); border-color: var(--warn); }
	.badge.co { color: var(--ink-2); border-color: var(--border); }
	.unav { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); background: rgba(13, 13, 13, 0.88); border: 1px solid var(--border); padding: 8px 12px; max-width: 70%; font-size: 11px; display: flex; flex-direction: column; gap: 3px; align-items: flex-start; }
	.unav .na { font-size: 12px; }
	.unav.err { border-color: var(--crit); }
	.unav .crit { font-size: 12px; }
	@media (max-width: 760px) { .badges { right: 6px; } }
</style>
