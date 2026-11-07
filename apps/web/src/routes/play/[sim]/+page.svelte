<script lang="ts">
	// SPDX-License-Identifier: GPL-3.0-or-later
	// Play view route: shell (big canvas area + slider column) paints at once, the Play code loads after mount.
	import { onMount, type Component } from 'svelte';
	import { loadPlay } from '../../../lib/shell/lazy';
	import Preload from '../../../lib/shell/Preload.svelte';

	let { data }: { data: { sim: string; preload: string[] } } = $props();
	let Page = $state.raw<Component<{ simId: string; share?: string }> | null>(null);
	let failed = $state('');
	let share = $state('');
	onMount(() => {
		share = /(?:^#|&)d=([^&]+)/.exec(location.hash)?.[1] ?? '';
		loadPlay().then((p) => (Page = p as never), (e) => (failed = e instanceof Error ? e.message : String(e)));
	});
</script>

<svelte:head><title>{data.sim} | Play</title></svelte:head>
<Preload modules={data.preload} />
{#if Page}
	<Page simId={data.sim} {share} />
{:else if failed}
	<div class="msg">Failed to load: {failed}</div>
{:else}
	<div class="shell" inert aria-hidden="true"><div class="hd">{data.sim}</div><div class="cv"><span class="spin"></span></div><div class="side"></div></div>
{/if}

<style>
	.msg { padding: 20px; color: var(--ink-3); }
	.shell { height: 100%; display: grid; grid-template-columns: minmax(0, 1fr) 300px; grid-template-rows: 34px minmax(0, 1fr); background: var(--bg); }
	.hd { grid-column: 1 / 3; display: flex; align-items: center; padding: 0 10px; border-bottom: 1px solid var(--line); background: var(--surface); font-weight: 600; }
	.cv { background: #0d0d0d; display: flex; align-items: center; justify-content: center; }
	.side { background: var(--surface); border-left: 1px solid var(--line); }
	.spin { width: 18px; height: 18px; border: 2px solid var(--line); border-top-color: var(--accent); border-radius: 50%; animation: r 0.8s linear infinite; }
	@keyframes r { to { transform: rotate(360deg); } }
	@media (max-width: 760px) { .shell { grid-template-columns: minmax(0, 1fr); grid-template-rows: 34px minmax(0, 1fr) 220px; } .hd { grid-column: 1; } .side { border-left: 0; border-top: 1px solid var(--line); } }
</style>
