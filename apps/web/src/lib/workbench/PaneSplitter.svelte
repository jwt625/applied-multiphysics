<script lang="ts">
	// SPDX-License-Identifier: GPL-3.0-or-later
	// Pane splitter (DevLog-020 s.1.1): WAI-ARIA window splitter. Drag with pointer capture; arrows move 16 px (Shift
	// 64 px), Home / End go to the min / max size, Enter or a double-click resets to the default size. The owner clamps
	// and stores the size; the splitter only reports the requested size in px.
	let {
		dir,
		label,
		size,
		min,
		max,
		sign = 1,
		onsize,
		onreset,
		onend
	}: {
		/** col: vertical bar between columns (resizes a width); row: horizontal bar (resizes a height) */
		dir: 'col' | 'row';
		label: string;
		/** current size of the pane this splitter controls, px */
		size: number;
		min: number;
		max: number;
		/** +1: the pane grows when the bar moves right / down; -1: when it moves left / up */
		sign?: 1 | -1;
		onsize: (px: number) => void;
		onreset: () => void;
		/** end of a drag or key step (persist here) */
		onend?: () => void;
	} = $props();

	let start: { p: number; size: number } | null = null;
	let active = $state(false);
	function down(e: PointerEvent) {
		if (e.button !== 0) return;
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		start = { p: dir === 'col' ? e.clientX : e.clientY, size };
		active = true;
		e.preventDefault();
	}
	function move(e: PointerEvent) {
		if (!start) return;
		const p = dir === 'col' ? e.clientX : e.clientY;
		onsize(start.size + sign * (p - start.p));
	}
	function up() {
		if (!start) return;
		start = null;
		active = false;
		onend?.();
	}
	function key(e: KeyboardEvent) {
		const step = e.shiftKey ? 64 : 16;
		const grow: Record<string, number> = dir === 'col' ? { ArrowRight: 1, ArrowLeft: -1 } : { ArrowDown: 1, ArrowUp: -1 };
		const k = grow[e.key];
		if (k) onsize(size + sign * k * step);
		else if (e.key === 'Home') onsize(min);
		else if (e.key === 'End') onsize(max);
		else if (e.key === 'Enter') onreset();
		else return;
		e.preventDefault();
		onend?.();
	}
</script>

<!-- a focusable separator is an interactive widget (WAI-ARIA window splitter) -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div class="sp {dir}" class:on={active} role="separator" aria-orientation={dir === 'col' ? 'vertical' : 'horizontal'} aria-label={label}
	aria-valuenow={Math.round(size)} aria-valuemin={Math.round(min)} aria-valuemax={Math.round(max)} tabindex="0"
	data-tip={`${label}: drag, or focus and use the arrow keys (Shift: 64 px, Home / End: min / max). Double-click or Enter: reset`}
	onpointerdown={down} onpointermove={move} onpointerup={up} onpointercancel={up} onlostpointercapture={up} ondblclick={onreset} onkeydown={key}></div>

<style>
	.sp { position: relative; background: var(--line); flex: none; touch-action: none; z-index: 2; }
	.sp:hover, .sp:focus-visible, .sp.on { background: var(--accent); outline: none; }
	/* 3 px bar, 9 px hit area */
	.sp::after { content: ''; position: absolute; }
	.col { width: 3px; cursor: col-resize; }
	.col::after { left: -3px; right: -3px; top: 0; bottom: 0; }
	.row { height: 3px; cursor: row-resize; }
	.row::after { top: -3px; bottom: -3px; left: 0; right: 0; }
</style>
