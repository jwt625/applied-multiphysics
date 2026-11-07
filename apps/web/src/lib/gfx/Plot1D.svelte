<script lang="ts">
	// SPDX-License-Identifier: GPL-3.0-or-later
	// 1D plot group view (DevLog-027): the group's series (results/plot-data.ts, values from R3's ResultsClient in the
	// post worker) in the ported LinePlot (Canvas 2D, nice ticks, log x / y, hover crosshair). Recomputed when the spec,
	// the solution or the group changes; the latest request wins (a drag of a cut-line end previews through here).
	// Honesty: a stale solution is badged; items that cannot be evaluated list their reason; absolute units on the axes.
	import type { Session } from '../workbench/session.svelte';
	import LinePlot from '../results/LinePlot.svelte';
	import { plot1dData, plotGroup, type Plot1DData } from '../results/plot-data';
	import { resultsClient, runOf } from '../results/api';
	import { fmtMs } from './ticks';

	let { s, group, data = null, onms }: { s: Session; group: string; /** spec data to plot (a drag preview passes its own) */ data?: unknown; onms?: (ms: number) => void } = $props();
	const spec = $derived(data ?? s.model.data);
	const g = $derived(plotGroup(spec, group));
	let out = $state.raw<Plot1DData | null>(null);
	let err = $state('');
	let busy = $state(false);
	let logX = $state(false);
	let logY = $state(false);
	let tok = 0;
	$effect(() => {
		const gg = g, sp = spec, sol = s.solution, mesh = s.mesh;
		void s.activeParams;
		if (!gg || gg.type !== 'plot1d') { out = null; err = gg ? `${gg.id} is a ${gg.type} group` : `no plot group ${group}`; return; }
		if (gg.enabled === false) { out = null; err = `${gg.id} is disabled (enabled: false): not computed`; return; }
		if (sol && mesh && sol.meshHash !== mesh.hash) { out = null; err = 'results out of date: the geometry or mesh changed since the last solve (Compute)'; return; }
		if (!sol || !mesh) { out = null; err = 'not computed: Compute runs the registered physics module'; return; }
		const t = ++tok, t0 = performance.now();
		busy = true;
		void (async () => {
			try {
				const run = await runOf(s);
				if (!run) { if (t === tok) { out = null; err = 'no solution on the current mesh'; } return; }
				const d = await plot1dData(resultsClient(s.post), sp, gg, run);
				if (t !== tok) return;
				out = d; err = '';
				onms?.(performance.now() - t0);
			} catch (e) {
				if (t === tok) { out = null; err = e instanceof Error ? e.message : String(e); }
			} finally { if (t === tok) busy = false; }
		})();
	});
	const stale = $derived(!!s.solution && s.staleSolution);
	const note = $derived(out ? [...out.notes, `${fmtMs(out.ms)}`].join('; ') : '');
</script>

<div class="p1" class:stale>
	{#if out && out.series.length}
		<LinePlot series={out.series} xLabel={out.xLabel} yLabel={out.yLabel} bind:logX bind:logY ariaLabel={`1D plot group ${group}`} {note} />
	{:else}
		<div class="msg dim">{err || (busy ? 'evaluating...' : out?.errors.length ? '' : 'no enabled items: add a Line Graph, Point Graph, Global or Table Graph (+ on the group)')}</div>
	{/if}
	{#if out?.errors.length}
		<div class="errs">{#each out.errors as e (e.id)}<div class="na" data-tip={e.message}>{e.id}: {e.message}</div>{/each}</div>
	{/if}
	{#if stale}<div class="badge" data-tip="This result was computed for an earlier version of the model; recompute for the current one">stale: earlier spec</div>
	{:else if s.solutionCoarse}<div class="badge co" data-tip="Coarse preview while dragging (mesh sizes x2); the full-resolution run follows on release">coarse preview</div>{/if}
</div>

<style>
	.p1 { position: absolute; inset: 0; display: flex; flex-direction: column; background: var(--bg); padding: 2px 4px 4px; }
	.p1.stale :global(canvas) { filter: saturate(0.2) brightness(0.65); }
	.msg { margin: auto; font-size: 11px; max-width: 80%; text-align: center; }
	.errs { flex: none; font-size: 11px; max-height: 60px; overflow: auto; }
	.errs div { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.badge.co { border-color: var(--border); color: var(--ink-2); }
	.badge { position: absolute; right: 6px; top: 26px; font-size: 11px; padding: 1px 6px; border: 1px solid var(--warn); color: var(--warn); background: rgba(13, 13, 13, 0.85); }
</style>
