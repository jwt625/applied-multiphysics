<script lang="ts">
	// SPDX-License-Identifier: GPL-3.0-or-later
	// Eigenmode table (DevLog-051): one row per mode of the shown eigen solution with its frequency (Hz) or n_eff and
	// every per-mode scalar the physics module reports (state/modes.ts); a click (or Enter) shows that mode in the
	// graphics view. Values as reported, absolute units in the headers.
	import type { Session } from './session.svelte';
	import { modeTable } from '../state/modes';
	import { fmt } from '../gfx/ticks';
	import { unitLabel } from '../gfx/units';

	let { s, step = 0, onstep }: { s: Session; step?: number; onstep?: (k: number) => void } = $props();
	const t = $derived(modeTable(s.solution));
	const head = (name: string, unit: string) => (unitLabel(unit) ? `${name} (${unitLabel(unit)})` : name);
</script>

{#if !t}
	<div class="m dim">No eigen solution shown. Compute an eigenfrequency or mode study to list its modes here.</div>
{:else}
	<div class="list">
		<table class="pt mono" aria-label="eigenmodes">
			<thead><tr>
				<th data-tip="mode index (solution step)">#</th>
				<th data-tip={`step value of each mode${t.stepUnit ? ` in ${t.stepUnit}` : ''}`}>{head(t.stepName, t.stepUnit)}</th>
				{#each t.columns as c (c.key)}<th data-tip={`per-mode scalar ${c.key}_<k> reported by the physics module${c.unit ? `, ${c.unit}` : ''}`}>{head(c.name, c.unit)}</th>{/each}
			</tr></thead>
			<tbody>
				{#each t.rows as r (r.k)}
					<tr class:on={r.k === step} tabindex="0" data-tip={`Show mode ${r.k} in the graphics view`} onclick={() => onstep?.(r.k)} onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onstep?.(r.k); } }}>
						<td class="dim">{r.k}</td>
						<td class="num">{fmt(r.value, 7)}</td>
						{#each r.cells as v, i (i)}<td class="num" class:na={v === null}>{v === null ? 'N/A' : fmt(v, 6)}</td>{/each}
					</tr>
				{/each}
			</tbody>
		</table>
		{#if s.staleSolution}<div class="m warn">stale: computed for an earlier version of the model</div>{/if}
	</div>
{/if}

<style>
	.m { padding: 1px 8px; font-size: 11px; }
	.list { position: absolute; inset: 0; overflow: auto; }
	.pt { border-collapse: collapse; font-size: 11px; }
	.pt th { position: sticky; top: 0; background: var(--surface-3); color: var(--ink-2); font-weight: normal; text-align: right; padding: 1px 10px 1px 8px; white-space: nowrap; border-bottom: 1px solid var(--line); }
	.pt td { padding: 0 10px 0 8px; white-space: nowrap; height: 18px; }
	.pt td.num { text-align: right; }
	.pt td.na { color: var(--ink-3); }
	.pt tr { cursor: default; outline: none; }
	.pt tr:hover td, .pt tr:focus td { background: var(--hover); }
	.pt tr.on td { background: var(--sel); }
</style>
