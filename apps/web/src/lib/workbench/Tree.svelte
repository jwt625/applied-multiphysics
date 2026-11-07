<script lang="ts">
	// SPDX-License-Identifier: GPL-3.0-or-later
	// Model Builder tree (generated from the spec, state/tree.ts). Arrow keys move, Enter/click selects.
	import type { TreeNode } from '../state/tree';
	let { nodes, selected, onselect, unavailable = false }: { nodes: TreeNode[]; selected: string; onselect: (p: string) => void; unavailable?: boolean } = $props();
	let closed = $state<Record<string, boolean>>({});
	const flat = $derived.by(() => {
		const out: Array<{ n: TreeNode; depth: number }> = [];
		const walk = (ns: TreeNode[], d: number) => { for (const n of ns) { out.push({ n, depth: d }); if (n.children.length && !closed[n.key]) walk(n.children, d + 1); } };
		walk(nodes, 0);
		return out;
	});
	function key(e: KeyboardEvent) {
		const i = flat.findIndex((r) => r.n.pointer === selected);
		if (e.key === 'ArrowDown' && i < flat.length - 1) { e.preventDefault(); onselect(flat[i + 1]!.n.pointer); }
		else if (e.key === 'ArrowUp' && i > 0) { e.preventDefault(); onselect(flat[i - 1]!.n.pointer); }
		else if (e.key === 'ArrowLeft' && i >= 0) closed[flat[i]!.n.key] = true;
		else if (e.key === 'ArrowRight' && i >= 0) closed[flat[i]!.n.key] = false;
	}
	const tipOf = (n: TreeNode) => `${n.pointer || '/'}${n.issues ? `\n${n.issues} validation issue(s)` : ''}${n.kind === 'results' && unavailable ? '\nresults unavailable (see Messages)' : ''}`;
</script>

<div class="tree" role="tree" tabindex="0" onkeydown={key}>
	{#each flat as { n, depth } (n.key)}
		<div class="row" class:sel={n.pointer === selected} role="treeitem" aria-selected={n.pointer === selected} tabindex="-1" style="padding-left: {4 + depth * 12}px" data-tip={tipOf(n)} onclick={() => onselect(n.pointer)} onkeydown={() => {}}>
			{#if n.children.length}
				<button class="tw" tabindex="-1" aria-label="toggle" onclick={(e) => { e.stopPropagation(); closed[n.key] = !closed[n.key]; }}>{closed[n.key] ? '+' : '-'}</button>
			{:else}<span class="tw"></span>{/if}
			<span class="lab" class:na={(n.kind === 'results' || n.kind === 'result') && unavailable}>{n.label}</span>
			{#if n.sub}<span class="sub dim">{n.sub}</span>{/if}
			{#if n.issues}<span class="iss crit">{n.issues}</span>{/if}
		</div>
	{/each}
</div>

<style>
	.tree { padding: 2px 0; outline: none; }
	.row { display: flex; align-items: center; gap: 4px; height: var(--row); cursor: default; white-space: nowrap; overflow: hidden; }
	.row:hover { background: var(--hover); }
	.sel, .sel:hover { background: var(--sel); }
	.tw { width: 14px; height: 14px; padding: 0; line-height: 12px; font-size: 11px; border: 0; background: transparent; color: var(--ink-3); flex: none; text-align: center; }
	.lab { overflow: hidden; text-overflow: ellipsis; }
	.sub { font-size: 11px; overflow: hidden; text-overflow: ellipsis; }
	.iss { margin-left: auto; margin-right: 6px; font-size: 10px; border: 1px solid var(--crit); padding: 0 3px; }
</style>
