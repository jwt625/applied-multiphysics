<script lang="ts">
	// SPDX-License-Identifier: GPL-3.0-or-later
	// Text input that commits on Enter or blur (one operation per commit), Escape restores.
	let { value, oncommit, mono = false, width = '', tip = '', placeholder = '', invalid = false, readonly = false }: { value: string; oncommit: (v: string) => void; mono?: boolean; width?: string; tip?: string; placeholder?: string; invalid?: boolean; readonly?: boolean } = $props();
	let draft = $state('');
	let editing = $state(false);
	const shown = $derived(editing ? draft : value);
	function commit() {
		if (!editing) return;
		editing = false;
		if (draft !== value) oncommit(draft);
	}
</script>

<input class:mono class:invalid {readonly} {placeholder} style={width ? `width:${width}` : ''} data-tip={tip} value={shown}
	onfocus={() => { draft = value; editing = true; }}
	oninput={(e) => (draft = (e.currentTarget as HTMLInputElement).value)}
	onblur={commit}
	onkeydown={(e) => { if (e.key === 'Enter') { commit(); (e.currentTarget as HTMLInputElement).blur(); } else if (e.key === 'Escape') { editing = false; (e.currentTarget as HTMLInputElement).blur(); } }} />

<style>
	input { flex: 1; min-width: 0; }
	.invalid { border-color: var(--crit); }
	input[readonly] { color: var(--ink-3); background: transparent; }
</style>
