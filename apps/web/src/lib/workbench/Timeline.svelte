<script lang="ts">
	// SPDX-License-Identifier: GPL-3.0-or-later
	// Operation timeline (A4, R5 s.4.2): one row per operation, timestamp first; expand for the patch, old -> new values,
	// invalidated artifacts, validation and hashes; revert per operation (appends the inverse), undo and redo.
	import type { Operation } from '@amp/spec/types';
	import type { ModelState } from '../state/model.svelte';
	import { appLog, tsShort } from '../state/log.svelte';
	let { m }: { m: ModelState } = $props();
	let open = $state<Record<number, boolean>>({});
	let filter = $state<'all' | 'user' | 'agent'>('all');
	const rows = $derived([...m.ops].reverse().filter((o) => filter === 'all' || (filter === 'agent' ? o.actor.startsWith('agent:') : o.actor === 'user')));
	const nAgent = $derived(m.ops.filter((o) => o.actor.startsWith('agent:')).length);
	const effects = $derived(Object.fromEntries(m.ops.map((o) => [o.seq, m.effectOf(o.seq)])) as Record<number, string | null>);
	/** Value before the op: the inverse restores it with a non-test op carrying a value at the same path. */
	function oldValue(op: Operation, path: string): unknown {
		const q = op.inverse.find((x) => x.path === path && x.op !== 'test' && 'value' in x);
		return q && 'value' in q ? q.value : undefined;
	}
	const show = (v: unknown) => (v === undefined ? '' : JSON.stringify(v));
	async function revert(op: Operation) {
		const r = await m.revert(op.seq);
		if (!r) appLog.warn(`revert #${op.seq} refused: ${m.refused[op.seq]}`);
	}
	function download() {
		const b = new Blob([m.jsonl()], { type: 'application/x-ndjson' });
		const a = document.createElement('a');
		a.href = URL.createObjectURL(b);
		a.download = `${m.id}-oplog.jsonl`;
		a.click();
		URL.revokeObjectURL(a.href);
	}
</script>

