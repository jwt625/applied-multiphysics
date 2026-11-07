<script lang="ts">
	// SPDX-License-Identifier: GPL-3.0-or-later
	// Bottom tabs: Messages (validation, readiness, missing evidence), Log (timestamp-first rows), Progress (worker
	// stages), Timeline (operation log), Table (probe points clicked in Results, DevLog-020). Each tab scrolls inside its
	// own box.
	import type { Session } from './session.svelte';
	import { appLog, tsShort } from '../state/log.svelte';
	import Timeline from './Timeline.svelte';
	import { navTrail } from '../state/nav.svelte';
	import MemoryTab from '../agent/MemoryTab.svelte';
	import type { ProbeTable } from '../state/probes.svelte';
	import { columns, toTsv } from '../post/probe';
	import { fmt } from '../gfx/ticks';
	import { unitLabel } from '../gfx/units';

	export type BottomTab = 'messages' | 'log' | 'progress' | 'timeline' | 'navigation' | 'memory' | 'table';
	let { s, tab = $bindable('messages'), onjump, probes = null }: { s: Session; tab?: BottomTab; onjump?: (pointer: string) => void; probes?: ProbeTable | null } = $props();
	const prow = $derived(probes?.rows ?? []);
	const pcols = $derived(columns(prow));
	const has3 = $derived(prow.some((r) => r.dim === 3));
	let copied = $state('');
	async function copyTsv() {
		const t = toTsv(prow);
		try { await navigator.clipboard.writeText(t); copied = `copied ${prow.length} row${prow.length === 1 ? '' : 's'}`; } catch { copied = 'clipboard unavailable: TSV in the Log'; appLog.info(`probe table TSV:\n${t}`); }
		setTimeout(() => (copied = ''), 2500);
	}
	let tbox = $state<HTMLDivElement>();
	$effect(() => {
		void prow.length;
		if (tab === 'table' && tbox) queueMicrotask(() => tbox && (tbox.scrollTop = tbox.scrollHeight));
	});
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
		{#each [['messages', `Messages${nMsg ? ` (${nMsg})` : ''}`], ['log', 'Log'], ['progress', 'Progress'], ['timeline', `Timeline (${s.model.ops.length})`], ['navigation', `Navigation (${navTrail.entries.length})`], ['memory', 'Memory'], ['table', `Table${prow.length ? ` (${prow.length})` : ''}`]] as [k, l]}
			<button role="tab" aria-selected={tab === k} class:on={tab === k} onclick={() => (tab = k as BottomTab)}>{l}</button>
		{/each}
	</div>
	<div class="body">
		{#if tab === 'messages'}
			<div class="scroll">
				{#if s.status === 'error'}<div class="m crit">{s.error}</div>{/if}
				{#each issues as i}
					<div class="m" role="button" tabindex="0" data-tip={`${i.pointer} (${i.code})`} onclick={() => onjump?.(i.pointer)} onkeydown={(e) => { if (e.key === 'Enter') onjump?.(i.pointer); }}><span class="crit">error</span> <span class="mono dim">{i.line ? `${i.line}:${i.col}` : ''}</span> {i.dotted || '(root)'}: {i.message}</div>
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
		{:else if tab === 'table'}
			<div class="tl">
				<div class="bar">
					<button disabled={!prow.length} onclick={copyTsv} data-tip="Copy the table as tab-separated values (header with units)">Copy TSV</button>
					<button disabled={!prow.length} onclick={() => probes?.clear()} data-tip="Remove every row">Clear</button>
					<span class="dim n">{copied || `${prow.length} point${prow.length === 1 ? '' : 's'}`}</span>
				</div>
				<div class="list" bind:this={tbox}>
					{#if !prow.length}<div class="m dim">No probe points. Click in the Results view to evaluate the shown field at a point (exact FE value).</div>
					{:else}
						<table class="pt mono">
							<thead><tr>{#each pcols as c}<th>{c}</th>{/each}<th></th></tr></thead>
							<tbody>
								{#each prow as r (r.n)}
									<tr data-tip={`${r.ts}; run ${r.run}`}>
										<td class="dim">{r.n}</td>
										<td class="num">{fmt(r.p[0] * prow[0]!.lu.f, 6)}</td><td class="num">{fmt(r.p[1] * prow[0]!.lu.f, 6)}</td>
										{#if has3}<td class="num">{r.dim === 3 ? fmt(r.p[2] * prow[0]!.lu.f, 6) : ''}</td>{/if}
										<td>{r.field}</td>
										<td class="num" class:na={r.value === null}>{r.value === null ? 'N/A' : fmt(r.value, 6)}</td>
										<td>{unitLabel(r.unit)}</td>
										<td>{r.dataset || '-'}</td>
										<td><button class="x" onclick={() => probes?.remove(r.n)} data-tip="Remove this row" aria-label="remove row">x</button></td>
									</tr>
								{/each}
							</tbody>
						</table>
					{/if}
				</div>
			</div>
		{:else if tab === 'memory'}
			<MemoryTab />
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
	.tl { position: absolute; inset: 0; display: flex; flex-direction: column; }
	.bar { display: flex; gap: 4px; align-items: center; padding: 3px 6px; border-bottom: 1px solid var(--line); flex: none; }
	.n { margin-left: auto; font-size: 11px; }
	.list { flex: 1; min-height: 0; overflow: auto; }
	.pt { border-collapse: collapse; font-size: 11px; }
	.pt th { position: sticky; top: 0; background: var(--surface-3); color: var(--ink-2); font-weight: normal; text-align: left; padding: 1px 10px 1px 8px; white-space: nowrap; border-bottom: 1px solid var(--line); }
	.pt td { padding: 0 10px 0 8px; white-space: nowrap; height: 18px; }
	.pt tr:hover td { background: var(--hover); }
	.pt td.num { text-align: right; }
	.x { height: 16px; padding: 0 5px; font-size: 10px; }
	.pg { display: grid; grid-template-columns: 84px 120px 160px minmax(0, 1fr); gap: 8px; align-items: center; padding: 1px 8px; font-size: 11px; }
	.pb { height: 6px; background: var(--surface-3); position: relative; }
	.pb span { position: absolute; inset: 0 auto 0 0; background: var(--accent); }
</style>
