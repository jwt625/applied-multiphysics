<script lang="ts">
	// SPDX-License-Identifier: GPL-3.0-or-later
	// YAML tab: edit the canonical text; Apply (Ctrl/Cmd+Enter) diffs it against the model and appends one operation
	// that the op log writes back by comment-preserving splice (the typed bytes are never pasted over the model).
	import type { ModelState } from '../state/model.svelte';
	let { m }: { m: ModelState } = $props();
	let draft = $state<string | null>(null);
	let msg = $state('');
	const text = $derived(draft ?? m.text);
	const dirty = $derived(draft !== null && draft !== m.text);
	async function apply() {
		if (draft === null) return;
		const r = await m.applyYaml(draft);
		if (r.error) { msg = r.error; return; }
		msg = r.op ? `op #${r.op.seq} applied${r.reformatted ? '; text re-spliced by the op log (formatting differences dropped)' : ''}` : 'no change';
		draft = null;
	}
</script>

<div class="y">
	<div class="bar">
		<button disabled={!dirty} onclick={apply} data-tip="Apply the edit as one operation (Ctrl/Cmd+Enter)">Apply</button>
		<button disabled={draft === null} onclick={() => { draft = null; msg = ''; }} data-tip="Discard the draft">Revert draft</button>
		<span class="msg" class:crit={msg && !msg.startsWith('op') && msg !== 'no change'}>{msg}</span>
	</div>
	<textarea spellcheck="false" value={text} oninput={(e) => (draft = (e.currentTarget as HTMLTextAreaElement).value)}
		onkeydown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); void apply(); } }}></textarea>
</div>

<style>
	.y { position: absolute; inset: 0; display: flex; flex-direction: column; }
	.bar { display: flex; gap: 4px; align-items: center; padding: 3px 6px; border-bottom: 1px solid var(--line); flex: none; }
	.msg { font-size: 11px; color: var(--ink-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	textarea { flex: 1; min-height: 0; resize: none; border: 0; padding: 6px 8px; font-size: 11px; line-height: 1.45; background: var(--bg); white-space: pre; overflow: auto; tab-size: 2; }
</style>
