<script lang="ts">
	// SPDX-License-Identifier: GPL-3.0-or-later
	// Sweep-vs-parameter plot (DevLog-051): any scalar reported by the solved points of the last parametric sweep
	// against the first swept param, in the param's unit; further axes are separate series; unsolved points are gaps
	// (state/sweep.ts). Drawn by the 1D line plot of the results view (read only). Absolute units on both axes.
	import type { Session } from './session.svelte';
	import LinePlot, { SERIES_COLORS } from '../results/LinePlot.svelte';
	import { sweepScalars, sweepSeries } from '../state/sweep';
	import { unitLabel } from '../gfx/units';

	let { s }: { s: Session } = $props();
	const sw = $derived(s.sweep);
	const names = $derived(sweepScalars(sw));
	let pick = $state('');
	const name = $derived(names.some((n) => n.name === pick) ? pick : (names[0]?.name ?? ''));
	const d = $derived(sw && name ? sweepSeries(sw, name) : null);
	const series = $derived((d?.series ?? []).map((x, i) => ({ name: x.name, x: x.x, y: x.y, markers: true, line: true, color: SERIES_COLORS[i % SERIES_COLORS.length], tip: `${name} over ${sw?.studyId ?? ''}` })));
	const yLabel = $derived(unitLabel(d?.yUnit) ? `${name} (${unitLabel(d!.yUnit)})` : name);
	let logX = $state(false);
	let logY = $state(false);
</script>

{#if !sw}
	<div class="m dim">No sweep yet. Add a parametric sweep (Studies in the Model Builder) and Compute it.</div>
{:else}
	<div class="sp">
		<div class="bar">
			<select class="mono" value={name} onchange={(e) => (pick = e.currentTarget.value)} data-tip="Scalar result plotted against the swept parameter (as reported by the physics module for each point)">
				{#each names as n (n.name)}<option value={n.name}>{n.name}{unitLabel(n.unit) ? ` (${unitLabel(n.unit)})` : ''}</option>{/each}
				{#if !names.length}<option value="">no scalar yet</option>{/if}
			</select>
			<span class="dim n" data-tip={`parametric study ${sw.studyId}; points row-major over ${sw.axes.map((a) => a.param).join(' x ')}`}>{d?.solved ?? 0} of {sw.points.length} points with a value</span>
		</div>
		<div class="pl">
			{#if series.length && d}
				<LinePlot {series} xLabel={d.xLabel} {yLabel} bind:logX bind:logY ariaLabel={`${name} versus ${sw.axes[0]?.param ?? ''}`} />
			{:else}<div class="m dim">{sw.done ? 'The solved points report no scalar.' : 'Waiting for the first point.'}</div>{/if}
		</div>
	</div>
{/if}

<style>
	.m { padding: 1px 8px; font-size: 11px; }
	.sp { position: absolute; inset: 0; display: flex; flex-direction: column; }
	.bar { display: flex; gap: 6px; align-items: center; padding: 3px 6px; border-bottom: 1px solid var(--line); flex: none; }
	.bar select { height: 20px; font-size: 11px; max-width: 260px; }
	.n { font-size: 11px; margin-left: auto; }
	.pl { position: relative; flex: 1; min-height: 0; }
</style>
