<script lang="ts">
	// SPDX-License-Identifier: GPL-3.0-or-later
	// Sweep-vs-parameter plot (DevLog-051, DevLog-064): a spec evaluation item (evaluated on each point when it was
	// solved, session.svelte.ts) or a scalar reported by the physics module, for every solved point of the last
	// parametric sweep, against the first swept param in the param's unit; further axes are separate series; unsolved
	// points are gaps (state/sweep.ts). Drawn by the 1D line plot of the results view (read only). Absolute units.
	import type { Session } from './session.svelte';
	import LinePlot, { seriesColor, seriesDashed } from '../results/LinePlot.svelte';
	import { sweepSeries } from '../state/sweep';
	import { evalCounts, evalGaps, quantityView, sweepQuantities } from './sweep-evals';
	import { unitLabel } from '../gfx/units';

	let { s }: { s: Session } = $props();
	const sw = $derived(s.sweep);
	const qs = $derived(sweepQuantities(sw));
	const evals = $derived(qs.filter((q) => q.kind === 'eval'));
	const scalars = $derived(qs.filter((q) => q.kind === 'scalar'));
	/** evaluation groups in first-seen order */
	const groups = $derived([...new Map(evals.map((q) => [q.group!, q.groupLabel!])).entries()]);
	let pick = $state('');
	const q = $derived(qs.find((x) => x.key === pick) ?? qs[0] ?? null);
	const d = $derived(sw && q ? sweepSeries({ ...sw, points: quantityView(sw.points, q) }, q.key) : null);
	const series = $derived((d?.series ?? []).map((x, i) => ({ name: x.name === q?.key ? q.name : x.name, x: x.x, y: x.y, markers: true, line: true, color: seriesColor(i), dash: seriesDashed(i), tip: `${q?.tip ?? ''}; over ${sw?.studyId ?? ''}` })));
	const yLabel = $derived(q ? (unitLabel(q.unit || d?.yUnit) ? `${q.name} (${unitLabel(q.unit || d!.yUnit)})` : q.name) : '');
	const gaps = $derived(sw && q?.kind === 'eval' ? evalGaps(sw, q.key, q.group) : []);
	/** solved points without evaluated items, by state (waiting, being evaluated, skipped by the queue cap, not queued) */
	const ec = $derived(evalCounts(sw));
	const evalNote = $derived([
		ec.running + ec.queued ? `${ec.running + ec.queued} solved points being evaluated or waiting` : '',
		ec.skipped ? `${ec.skipped} skipped while too many points waited (evaluated when shown)` : '',
		ec.none ? `${ec.none} not evaluated (evaluated when shown)` : ''
	].filter(Boolean).join('; '));
	const optText = (x: { name: string; unit: string }) => `${x.name}${unitLabel(x.unit) ? ` (${unitLabel(x.unit)})` : ''}`;
	let logX = $state(false);
	let logY = $state(false);
</script>

{#if !sw}
	<div class="m dim">No sweep yet. Add a parametric sweep (Studies in the Model Builder) and Compute it.</div>
{:else}
	<div class="sp">
		<div class="bar">
			<select class="mono" value={q?.key ?? ''} onchange={(e) => (pick = e.currentTarget.value)} data-tip={q ? `${q.tip}\nPlotted against the swept parameter. Evaluation items are evaluated on each point when it is solved; scalars are reported by the physics module` : 'Quantity plotted against the swept parameter'}>
				{#each groups as [gid, glabel] (gid)}
					<optgroup label={`evaluation group ${glabel}`}>
						{#each evals.filter((x) => x.group === gid) as x (x.key)}<option value={x.key}>{optText(x)}</option>{/each}
					</optgroup>
				{/each}
				{#if scalars.length}
					<optgroup label="physics module scalars">
						{#each scalars as x (x.key)}<option value={x.key}>{optText(x)}</option>{/each}
					</optgroup>
				{/if}
				{#if !qs.length}<option value="">no value yet</option>{/if}
			</select>
			{#if gaps.length}<span class="warn n0" data-tip={`Points without a value: ${gaps.join('; ')}`}>gaps</span>{/if}
			<span class="dim n" data-tip={`parametric study ${sw.studyId}; points row-major over ${sw.axes.map((a) => a.param).join(' x ')}${evalNote ? `; ${evalNote}` : ''}`}>{d?.solved ?? 0} of {sw.points.length} points with a value</span>
		</div>
		<div class="pl">
			{#if series.length && d}
				<LinePlot {series} xLabel={d.xLabel} {yLabel} bind:logX bind:logY ariaLabel={`${q?.name ?? ''} versus ${sw.axes[0]?.param ?? ''}`} />
			{:else}<div class="m dim">{sw.done ? 'The solved points report no value.' : 'Waiting for the first point.'}</div>{/if}
		</div>
	</div>
{/if}

<style>
	.m { padding: 1px 8px; font-size: 11px; }
	.sp { position: absolute; inset: 0; display: flex; flex-direction: column; }
	.bar { display: flex; gap: 6px; align-items: center; padding: 3px 6px; border-bottom: 1px solid var(--line); flex: none; }
	.bar select { height: 20px; font-size: 11px; max-width: 300px; }
	.n { font-size: 11px; margin-left: auto; }
	.n0 { font-size: 11px; }
	.warn { color: #e0a526; }
	.pl { position: relative; flex: 1; min-height: 0; }
</style>
