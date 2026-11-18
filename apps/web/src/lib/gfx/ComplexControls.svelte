<script lang="ts">
	// SPDX-License-Identifier: GPL-3.0-or-later
	// Part selector of a complex (driven) field and the phase slider of Re(u e^(j phi)) (DevLog-052, gfx/complex.ts).
	import { COMPLEX_PARTS, PART_LABEL, PART_TIP, wrapPhase, type ComplexPart } from './complex';

	let { part = $bindable('re'), phase = $bindable(0), playing = $bindable(false), onpart }: { part?: ComplexPart; phase?: number; playing?: boolean; /** the user picked a part */ onpart?: () => void } = $props();
	const deg = $derived(Math.round((wrapPhase(phase) * 180) / Math.PI) % 360);
</script>

<div class="modes" role="radiogroup" aria-label="complex part">
	{#each COMPLEX_PARTS as p}<button class:on={part === p} data-tip={PART_TIP[p]} onclick={() => { part = p; onpart?.(); if (p !== 'inst' && playing) playing = false; }}>{PART_LABEL[p]}</button>{/each}
</div>
{#if part === 'inst'}
	<input class="ph" type="range" min="0" max="360" step="1" value={deg} oninput={(e) => { playing = false; phase = (Number((e.currentTarget as HTMLInputElement).value) * Math.PI) / 180; }} data-tip="Phase φ = ωt of Re(u e^(jφ)), degrees" />
	<span class="phv mono" data-tip="phase φ">{deg}°</span>
{/if}

<style>
	.modes { display: flex; }
	.modes button + button { border-left: 0; }
	.ph { width: 90px; }
	.phv { font-size: 11px; color: var(--ink-2); min-width: 30px; }
</style>
