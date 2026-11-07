<script lang="ts">
	// SPDX-License-Identifier: GPL-3.0-or-later
	// Bottom tabs: Messages (validation, readiness, missing evidence), Log (timestamp-first rows), Progress (worker
	// stages), Timeline (operation log). Each tab scrolls inside its own box.
	import type { Session } from './session.svelte';
	import { appLog, tsShort } from '../state/log.svelte';
	import Timeline from './Timeline.svelte';
	import { navTrail } from '../state/nav.svelte';

	export type BottomTab = 'messages' | 'log' | 'progress' | 'timeline' | 'navigation';
	let { s, tab = $bindable('messages'), onjump }: { s: Session; tab?: BottomTab; onjump?: (pointer: string) => void } = $props();
	const issues = $derived(s.model.parsed?.issues ?? []);
	const missing = $derived(((s.model.data as { missing?: unknown[] } | null)?.missing ?? []) as Array<string | { path?: string; what?: string }>);
	const nMsg = $derived(issues.length + (s.status === 'unavailable' ? s.reasons.length : 0) + (s.status === 'error' ? 1 : 0));
	let logBox = $state<HTMLDivElement>();
	$effect(() => {
		void appLog.rows.length;
		if (tab === 'log' && logBox) queueMicrotask(() => logBox && (logBox.scrollTop = logBox.scrollHeight));
	});
</script>

<div class="bp">
	<div class="tabs" role="tablist">
		{#each [['messages', `Messages${nMsg ? ` (${nMsg})` : ''}`], ['log', 'Log'], ['progress', 'Progress'], ['timeline', `Timeline (${s.model.ops.length})`], ['navigation', `Navigation (${navTrail.entries.length})`]] as [k, l]}
			<button role="tab" aria-selected={tab === k} class:on={tab === k} onclick={() => (tab = k as BottomTab)}>{l}</button>
		{/each}
	</div>
	<div class="body">
		{#if tab === 'messages'}
			<div class="scroll">
				{#if s.status === 'error'}<div class="m crit">{s.error}</div>{/if}
				{#each issues as i}
					<div class="m" role="button" tabindex="0" data-tip={`${i.pointer} (${i.code})`} onclick={() => onjump?.(i.pointer)} onkeydown={() => {}}><span class="crit">error</span> <span class="mono dim">{i.line ? `${i.line}:${i.col}` : ''}</span> {i.dotted || '(root)'}: {i.message}</div>
				{/each}
				{#if s.status === 'unavailable'}
					{#each s.reasons as r}<div class="m"><span class="na">unavailable</span> {r}</div>{/each}
				{/if}
				{#each missing as mi}
					<div class="m"><span class="warn">missing</span> {typeof mi === 'string' ? mi : `${mi.path ?? ''}: ${mi.what ?? ''}`}</div>
				{/each}
				{#if !nMsg && !missing.length}<div class="m dim">No messages.</div>{/if}
			</div>
		{:else if tab === 'log'}
			<div class="scroll mono" bind:this={logBox}>
				{#each appLog.rows as r}
					<div class="l"><span class="ts" data-tip={r.ts}>{tsShort(r.ts)}</span> <span class="lv lv-{r.level}">{r.level}</span> {r.msg}</div>
				{/each}
			</div>
		{:else if tab === 'progress'}
			<div class="scroll">
				{#each appLog.progress as p}
					<div class="pg"><span class="ts mono" data-tip={p.ts}>{tsShort(p.ts)}</span><span class="mono">{p.run}/{p.stage}</span><span class="pb"><span style="width: {Math.round(100 * p.frac)}%"></span></span><span class="dim">{p.msg ?? ''}</span></div>
				{/each}
				{#if !appLog.progress.length}<div class="m dim">No run yet.</div>{/if}
			</div>
		{:else if tab === 'navigation'}
			<div class="scroll mono">
				{#each navTrail.entries as e}
					<div class="l" data-tip="navigation changes UI state only; it is not in the operation log"><span class="ts" data-tip={e.ts}>{tsShort(e.ts)}</span> #{e.seq} {e.actor} {e.tool} {JSON.stringify(e.args)} <span class:crit={!e.ok}>{e.ok ? 'ok' : `failed: ${e.message ?? ''}`}</span></div>
				{/each}
				{#if !navTrail.entries.length}<div class="m dim">No navigation calls yet (agent tools focus_node, open_settings, highlight_selection, set_camera, set_view_mode, screenshot).</div>{/if}
			</div>
		{:else}
			<Timeline m={s.model} />
		{/if}
	</div>
</div>

<style>
	.bp { position: absolute; inset: 0; display: flex; flex-direction: column; background: var(--surface); }
	.tabs { display: flex; flex: none; border-bottom: 1px solid var(--line); }
	.tabs button { border: 0; border-right: 1px solid var(--line); background: transparent; height: 24px; color: var(--ink-2); }
	.tabs button.on { background: var(--surface-3); color: var(--ink); box-shadow: inset 0 -2px 0 var(--accent); }
	.body { position: relative; flex: 1; min-height: 0; }
	.scroll { position: absolute; inset: 0; overflow: auto; padding: 2px 0; }
	.m { padding: 1px 8px; font-size: 11px; }
	.m[role='button']:hover { background: var(--hover); cursor: pointer; }
	.l { padding: 0 8px; font-size: 11px; white-space: pre-wrap; }
	.ts { color: var(--ink-3); }
	.lv { display: inline-block; width: 36px; color: var(--ink-3); }
	.lv-warn { color: var(--warn); }
	.lv-error { color: var(--crit); }
	.pg { display: grid; grid-template-columns: 84px 120px 160px minmax(0, 1fr); gap: 8px; align-items: center; padding: 1px 8px; font-size: 11px; }
	.pb { height: 6px; background: var(--surface-3); position: relative; }
	.pb span { position: absolute; inset: 0 auto 0 0; background: var(--accent); }
</style>
