<script lang="ts" module>
	export type TreeAction = 'delete' | 'duplicate' | 'toggle' | 'up' | 'down' | 'rename';
</script>

<script lang="ts">
	// SPDX-License-Identifier: GPL-3.0-or-later
	// Model Builder tree (generated from the spec, state/tree.ts). Arrow keys move, Enter/click selects.
	// Results (DevLog-027): "+" on folders and groups opens the add menu (results/plot-ops.ts, generated from the schema
	// unions; disabled entries say why); right-click (or the context-menu key) on a results node opens Delete,
	// Duplicate, Disable / Enable, Move up / down. Each entry is one operation, applied by the caller.
	// Model nodes (DevLog-051): "+" on Geometry, Materials, Physics and on a physics node (conditions); right-click on a
	// geometry feature, material, physics or condition opens Rename, Duplicate, Delete; F2 or double-click renames in
	// place (Enter commits, Escape cancels); Delete removes. The caller builds and applies the op (state/edit-ops.ts).
	import type { TreeNode } from '../state/tree';
	import type { MenuEntry } from '../results/plot-ops';
	import type { ModelMenuEntry } from '../state/edit-ops';
	type AnyEntry = MenuEntry | ModelMenuEntry;
	const MODEL = new Set(['feature', 'material', 'phys', 'bc']);
	const ADDS = new Set(['geometry', 'materials', 'physics', 'phys']);
	let {
		nodes,
		selected,
		onselect,
		unavailable = false,
		menu,
		onadd,
		onaction,
		active = '',
		deletes,
		onrename
	}: {
		nodes: TreeNode[];
		selected: string;
		onselect: (p: string) => void;
		unavailable?: boolean;
		/** add menu of a folder or group node (results) or of a model folder / physics node */
		menu?: (n: TreeNode) => AnyEntry[];
		onadd?: (e: AnyEntry) => void;
		onaction?: (n: TreeNode, a: TreeAction) => void;
		/** pointer of the plot group shown in the graphics pane */
		active?: string;
		/** ids a Delete removes (the node first, then the nodes that read it) */
		deletes?: (n: TreeNode) => string[];
		/** rename a model node (inline edit committed) */
		onrename?: (n: TreeNode, id: string) => void;
	} = $props();
	/** pointer of the node being renamed in place */
	let renaming = $state<string | null>(null);
	function startRename(n: TreeNode) { if (MODEL.has(n.kind) && onrename) { onselect(n.pointer); renaming = n.pointer; } }
	function commitRename(n: TreeNode, v: string) {
		if (renaming !== n.pointer) return;
		renaming = null;
		const id = v.trim();
		if (id && id !== n.label) onrename?.(n, id);
	}
	/** the inline rename field takes the focus with its text selected */
	const focusSel = (el: HTMLInputElement) => { queueMicrotask(() => { el.focus(); el.select(); }); };
	const canAdd = (n: TreeNode) => (n.addable || ADDS.has(n.kind)) && !!menu;
	let closed = $state<Record<string, boolean>>({});
	const flat = $derived.by(() => {
		const out: Array<{ n: TreeNode; depth: number }> = [];
		const walk = (ns: TreeNode[], d: number) => { for (const n of ns) { out.push({ n, depth: d }); if (n.children.length && !closed[n.key]) walk(n.children, d + 1); } };
		walk(nodes, 0);
		return out;
	});
	/** open popup: the add menu of a node, or the actions of a results node; at viewport px */
	let pop = $state.raw<{ kind: 'add'; n: TreeNode; entries: AnyEntry[]; x: number; y: number } | { kind: 'act'; n: TreeNode; x: number; y: number } | null>(null);
	function key(e: KeyboardEvent) {
		const i = flat.findIndex((r) => r.n.pointer === selected);
		if (e.key === 'Escape' && pop) { pop = null; return; }
		if (e.key === 'ArrowDown' && i < flat.length - 1) { e.preventDefault(); onselect(flat[i + 1]!.n.pointer); }
		else if (e.key === 'ArrowUp' && i > 0) { e.preventDefault(); onselect(flat[i - 1]!.n.pointer); }
		else if (e.key === 'ArrowLeft' && i >= 0) closed[flat[i]!.n.key] = true;
		else if (e.key === 'ArrowRight' && i >= 0) closed[flat[i]!.n.key] = false;
		else if ((e.key === 'Delete' || e.key === 'Backspace') && i >= 0 && (flat[i]!.n.kind === 'result' || MODEL.has(flat[i]!.n.kind)) && onaction) { e.preventDefault(); onaction(flat[i]!.n, 'delete'); }
		else if (e.key === 'F2' && i >= 0) { e.preventDefault(); startRename(flat[i]!.n); }
	}
	const tipOf = (n: TreeNode) => `${n.pointer || '/'}${n.issues ? `\n${n.issues} validation issue(s)` : ''}${n.kind === 'results' && unavailable ? '\nresults unavailable (see Messages)' : ''}${n.off ? '\ndisabled (enabled: false): not computed' : ''}${n.kind === 'result' ? '\nright-click: delete, duplicate, disable, move' : ''}${MODEL.has(n.kind) ? '\nright-click: rename (F2), duplicate, delete' : ''}`;
	function openAdd(e: MouseEvent, n: TreeNode) {
		e.stopPropagation();
		if (!menu) return;
		const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
		pop = { kind: 'add', n, entries: menu(n), x: r.right + 2, y: r.top };
	}
	function openAct(e: MouseEvent, n: TreeNode) {
		if ((n.kind !== 'result' && !MODEL.has(n.kind)) || !onaction) return;
		e.preventDefault();
		onselect(n.pointer);
		pop = { kind: 'act', n, x: e.clientX, y: e.clientY };
	}
	const MODEL_ACTS: Array<[TreeAction, string, string]> = [['rename', 'Rename', 'change the id; references to it are updated in the same operation (F2)'], ['duplicate', 'Duplicate', 'copy after this node with a new id'], ['delete', 'Delete', 'remove the node (refused while other nodes reference it; Undo restores it)']];
	const ACTS: Array<[TreeAction, string, string]> = [['duplicate', 'Duplicate', 'copy after this node with new ids'], ['toggle', '', ''], ['up', 'Move up', 'one place up in its list'], ['down', 'Move down', 'one place down in its list'], ['delete', 'Delete', 'remove the node (Undo restores it)']];
	/** keep the popup inside the window */
	const place = (x: number, y: number, h: number) => `left: ${Math.max(2, Math.min(x, (typeof window !== 'undefined' ? window.innerWidth : 1440) - 200))}px; top: ${Math.max(2, Math.min(y, (typeof window !== 'undefined' ? window.innerHeight : 900) - h - 4))}px`;
