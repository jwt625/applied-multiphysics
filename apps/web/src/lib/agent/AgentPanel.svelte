<script lang="ts">
	// SPDX-License-Identifier: GPL-3.0-or-later
	// Agent chat panel (L9 DevLog-012 s.6.1): key entry (memory only by default, explicit opt-in to localStorage, never
	// echoed), messages rendered as text, Send / Stop, secret warning with Redact, budget line with editable cost caps
	// (estimates or N/A), per-turn Revert, prompt inspector of the memory included per turn. The panel is excluded from
	// screenshots: the screenshot tool captures the graphics canvas only.
	import { onMount } from 'svelte';
	import type { ChatController, ChatState, NavigationHost, ProviderAdapter } from '@amp/agent';
	import type { Session } from '../workbench/session.svelte';
	import { DEFAULT_CAPS, mountPanel } from './mount';
	import { agentStore } from './store.svelte';
	import { fmt } from '../gfx/ticks';

	let { s, nav, provider = null }: { s: Session; nav: (actor: string) => NavigationHost; provider?: ProviderAdapter | null } = $props();

	let chat = $state.raw<ChatController | null>(null);
	let st = $state.raw<ChatState | null>(null);
	let failed = $state('');
	let text = $state('');
	let keyDraft = $state('');
	let remember = $state(false);
	let secretWarn = $state(false);
	let caps = $state({ ...DEFAULT_CAPS });
	let listEl = $state<HTMLDivElement>();

	onMount(() => {
		let off: (() => void) | null = null;
		let alive = true;
		void mountPanel(s, nav, provider ? { provider } : {}).then((c) => {
			if (!alive) return;
			chat = c;
			off = c.subscribe((x) => { st = x; agentStore.tick++; queueMicrotask(() => listEl && (listEl.scrollTop = listEl.scrollHeight)); });
		}, (e) => (failed = (e as Error).message));
		return () => { alive = false; off?.(); if (agentStore.chat === chat) agentStore.chat = null; };
	});

	function setCaps() {
		if (!chat) return;
		// editable caps (L9 audit S4 defaults USD 1 per turn, USD 5 per session)
		chat.agent.budget.maxCostUSD = caps.maxCostUSD;
		chat.agent.budget.maxSessionCostUSD = caps.maxSessionCostUSD;
	}
	async function send() {
		if (!chat || !text.trim() || st?.busy) return;
		if (chat.hasSecret(text)) { secretWarn = true; return; }
		secretWarn = false;
		const t = text;
		text = '';
		try { await chat.send(t); } catch (e) { failed = (e as Error).message; }
	}
	function saveKey() {
		if (!chat || !keyDraft) return;
		chat.setKey(keyDraft, remember);
		keyDraft = '';
	}
	const turns = $derived([...new Set((st?.rows ?? []).filter((r) => r.kind === 'user').map((r) => r.turn))]);
	const money = (v: number | null | undefined) => (v === null || v === undefined ? 'N/A' : `USD ${v.toFixed(2)}`);
</script>

