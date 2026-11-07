<script lang="ts">
	// SPDX-License-Identifier: GPL-3.0-or-later
	// Memory files of the agent (L9 amp-memlog/0): list, raw edit as the user (one memory op per save), the memory log
	// (timestamp-first rows with actor and reason), and "record outside edits" (refresh).
	import { agentStore } from './store.svelte';
	import { tsShort } from '../state/log.svelte';

	let sel = $state('');
	let draft = $state<string | null>(null);
	let msg = $state('');
	let ver = $state(0);
	const mem = $derived(agentStore.chat?.session.memory ?? null);
	const list = $derived.by(() => { void agentStore.tick; void ver; return mem ? mem.entries() : null; });
	const ops = $derived.by(() => { void agentStore.tick; void ver; return mem ? [...mem.ops].reverse() : []; });
	const cur = $derived(list?.entries.find((e) => e.file === sel) ?? null);
	async function rawText(file: string): Promise<string> {
		return (await mem!.backend.read(file)) ?? '';
	}
	async function open(file: string) {
		sel = file;
		draft = await rawText(file);
		msg = '';
	}
	async function save() {
		if (!mem || draft === null || !sel) return;
		try { await mem.writeText(sel, draft, { actor: 'user', reason: 'edited in the Memory tab' }); msg = 'saved (memory op appended)'; ver++; }
		catch (e) { msg = (e as Error).message; }
	}
	async function refresh() {
		if (!mem) return;
		const r = await mem.refresh();
		msg = `${r.length} outside edit(s) recorded`;
		ver++;
	}
</script>

<div class="mt">
	{#if !mem}
		<div class="dim pad">The agent panel is not mounted (Agent button in the toolbar). Memory files and their log appear here once it is.</div>
	{:else}
		<div class="files">
			<div class="bar"><button onclick={refresh} data-tip="Record files changed outside the app as `external` memory ops">Refresh</button></div>
			{#each list?.entries ?? [] as e (e.file)}
				<button class="f" class:sel={e.file === sel} onclick={() => open(e.file)} data-tip={`${e.description}\ntype ${e.type}, updated ${e.updated}, last writer ${mem.lastWriter(e.file) ?? 'n/a'}`}>{e.file}</button>
			{/each}
			{#each list?.invalid ?? [] as e}<div class="crit f" data-tip={e.error}>{e.file} (invalid)</div>{/each}
			{#if !list?.entries.length && !list?.invalid.length}<div class="dim pad">no memory files yet</div>{/if}
		</div>
		<div class="ed">
			{#if draft !== null}
				<div class="bar"><span class="mono">{sel}</span><button onclick={save} disabled={!cur && !sel}>Save</button><span class="dim">{msg}</span></div>
				<textarea spellcheck="false" bind:value={draft}></textarea>
			{:else}<div class="dim pad">{msg || 'select a file'}</div>{/if}
		</div>
		<div class="log mono">
			{#each ops as o (o.seq)}
				<div class="l" data-tip={o.ts}><span class="dim">{tsShort(o.ts)}</span> #{o.seq} {o.kind} {o.file} <span class:ag={o.actor.startsWith('agent:')}>{o.actor}</span>{o.reason ? `: ${o.reason}` : ''}</div>
			{/each}
			{#if !ops.length}<div class="dim">empty memory log</div>{/if}
		</div>
	{/if}
</div>

<style>
	.mt { position: absolute; inset: 0; display: grid; grid-template-columns: 200px minmax(0, 1fr) minmax(0, 1fr); font-size: 11px; }
	.pad { padding: 6px 8px; }
	.files, .ed, .log { min-height: 0; overflow: auto; border-right: 1px solid var(--line); }
	.ed { display: flex; flex-direction: column; }
	.bar { display: flex; gap: 6px; align-items: center; padding: 3px 6px; border-bottom: 1px solid var(--line); }
	.f { display: block; width: 100%; text-align: left; border: 0; background: transparent; height: 20px; font: 11px var(--mono); color: var(--ink-2); padding: 0 6px; }
	.f.sel { background: var(--sel); color: var(--ink); }
	textarea { flex: 1; min-height: 0; resize: none; border: 0; font-size: 11px; padding: 6px; }
	.l { padding: 0 6px; white-space: pre-wrap; }
	.ag { color: #e0b05a; }
	@media (max-width: 760px) { .mt { grid-template-columns: minmax(0, 1fr); grid-auto-rows: minmax(80px, auto); overflow: auto; } }
</style>
