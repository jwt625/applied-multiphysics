<script lang="ts">
	// SPDX-License-Identifier: GPL-3.0-or-later
	// Landing route (DevLog-030): the example gallery. The workbench lives at /workbench; links from before the move
	// (/?sim=<id>, /#d=<share>) are forwarded there with their query and hash, before the gallery hydrates.
	import { browser } from '$app/env';
	import { resolve } from '$app/paths';
	import Landing from '../lib/landing/Landing.svelte';

	const forward = browser && (new URLSearchParams(location.search).has('sim') || /(?:^#|&)d=/.test(location.hash));
	if (forward) location.replace(`${resolve('/workbench')}${location.search}${location.hash}`);
</script>

<svelte:head>
	<title>applied-multiphysics</title>
	<meta name="description" content="Browser-native multiphysics examples: geometry, mesh and result of each model, opened in the workbench." />
</svelte:head>
{#if !forward}<Landing />{/if}