<div class="ap" data-agent-panel>
	{#if failed}<div class="crit msg">{failed}</div>{/if}
	{#if !chat}
		<div class="dim msg">{failed ? '' : 'mounting the agent...'}</div>
	{:else if st}
		<div class="key">
			{#if provider}
				<span class="dim" data-tip="Scripted test provider (@amp/agent ScriptedProvider): no network, no key">provider: scripted mock</span>
			{:else if st.hasKey}
				<span data-tip="The key is never shown. In memory: gone when the tab closes. Remembered: kept in this browser's localStorage">key: {st.keyPersisted ? 'remembered on this device' : 'in memory only'}</span>
				<label><input type="checkbox" checked={st.keyPersisted} onchange={(e) => chat?.setKeyPersist((e.currentTarget as HTMLInputElement).checked)} /> remember</label>
				<button onclick={() => chat?.clearKey()}>Clear key</button>
			{:else}
				<input type="password" autocomplete="off" spellcheck="false" placeholder="Anthropic API key" bind:value={keyDraft} data-tip="Bring your own key. Sent only to https://api.anthropic.com (the page CSP allows no other destination)" />
				<label data-tip="Explicit opt-in: store the key in this browser's localStorage"><input type="checkbox" bind:checked={remember} /> remember on this device</label>
				<button disabled={!keyDraft} onclick={saveKey}>Set</button>
			{/if}
		</div>
		<div class="budget mono" data-tip="Estimates from the provider's price table; N/A when a model has no price">
			{#if st.budget}calls {st.budget.modelCalls}/{st.budget.budget.maxModelCalls}, tools {st.budget.toolCalls}/{st.budget.budget.maxToolCalls}, tokens in/out/cache {st.budget.usage.inputTokens}/{st.budget.usage.outputTokens}/{st.budget.usage.cacheReadTokens}, turn {money(st.budget.costUSD)}, session {money(st.budget.sessionCostUSD)} (estimate){:else}no turn yet{/if}
			<span class="caps">caps USD <input type="number" min="0" step="0.5" bind:value={caps.maxCostUSD} onchange={setCaps} data-tip="cost cap per turn (estimate)" /> / <input type="number" min="0" step="1" bind:value={caps.maxSessionCostUSD} onchange={setCaps} data-tip="cost cap per session (estimate)" /></span>
		</div>
		<div class="rows" bind:this={listEl}>
			{#each st.rows as r, i (i)}
				{#if r.kind === 'user'}
					<div class="r user"><span class="who">you</span><span class="t">{r.text}</span>{#if turns.includes(r.turn)}<button class="rv" data-tip="Revert every spec and memory op of this agent turn (appends inverse ops as the user)" onclick={() => chat?.revertTurn(r.turn)}>revert turn</button>{/if}</div>
				{:else if r.kind === 'assistant'}
					<div class="r asst"><span class="who">agent</span><span class="t">{r.text}</span></div>
				{:else if r.kind === 'tool'}
					<div class="r tool" class:err={r.isError}><span class="who mono">{r.tool}</span><span class="t mono">{r.summary}</span></div>
				{:else if r.kind === 'repair'}
					<div class="r tool err"><span class="who">repair</span><span class="t">{r.problems.join('; ')}</span></div>
				{:else}
					<div class="r stop"><span class="who">stop</span><span class="t">{r.stop}{r.message ? `: ${r.message}` : ''}</span></div>
				{/if}
			{/each}
			{#if st.draft}<div class="r asst"><span class="who">agent</span><span class="t">{st.draft}</span></div>{/if}
			{#if st.included.length}
				<details class="insp"><summary>prompt inspector</summary>
					{#each st.included as inc}<div class="mono small">turn {inc.turn}: {inc.memory.length ? inc.memory.map((m) => `${m.name} (${m.why.join(', ')}${m.writtenBy ? `; by ${m.writtenBy}` : ''}${m.truncated ? '; truncated' : ''})`).join('; ') : 'no memory included'}</div>{/each}
				</details>
			{/if}
		</div>
		{#if secretWarn}
			<div class="warn sw">The message contains a credential-shaped string; it was not sent. <button onclick={() => { if (chat) { text = chat.redact(text); secretWarn = false; } }}>Redact</button></div>
		{/if}
		<div class="input">
			<textarea rows="3" bind:value={text} placeholder={provider || st.hasKey ? 'Ask the agent to change or run the model' : 'Set a key first'} onkeydown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(); } }}></textarea>
			<div class="btns">
				<button class="on" disabled={st.busy || !text.trim() || (!provider && !st.hasKey)} onclick={send} data-tip="Send (Ctrl/Cmd+Enter)">Send</button>
				<button disabled={!st.busy} onclick={() => chat?.abort()}>Stop</button>
				<span class="dim small">{st.busy ? 'running...' : st.lastStop ? `last stop: ${st.lastStop}` : ''}</span>
			</div>
		</div>
	{/if}
</div>

<style>
	.ap { position: absolute; inset: 0; display: flex; flex-direction: column; font-size: 11px; background: var(--surface); }
	.msg { padding: 8px; }
	.key { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; padding: 6px; border-bottom: 1px solid var(--line); }
	.key input[type='password'] { flex: 1; min-width: 120px; }
	.key label { display: flex; gap: 3px; align-items: center; color: var(--ink-2); }
	.budget { padding: 4px 6px; border-bottom: 1px solid var(--line); color: var(--ink-2); display: flex; flex-wrap: wrap; gap: 4px; align-items: center; font-size: 10px; }
	.caps { margin-left: auto; display: flex; gap: 3px; align-items: center; }
	.caps input { width: 44px; height: 18px; font-size: 10px; }
	.rows { flex: 1; min-height: 0; overflow: auto; padding: 4px 6px; display: flex; flex-direction: column; gap: 4px; }
	.r { display: grid; grid-template-columns: 48px minmax(0, 1fr) auto; gap: 6px; align-items: start; white-space: pre-wrap; overflow-wrap: anywhere; }
	.who { color: var(--ink-3); }
	.user .who { color: var(--accent); }
	.asst .who { color: #e0b05a; }
	.tool .t { color: var(--ink-2); font-size: 10px; }
	.err .t, .err .who { color: var(--crit); }
	.stop .t { color: var(--ink-3); }
	.rv { height: 18px; font-size: 10px; padding: 0 4px; }
	.insp { color: var(--ink-2); }
	.small { font-size: 10px; }
	.sw { padding: 4px 6px; border-top: 1px solid var(--warn); }
	.input { border-top: 1px solid var(--line); padding: 6px; display: flex; flex-direction: column; gap: 4px; }
	.input textarea { width: 100%; resize: vertical; font-family: var(--sans); font-size: 12px; }
	.btns { display: flex; gap: 4px; align-items: center; }
</style>
