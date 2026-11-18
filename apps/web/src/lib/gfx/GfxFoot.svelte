<script lang="ts">
	// SPDX-License-Identifier: GPL-3.0-or-later
	// Footer of the graphics view (split from Graphics.svelte, DevLog-052): hover probe readout, displayed sweep dataset,
	// mesh line, frame time.
	import type { Session } from '../workbench/session.svelte';
	import { fmt, fmtMs } from './ticks';
	import { unitLabel } from './units';

	let { s, probe, lu, label, unit, compact, frameMs }: {
		s: Session; probe: { x: number; y: number; v: number | null; dom: string } | null; lu: { unit: string; f: number }; label: string; unit: string; compact: boolean; frameMs: number;
	} = $props();
</script>

<div class="foot mono">
	{#if probe}
		<span data-tip="exact evaluation of the FE field at the cursor (post worker)">x {fmt(probe.x * lu.f)} {unitLabel(lu.unit)}, y {fmt(probe.y * lu.f)} {unitLabel(lu.unit)}</span>
		<span>{probe.dom}</span>
		{#if probe.v !== null}<span>{label} = {fmt(probe.v)} {unitLabel(unit)}</span>{/if}
	{/if}
	<span class="sp"></span>
	{#if s.sweep && s.active >= 0}<span class="dst" data-tip={`displayed dataset: point ${s.active + 1} of ${s.sweep.points.length} of parametric study ${s.sweep.studyId}`}>{s.activeLabel}</span>{/if}
	{#if s.meshInfo}<span data-tip={`mesh hash ${s.meshInfo.hash.slice(0, 16)}; mesher: ${s.meshInfo.source}; parse ${fmtMs(s.meshInfo.ms.parse)}, mesh ${fmtMs(s.meshInfo.ms.mesh)}; min quality ${fmt(s.meshInfo.qmin)}, mean ${fmt(s.meshInfo.qmean)}`}>{s.meshInfo.cells} {s.meshInfo.type}, {s.meshInfo.nodes} nodes</span>{/if}
	{#if !compact}<span data-tip="last frame draw time (CPU side)">{fmtMs(frameMs)}</span>{/if}
</div>

<style>
	.foot { position: absolute; left: 6px; right: 90px; bottom: 4px; display: flex; gap: 12px; font-size: 11px; color: var(--ink-2); pointer-events: none; white-space: nowrap; overflow: hidden; }
	.foot > span:not(.sp) { pointer-events: auto; background: rgba(13, 13, 13, 0.75); padding: 0 3px; }
	.foot > span.dst { color: #f0c76a; }
	.sp { flex: 1; }
	@media (max-width: 760px) { .foot { right: 6px; bottom: 54px; } }
</style>
