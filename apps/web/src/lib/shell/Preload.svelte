<script lang="ts">
	// SPDX-License-Identifier: GPL-3.0-or-later
	let { modules = [] }: { modules?: string[] } = $props();
</script>

<svelte:head>
	{#each modules as m}<link rel="modulepreload" href={m} />{/each}
</svelte:head>
