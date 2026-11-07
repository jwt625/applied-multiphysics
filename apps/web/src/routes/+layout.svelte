<script lang="ts">
	// SPDX-License-Identifier: GPL-3.0-or-later
	import '../app.css';
	import type { Snippet } from 'svelte';
	let { children }: { children: Snippet } = $props();
</script>

{@render children()}
