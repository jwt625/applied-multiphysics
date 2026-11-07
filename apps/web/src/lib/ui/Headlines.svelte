<script lang="ts">
	// SPDX-License-Identifier: GPL-3.0-or-later
	// The model's headline numbers (its own `results` of type scalar and probe), evaluated on the current solution in the
	// spec's unit (post/headline.ts). Stale or coarse values are marked; values that depend on eval-case inputs say so.
	import type { Session } from '../workbench/session.svelte';
	import { headlines, type Headline } from '../post/headline';
	import { fmt } from '../gfx/ticks';
	import { unitLabel } from '../gfx/units';

	let { s, big = false, boxed = false }: { s: Session; big?: boolean; boxed?: boolean } = $props();
	let list = $state.raw<Headline[]>([]);
	$effect(() => {
		const sol = s.solution, mesh = s.mesh, params = s.model.parsed?.params;
		const results = ((s.model.data as { results?: unknown[] } | null)?.results ?? []) as Parameters<typeof headlines>[0];
		if (!sol || !mesh || !params || sol.meshHash !== mesh.hash) { list = []; return; }
		void headlines(results, sol, mesh, params, s.post).then((h) => { if (s.solution === sol) list = h; });
	});
	const mark = $derived(s.staleSolution ? 'stale' : s.solutionCoarse ? 'coarse' : '');
	const caseNote = $derived(s.caseFilled.length && s.caseInfo ? `uses eval case ${s.caseInfo.id} inputs: ${s.caseFilled.join(', ')}` : '');
</script>

{#if list.length}
	<div class="hl" class:big class:boxed class:dim={!!mark}>
		{#each list as h}
			<div class="row" data-tip={`${h.tip}${mark ? `\n${mark}: computed for ${mark === 'stale' ? 'an earlier version of the model' : 'a coarse preview mesh'}` : ''}${caseNote ? `\n${caseNote}` : ''}`}>
				<span class="k">{h.label}</span>
				{#if h.value === null}<span class="na">not evaluated</span>
				{:else}<span class="v mono">{fmt(h.value, 4)}</span><span class="u mono">{unitLabel(h.unit)}</span>{/if}
				{#if mark}<span class="m warn">{mark}</span>{/if}
				{#if caseNote}<span class="m" data-tip={caseNote}>case</span>{/if}
			</div>
		{/each}
	</div>
{/if}

<style>
	.hl { display: flex; flex-direction: column; gap: 2px; }
	.boxed { position: absolute; left: 6px; top: 36px; background: rgba(13, 13, 13, 0.85); border: 1px solid var(--line); padding: 4px 8px; }
	.row { display: flex; align-items: baseline; gap: 6px; }
	.k { color: var(--ink-2); font-size: 11px; min-width: 64px; }
	.v { font-size: 13px; color: var(--ink); }
	.u { font-size: 11px; color: var(--ink-2); }
	.big .v { font-size: 22px; }
	.big .k { font-size: 12px; }
	.dim .v { color: var(--ink-3); }
	.m { font-size: 10px; border: 1px solid currentColor; padding: 0 3px; color: var(--ink-2); }
	.na { font-size: 11px; color: var(--ink-3); }
	/* phones: the graphics toolbar wraps; keep the box clear of it, above the colorbar strip (DevLog-015) */
	@media (max-width: 760px) { .boxed { top: auto; bottom: 78px; } }
</style>