</script>

<svelte:window onpointerdown={(e) => { if (pop && !(e.target as HTMLElement).closest?.('.pop')) pop = null; }} />

<div class="tree" role="tree" tabindex="0" onkeydown={key}>
	{#each flat as { n, depth } (n.key)}
		<div class="row" class:sel={n.pointer === selected} class:act={!!active && n.pointer === active} role="treeitem" aria-selected={n.pointer === selected} tabindex="-1" style="padding-left: {4 + depth * 12}px" data-tip={tipOf(n)} onclick={() => onselect(n.pointer)} oncontextmenu={(e) => openAct(e, n)} ondblclick={() => startRename(n)} onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onselect(n.pointer); } else if (e.key === 'ContextMenu' && (n.kind === 'result' || MODEL.has(n.kind))) { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); pop = { kind: 'act', n, x: r.left + 40, y: r.bottom }; } }}>
			{#if n.children.length}
				<button class="tw" tabindex="-1" aria-label="toggle" onclick={(e) => { e.stopPropagation(); closed[n.key] = !closed[n.key]; }}>{closed[n.key] ? '+' : '-'}</button>
			{:else}<span class="tw"></span>{/if}
			{#if renaming === n.pointer}
				<input class="ren mono" value={n.label} {@attach focusSel} aria-label="new id" data-tip="New id: Enter renames (references are updated), Escape cancels"
					onclick={(e) => e.stopPropagation()} ondblclick={(e) => e.stopPropagation()}
					onkeydown={(e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); commitRename(n, (e.currentTarget as HTMLInputElement).value); } else if (e.key === 'Escape') { e.preventDefault(); renaming = null; } }}
					onblur={(e) => commitRename(n, (e.currentTarget as HTMLInputElement).value)} />
			{:else}
				<span class="lab" class:na={(n.kind === 'results' || n.kind === 'result') && unavailable} class:off={n.off}>{n.label}</span>
			{/if}
			{#if n.sub}<span class="sub dim">{n.sub}</span>{/if}
			{#if n.issues}<span class="iss crit">{n.issues}</span>{/if}
			{#if canAdd(n)}<button class="add" class:solo={!n.issues} tabindex="-1" aria-label="add" data-tip={n.kind === 'rfolder' || ADDS.has(n.kind) ? (n.kind === 'phys' ? `Add a boundary or domain condition to ${n.label}` : `Add to ${n.label}`) : `Add an item to ${n.label}`} onclick={(e) => openAdd(e, n)}>+</button>{/if}
		</div>
	{/each}
</div>

{#if pop?.kind === 'add'}
	{@const p = pop}
	<div class="pop" role="menu" style={place(p.x, p.y, 20 * p.entries.length + 4)}>
		{#each p.entries as e (e.type)}
			<button role="menuitem" disabled={!!e.disabled} data-tip={e.disabled ? `${e.tip}\nnot available: ${e.disabled}` : e.tip} onclick={() => { const x = e; pop = null; onadd?.(x); }}>{e.label}</button>
		{/each}
		{#if !p.entries.length}<div class="dim none">nothing to add here</div>{/if}
	</div>
{:else if pop?.kind === 'act'}
	{@const p = pop}
	<div class="pop" role="menu" style={place(p.x, p.y, 104)}>
		{#if MODEL.has(p.n.kind)}
			{#each MODEL_ACTS as [a, label, tip] (a)}
				<button role="menuitem" data-tip={tip} onclick={() => { const n = p.n; pop = null; if (a === 'rename') startRename(n); else onaction?.(n, a); }}>{label}</button>
			{/each}
		{:else}
		{#each ACTS as [a, label, tip] (a)}
			{@const del = a === 'delete' && deletes ? deletes(p.n) : []}
			<button role="menuitem" data-tip={a === 'toggle' ? (p.n.off ? 'compute this node again (removes enabled: false)' : 'enabled: false: the node and everything that reads it are not computed') : del.length > 1 ? `${tip}, with the nodes that read it: ${del.slice(1).join(', ')}` : tip} onclick={() => { const n = p.n; pop = null; onaction?.(n, a); }}>{a === 'toggle' ? (p.n.off ? 'Enable' : 'Disable') : del.length > 1 ? `Delete (+${del.length - 1})` : label}</button>
		{/each}
		{/if}
	</div>
{/if}

<style>
	.tree { padding: 2px 0; outline: none; }
	.row { display: flex; align-items: center; gap: 4px; height: var(--row); cursor: default; white-space: nowrap; overflow: hidden; user-select: none; }
	.row:hover { background: var(--hover); }
	.sel, .sel:hover { background: var(--sel); }
	.act .lab { box-shadow: inset 2px 0 0 var(--accent); padding-left: 4px; }
	.tw { width: 14px; height: 14px; padding: 0; line-height: 12px; font-size: 11px; border: 0; background: transparent; color: var(--ink-3); flex: none; text-align: center; }
	.lab { overflow: hidden; text-overflow: ellipsis; }
	.lab.off { color: var(--ink-3); text-decoration: line-through; }
	.sub { font-size: 11px; overflow: hidden; text-overflow: ellipsis; }
	.iss { margin-left: auto; margin-right: 6px; font-size: 10px; border: 1px solid var(--crit); padding: 0 3px; }
	.add { flex: none; width: 16px; height: 16px; padding: 0; margin-right: 4px; font-size: 12px; line-height: 14px; border: 1px solid var(--border); background: var(--surface-3); color: var(--ink-2); }
	.add.solo { margin-left: auto; }
	.add:hover { color: var(--ink); border-color: var(--accent); }
	.ren { flex: 1; min-width: 60px; height: 18px; padding: 0 3px; font-size: 12px; }
	.pop { position: fixed; z-index: 50; min-width: 150px; display: flex; flex-direction: column; background: var(--surface); border: 1px solid var(--border); padding: 2px; box-shadow: 0 4px 14px rgba(0, 0, 0, 0.5); }
	.pop button { height: 20px; text-align: left; border: 0; background: transparent; padding: 0 8px; font-size: 12px; color: var(--ink); }
	.pop button:hover:not(:disabled) { background: var(--hover); }
	.pop button:disabled { color: var(--ink-3); }
	.none { padding: 2px 8px; font-size: 11px; }
</style>
