<script lang="ts">
	// SPDX-License-Identifier: GPL-3.0-or-later
	// Note chips of the graphics view (split from Graphics.svelte, DevLog-052): plot-group items not evaluated or not
	// drawn, group info, solver notes of the solution; the details are in the tooltips. Bottom right, above the footer:
	// the headline box of the workbench sits bottom left (DevLog-040 s.5).
	let { errs = [], notes = [], info = [], infoLabel = 'info', solver = [] }: { errs?: string[]; notes?: string[]; info?: string[]; infoLabel?: string; solver?: string[] } = $props();
</script>

{#if errs.length || notes.length || info.length || solver.length}
	<div class="gnotes">
		{#if errs.length}<span class="crit" data-tip={errs.join('\n')}>{errs.length} not evaluated</span>{/if}
		{#if notes.length}<span class="na" data-tip={notes.join('\n')}>{notes.length} not drawn</span>{/if}
		{#if info.length}<span data-tip={info.join('\n')}>{infoLabel}</span>{/if}
		{#if solver.length}<span data-tip={solver.join('\n')}>{solver.length} solver note{solver.length > 1 ? 's' : ''}</span>{/if}
	</div>
{/if}

<style>
	.gnotes { position: absolute; right: 90px; bottom: 22px; display: flex; gap: 3px; font-size: 11px; pointer-events: auto; }
	.gnotes > span { background: rgba(13, 13, 13, 0.85); border: 1px solid var(--border); padding: 0 5px; white-space: nowrap; color: var(--ink-2); }
	.gnotes > span.crit { border-color: var(--crit); color: var(--crit); }
	@media (max-width: 760px) { .gnotes { bottom: 74px; right: 6px; } }
</style>
