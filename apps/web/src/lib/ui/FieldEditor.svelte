<script lang="ts">
	// SPDX-License-Identifier: GPL-3.0-or-later
	// One schema-generated settings field (widgets from schema/form.ts). Every commit calls onset(pointer, value) once;
	// the caller turns it into one operation. Values keep their spec form ({value, unit}, "5 mm", expression, "N/A").
	import type { Field } from '../schema/form';
	import TextCommit from './TextCommit.svelte';

	let { f, onset, resolve, issue = '' }: { f: Field; onset: (pointer: string, v: unknown) => void; resolve: (v: unknown) => string; issue?: string } = $props();

	const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
	const str = (v: unknown) => (v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v));
	const num = (s: string) => (s.trim() === '' ? undefined : Number(s));

	function quantityFromText(s: string, prev: unknown): unknown {
		const t = s.trim();
		if (t === '') return undefined;
		if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(t)) return isObj(prev) && typeof prev.unit === 'string' ? { value: Number(t), unit: prev.unit } : Number(t);
		return t;
	}
	function jsonOrUndefined(s: string): unknown {
		if (s.trim() === '') return undefined;
		try { return JSON.parse(s); } catch { return s; }
	}
	const tipOf = (v: unknown) => `${f.description ?? f.key}${f.required ? ' (required)' : ''}\n${resolve(v)}${issue ? `\n${issue}` : ''}`;
</script>

<div class="row" class:bad={!!issue} data-key={f.key}>
	<span class="k" data-tip={tipOf(f.value)}>{f.key}{f.required ? '' : '?'}</span>
	<span class="v">
		{#if f.widget.kind === 'quantity'}
			{#if isObj(f.value) && typeof f.value.value === 'number'}
				{@const q = f.value as { value: number; unit: string }}
				<TextCommit mono value={String(q.value)} tip={tipOf(q)} invalid={!!issue} oncommit={(s) => onset(f.pointer, quantityFromText(s, q))} />
				<TextCommit mono width="64px" value={q.unit} tip="unit" oncommit={(u) => onset(f.pointer, { value: q.value, unit: u })} />
			{:else}
				<TextCommit mono value={str(f.value)} tip={tipOf(f.value)} invalid={!!issue} placeholder={`quantity [${f.widget.dim}]`} oncommit={(s) => onset(f.pointer, quantityFromText(s, f.value))} />
				<span class="dim u">[{f.widget.dim === '*' ? 'any' : f.widget.dim}]</span>
			{/if}
		{:else if f.widget.kind === 'vector'}
			{#if Array.isArray(f.value)}
				{#each f.value as c, i}
					<TextCommit mono value={str(c)} tip={tipOf(c)} oncommit={(s) => { const a = [...(f.value as unknown[])]; a[i] = quantityFromText(s, c); onset(f.pointer, a); }} />
				{/each}
			{:else if isObj(f.value) && Array.isArray(f.value.value)}
				{@const q = f.value as { value: number[]; unit: string }}
				{#each q.value as c, i}
					<TextCommit mono value={String(c)} tip={tipOf(q)} oncommit={(s) => { const a = [...q.value]; a[i] = Number(s); onset(f.pointer, { value: a, unit: q.unit }); }} />
				{/each}
				<TextCommit mono width="52px" value={q.unit} tip="unit" oncommit={(u) => onset(f.pointer, { value: q.value, unit: u })} />
			{:else}
				<TextCommit mono value={str(f.value)} tip={tipOf(f.value)} placeholder="[x, y] with units" oncommit={(s) => onset(f.pointer, jsonOrUndefined(s))} />
			{/if}
		{:else if f.widget.kind === 'selection' || f.widget.kind === 'idlist'}
			<TextCommit mono value={Array.isArray(f.value) ? f.value.join(' ') : ''} tip={`${f.widget.kind === 'selection' ? `entity ids (${f.widget.kinds.join(', ')}), space-separated` : 'ids, space-separated'}`} invalid={!!issue}
				oncommit={(s) => { const a = s.split(/[\s,]+/).filter(Boolean); onset(f.pointer, a.length ? a : undefined); }} />
		{:else if f.widget.kind === 'enum'}
			<select value={str(f.value)} data-tip={tipOf(f.value)} onchange={(e) => onset(f.pointer, (e.currentTarget as HTMLSelectElement).value || undefined)}>
				{#if !f.required}<option value=""></option>{/if}
				{#each f.widget.options as o}<option value={o}>{o}</option>{/each}
			</select>
		{:else if f.widget.kind === 'boolean'}
			<input type="checkbox" checked={f.value === true} onchange={(e) => onset(f.pointer, (e.currentTarget as HTMLInputElement).checked ? true : f.required ? false : undefined)} />
		{:else if f.widget.kind === 'number'}
			<TextCommit mono value={f.value === undefined ? '' : String(f.value)} tip={tipOf(f.value)} oncommit={(s) => onset(f.pointer, num(s))} />
		{:else if f.widget.kind === 'string'}
			<TextCommit value={str(f.value)} readonly={f.key === 'type'} tip={`${f.widget.untrusted ? 'free text (untrusted for agents)' : (f.widget.pattern ?? '')}`} oncommit={(s) => onset(f.pointer, s === '' ? undefined : s)} />
		{:else}
			<TextCommit mono value={f.value === undefined ? '' : JSON.stringify(f.value)} tip="JSON (valid YAML flow form)" oncommit={(s) => onset(f.pointer, jsonOrUndefined(s))} />
		{/if}
	</span>
</div>

<style>
	.row { display: grid; grid-template-columns: 96px minmax(0, 1fr); gap: 6px; align-items: center; min-height: 24px; }
	.k { color: var(--ink-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.bad .k { color: var(--crit); }
	.v { display: flex; gap: 3px; min-width: 0; align-items: center; }
	.u { font-size: 10px; white-space: nowrap; }
	select { flex: 1; }
</style>
