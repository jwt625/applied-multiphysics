<script lang="ts">
	// SPDX-License-Identifier: GPL-3.0-or-later
	// One hover tooltip for the page: any element with data-tip shows it after 250 ms (details live in tooltips, s.6).
	import { onMount } from 'svelte';
	let text = $state('');
	let x = $state(0);
	let y = $state(0);
	// near the bottom edge the tip sits above its element: measured after render so it never covers it (audit M8)
	let above = $state(false);
	let anchorTop = $state(0);
	let el = $state<HTMLDivElement>();
	const top = $derived(above && el ? Math.max(4, anchorTop - 4 - el.offsetHeight) : y);
	onMount(() => {
		let timer = 0;
		let cur: Element | null = null;
		const over = (e: PointerEvent) => {
			const el = (e.target as Element | null)?.closest?.('[data-tip]') ?? null;
			if (el === cur) return;
			cur = el;
			clearTimeout(timer);
			text = '';
			if (!el) return;
			timer = window.setTimeout(() => {
				const t = el.getAttribute('data-tip') ?? '';
				if (!t) return;
				const r = el.getBoundingClientRect();
				x = Math.min(window.innerWidth - 340, Math.max(4, r.left));
				y = r.bottom + 4;
				above = r.bottom + 64 > window.innerHeight;
				anchorTop = r.top;
				text = t;
			}, 250);
		};
		const hide = () => { clearTimeout(timer); text = ''; cur = null; };
		document.addEventListener('pointerover', over);
		document.addEventListener('pointerdown', hide);
		document.addEventListener('keydown', hide);
		return () => { document.removeEventListener('pointerover', over); document.removeEventListener('pointerdown', hide); document.removeEventListener('keydown', hide); };
	});
</script>

{#if text}<div class="tip" bind:this={el} style="left: {x}px; top: {top}px">{text}</div>{/if}

<style>
	.tip { position: fixed; z-index: 1000; max-width: 336px; padding: 4px 6px; background: #22221f; color: var(--ink); border: 1px solid var(--border); font-size: 11px; line-height: 1.35; white-space: pre-wrap; pointer-events: none; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.5); }
</style>
