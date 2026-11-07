<script lang="ts">
	// SPDX-License-Identifier: GPL-3.0-or-later
	// Workbench route: an inert shell with the workbench's grid tracks paints at once; the workbench code loads after
	// mount (modulepreload started it during HTML parse). Query: ?sim=<id>; hash: #d=<share code>.
	import { onMount, type Component } from 'svelte';
	import { loadWorkbench } from '../lib/shell/lazy';
	import Preload from '../lib/shell/Preload.svelte';
	import { DEFAULT_SIM, SIM_IDS } from '../lib/sims';

	let { data }: { data: { preload: string[] } } = $props();
	let Page = $state.raw<Component<{ simId: string; share?: string }> | null>(null);
	let failed = $state('');
	let simId = $state(DEFAULT_SIM);
	let share = $state('');

	onMount(() => {
		const q = new URLSearchParams(location.search).get('sim');
		if (q && SIM_IDS.includes(q)) simId = q;
		share = /(?:^#|&)d=([^&]+)/.exec(location.hash)?.[1] ?? '';
		loadWorkbench().then((p) => (Page = p as never), (e) => (failed = e instanceof Error ? e.message : String(e)));
	});
</script>

<svelte:head><title>Workbench | applied-multiphysics</title></svelte:head>
<Preload modules={data.preload} />
{#if Page}
	<Page {simId} {share} />
{:else if failed}
	<div class="msg">Failed to load the workbench: {failed} <button onclick={() => location.reload()}>Reload</button></div>
{:else}
	<div class="shell" inert aria-hidden="true">
		<div class="tb"><span class="sel"></span><span class="b"></span><span class="b"></span><span class="b"></span></div>
		<div class="main"><div class="p"><div class="ph">Model Builder</div></div><div class="sp"></div><div class="p"><div class="ph">Settings</div></div><div class="sp"></div><div class="g"><span class="spin"></span></div></div>
		<div class="sp h"></div>
		<div class="p bot"></div>
	</div>
{/if}

<style>
	.msg { padding: 20px; color: var(--ink-3); }
	.shell { height: 100%; display: grid; grid-template-rows: 30px minmax(0, 1fr) 3px 170px; background: var(--bg); }
	.tb { display: flex; align-items: center; gap: 4px; padding: 0 6px; background: var(--surface); border-bottom: 1px solid var(--line); }
	.sel { width: 150px; height: 22px; border: 1px solid var(--border); }
	.b { width: 60px; height: 22px; border: 1px solid var(--border); background: var(--surface-3); }
	.main { display: grid; grid-template-columns: 220px 3px 340px 3px minmax(0, 1fr); min-height: 0; }
	.p { background: var(--surface); min-height: 0; }
	.ph { height: 24px; display: flex; align-items: center; padding: 0 8px; border-bottom: 1px solid var(--line); color: var(--ink-2); font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
	.sp { background: var(--line); }
	.g { background: #0d0d0d; display: flex; align-items: center; justify-content: center; }
	.spin { width: 18px; height: 18px; border: 2px solid var(--line); border-top-color: var(--accent); border-radius: 50%; animation: r 0.8s linear infinite; }
	@keyframes r { to { transform: rotate(360deg); } }
	@media (max-width: 760px) {
		.shell { grid-template-rows: 84px minmax(0, 1fr) 0 0; }
		.main { grid-template-columns: minmax(0, 1fr); }
		.main > .p, .main > .sp { display: none; }
	}
</style>