<div class="tl">
	<div class="bar">
		<button disabled={!m.canUndo} onclick={() => m.undo()} data-tip="Undo (Ctrl/Cmd+Z): appends the inverse of the newest operation">Undo</button>
		<button disabled={!m.canRedo} onclick={() => m.redo()} data-tip="Redo (Shift+Ctrl/Cmd+Z)">Redo</button>
		<button onclick={download} data-tip="Download the hash-chained log (amp-oplog/1 JSONL)">JSONL</button>
		<select bind:value={filter} data-tip="Filter by actor">
			<option value="all">all actors</option><option value="user">user</option><option value="agent">agent ({nAgent})</option>
		</select>
		<span class="dim n">{m.ops.length} ops</span>
	</div>
	<div class="list">
		{#if !rows.length}<div class="dim pad">No operations yet. Every edit from forms, sliders, drags or the YAML tab appears here.</div>{/if}
		{#each rows as op (op.seq)}
			<div class="op" class:invalid={!op.validation.ok} class:agent={op.actor.startsWith('agent:')}>
				<div class="r" role="button" tabindex="0" onclick={() => (open[op.seq] = !open[op.seq])} onkeydown={(e) => e.key === 'Enter' && (open[op.seq] = !open[op.seq])}>
					<span class="ts mono" data-tip={op.ts}>{tsShort(op.ts)}</span>
					<span class="seq mono">#{op.seq}</span>
					<span class="kind k-{op.kind}">{op.kind}{op.target ? ` #${op.target}` : ''}</span>
					<span class="actor mono" data-tip={op.actor.startsWith('agent:') ? `agent operation (${op.actor}); reason required` : 'user operation'}>{#if op.actor.startsWith('agent:')}<span class="ag">agent</span> {op.actor.slice(6)}{:else}{op.actor}{/if}</span>
					<span class="why">{op.reason ?? op.patch.filter((p) => p.op !== 'test').map((p) => p.path).join(', ')}</span>
					<span class="inv dim" data-tip="invalidated artifacts">{op.invalidates.join(' ')}</span>
					<span class="eff eff-{effects[op.seq]}" data-tip={`effect: ${effects[op.seq] ?? 'n/a (redo record)'}${op.coalesced ? `; ${op.coalesced} drag steps merged` : ''}`}>{effects[op.seq] ?? ''}{op.coalesced ? ` x${op.coalesced}` : ''}</span>
					{#if op.kind === 'redo'}<span class="dim rv0" data-tip="redo records are not revertible (amp-oplog/1); undo instead">-</span>
					{:else}
						<button class="rv" onclick={(e) => { e.stopPropagation(); void revert(op); }} data-tip="Revert: append the inverse of this operation (refused, with the reason, when a later edit conflicts)">revert</button>
					{/if}
				</div>
				{#if m.refused[op.seq]}<div class="ref crit mono">revert refused: {m.refused[op.seq]}</div>{/if}
				{#if open[op.seq]}
					<div class="det mono">
						{#each op.patch.filter((p) => p.op !== 'test') as p}
							<div><span class="po">{p.op}</span> {p.path}{'from' in p ? ` from ${p.from}` : ''}: <span class="old">{show(oldValue(op, p.path))}</span> -&gt; <span class="new">{'value' in p ? show(p.value) : ''}</span></div>
						{/each}
						<div class="dim">validation: {op.validation.ok ? 'ok' : `${op.validation.errors.length} issues`}{op.validation.ok ? '' : `: ${op.validation.errors.slice(0, 3).join('; ')}`}</div>
						<div class="dim">text: at {op.text.at}, -{op.text.del.length} +{op.text.ins.length} chars; spec {op.before.slice(0, 8)} -&gt; {op.after.slice(0, 8)}; hash {op.hash.slice(0, 12)} (prev {op.prev.slice(0, 12)})</div>
					</div>
				{/if}
			</div>
		{/each}
	</div>
</div>

<style>
	.tl { position: absolute; inset: 0; display: flex; flex-direction: column; }
	.bar { display: flex; gap: 4px; align-items: center; padding: 3px 6px; border-bottom: 1px solid var(--line); flex: none; }
	.n { margin-left: auto; font-size: 11px; }
	.list { flex: 1; min-height: 0; overflow: auto; }
	.pad { padding: 6px 8px; }
	.r { display: grid; grid-template-columns: 84px 36px 70px 110px minmax(0, 1fr) auto auto auto; gap: 6px; align-items: center; height: var(--row); padding: 0 6px; cursor: default; }
	.r:hover { background: var(--hover); }
	.ts, .seq { color: var(--ink-3); font-size: 11px; }
	.actor { font-size: 11px; color: var(--ink-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.why { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.inv { font-size: 10px; white-space: nowrap; }
	.k-undo, .k-redo, .k-revert { color: var(--warn); }
	.invalid .why { color: var(--crit); }
	.agent { box-shadow: inset 3px 0 0 #c08a2a; background: rgba(192, 138, 42, 0.06); }
	.ag { color: #e0b05a; border: 1px solid #c08a2a; padding: 0 3px; font-size: 10px; }
	.rv0 { width: 46px; text-align: center; }
	.eff { font-size: 10px; color: var(--ink-3); white-space: nowrap; }
	.eff-undone, .eff-reverted { color: var(--warn); }
	.ref { padding: 0 8px 2px 132px; font-size: 11px; overflow-wrap: anywhere; }
	.rv { height: 18px; padding: 0 6px; font-size: 11px; }
	.det { padding: 2px 8px 6px 132px; font-size: 11px; display: flex; flex-direction: column; gap: 1px; overflow-wrap: anywhere; }
	.po { color: var(--accent); }
	.old { color: var(--crit); }
	.new { color: var(--good); }
</style>
