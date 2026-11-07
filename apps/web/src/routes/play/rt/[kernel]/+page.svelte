<script lang="ts">
	// SPDX-License-Identifier: GPL-3.0-or-later
	import { onMount, type Component } from 'svelte';
	import { loadRt } from '../../../../lib/shell/lazy';
	import Preload from '../../../../lib/shell/Preload.svelte';
	let { data }: { data: { kernel: string; preload: string[] } } = $props();
	let Page = $state.raw<Component<{ kernel: string }> | null>(null);
	let failed = $state('');
	onMount(() => { loadRt().then((p) => (Page = p as never), (e) => (failed = e instanceof Error ? e.message : String(e))); });
</script>

<svelte:head><title>{data.kernel} | real-time GPU</title></svelte:head>
<Preload modules={data.preload} />
{#if Page}<Page kernel={data.kernel} />{:else if failed}<div class="msg">Failed to load: {failed}</div>{:else}<div class="shell" inert aria-hidden="true"><div class="hd">{data.kernel}</div><div class="cv"></div><div class="side"></div></div>{/if}

<style>
	.msg { padding: 20px; color: var(--ink-3); }
	.shell { height: 100%; display: grid; grid-template-columns: minmax(0, 1fr) 300px; grid-template-rows: 34px minmax(0, 1fr); }
	.hd { grid-column: 1 / 3; display: flex; align-items: center; padding: 0 10px; border-bottom: 1px solid var(--line); background: var(--surface); font-weight: 600; }
	.cv { background: #0d0d0d; }
	.side { background: var(--surface); border-left: 1px solid var(--line); }
	@media (max-width: 760px) { .shell { grid-template-columns: minmax(0, 1fr); grid-template-rows: 34px minmax(0, 1fr) 220px; } .hd { grid-column: 1; } }
</style>
