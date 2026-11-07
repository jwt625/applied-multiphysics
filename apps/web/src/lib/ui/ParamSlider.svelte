<script lang="ts">
	// SPDX-License-Identifier: GPL-3.0-or-later
	// Slider plus exact field with unit for one spec param (s.6: every parameter has both). Slider steps go through the op
	// log as one coalesced gesture (onpreview per step, ondragend on release); the exact field commits one op.
	import type { ParamView } from '../state/params';
	import { fmt } from '../gfx/ticks';
	import TextCommit from './TextCommit.svelte';

	let { p, onpreview, ondragend, oncommit, resolved = '' }: { p: ParamView; onpreview?: (v: number) => void; ondragend?: () => void; oncommit: (v: number) => void; resolved?: string } = $props();
	let live = $state<number | null>(null);
	const shown = $derived(live ?? p.value);
	const step = $derived(p.span ? (p.span[1] - p.span[0]) / 200 : 1);
	const tip = $derived(`${p.name}${p.description ? `: ${p.description}` : ''}\n${resolved}${p.span ? `\nslider ${fmt(p.span[0])} to ${fmt(p.span[1])} ${p.unit}${p.spanFromSpec ? ' (spec range)' : ' (UI span 0.5x-2x of the model value; the spec gives no range)'}` : ''}`);
</script>

<div class="ps">
	<span class="n mono" data-tip={tip}>{p.name}</span>
	{#if p.value !== null && p.span}
		<input type="range" min={p.span[0]} max={p.span[1]} {step} value={shown ?? 0} data-tip={tip}
			oninput={(e) => { live = Number((e.currentTarget as HTMLInputElement).value); onpreview?.(live); }}
			onchange={(e) => { const v = Number((e.currentTarget as HTMLInputElement).value); live = null; if (onpreview) { onpreview(v); ondragend?.(); } else oncommit(v); }} />
	{:else}
		<span class="dim expr mono" data-tip={tip}>{p.expr ?? ''}</span>
	{/if}
	{#if p.value !== null}
		<TextCommit mono width="68px" value={live !== null ? fmt(live, 4) : String(p.value)} {tip} oncommit={(s) => { const v = Number(s); if (Number.isFinite(v)) oncommit(v); }} />
	{:else}
		<span></span>
	{/if}
	<span class="u mono dim">{p.unit}</span>
</div>

<style>
	.ps { display: grid; grid-template-columns: 72px minmax(60px, 1fr) 68px 36px; gap: 6px; align-items: center; min-height: 24px; }
	.n { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ink-2); }
	.expr { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.u { font-size: 11px; }
	input[type='range'] { width: 100%; }
</style>
