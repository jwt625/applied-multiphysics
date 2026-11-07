<script lang="ts">
	// SPDX-License-Identifier: GPL-3.0-or-later
	// Pointer and keyboard splitter: reports a size delta in px; arrows move 16 px.
	let { dir, onmove, label }: { dir: 'col' | 'row'; onmove: (delta: number) => void; label: string } = $props();
	let last = 0;
	function down(e: PointerEvent) {
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		last = dir === 'col' ? e.clientX : e.clientY;
	}
	function move(e: PointerEvent) {
		if (!(e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) return;
		const p = dir === 'col' ? e.clientX : e.clientY;
		onmove(p - last);
		last = p;
	}
	function key(e: KeyboardEvent) {
		const k: Record<string, number> = dir === 'col' ? { ArrowLeft: -16, ArrowRight: 16 } : { ArrowUp: -16, ArrowDown: 16 };
		const d = k[e.key];
		if (d) { e.preventDefault(); onmove(d); }
	}
</script>

<!-- a focusable separator is an interactive widget (WAI-ARIA window splitter) -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div class="sp {dir}" role="separator" aria-orientation={dir === 'col' ? 'vertical' : 'horizontal'} aria-label={label} tabindex="0" onpointerdown={down} onpointermove={move} onkeydown={key}></div>

<style>
	.sp { background: var(--line); flex: none; touch-action: none; }
	.sp:hover, .sp:focus-visible { background: var(--accent); outline: none; }
	.col { width: 3px; cursor: col-resize; }
	.row { height: 3px; cursor: row-resize; }
</style>
