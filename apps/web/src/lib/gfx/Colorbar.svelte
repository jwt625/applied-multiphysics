<script lang="ts">
	// SPDX-License-Identifier: GPL-3.0-or-later
	// Colorbar in absolute display units (s.6): nice ticks (linear) or decades (log), 3 significant figures.
	import { cssGradient, type ColormapName } from './colormaps';
	import { fmt, logTicks, niceTicks } from './ticks';
	import { scaleT, type ScaleMode } from './renderer2d';

	let { colormap, min, max, scale = 'linear', label, unit, clipped = false }: { colormap: ColormapName; min: number; max: number; scale?: ScaleMode; label: string; unit: string; clipped?: boolean } = $props();

	const ticks = $derived(scale === 'log' ? logTicks(min, max) : niceTicks(min, max, 5));
	const pos = (v: number) => 100 * Math.min(1, Math.max(0, scaleT(v, scale, { min, max })));
</script>

<div class="cb" data-tip="{label} [{unit || '1'}], range {fmt(min)} to {fmt(max)}{scale === 'log' ? ', log scale' : ''}{clipped ? ', clipped to the 1st-99th percentile (values outside saturate)' : ''}">
	<div class="lab mono">{unit || '1'}{clipped ? ' p1-99' : ''}</div>
	<div class="bar" style="background: {cssGradient(colormap)}">
		{#each ticks as t}
			<div class="tick" style="bottom: {pos(t)}%"><span class="mono">{fmt(t)}</span></div>
		{/each}
	</div>
</div>

<style>
	.cb { position: absolute; right: 6px; top: 34px; bottom: 30px; width: 70px; padding: 4px 4px 8px 6px; background: rgba(13, 13, 13, 0.92); border: 1px solid var(--line); display: flex; flex-direction: column; align-items: flex-start; pointer-events: none; }
	.lab { pointer-events: auto; }
	.lab { font-size: 11px; color: var(--ink-2); margin-bottom: 4px; white-space: nowrap; }
	.bar { position: relative; width: 12px; flex: 1; border: 1px solid var(--border); }
	.tick { position: absolute; left: 12px; height: 0; border-top: 1px solid var(--ink-3); width: 4px; }
	.tick span { position: absolute; left: 7px; top: -7px; font-size: 10px; color: var(--ink-2); white-space: nowrap; }
</style>
