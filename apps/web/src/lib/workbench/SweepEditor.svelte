<script lang="ts">
	// SPDX-License-Identifier: GPL-3.0-or-later
	// Parametric sweep editor (DevLog-051): the study to sweep and up to 4 swept params, each a value list or a range
	// (start, stop, n) in one unit. Apply writes the parametric study as one operation (state/sweep.ts setSweepPatch)
	// and makes it the study Compute runs; Remove deletes it (refused while results datasets read it). The draft
	// follows the spec until it is edited here.
	import { untrack } from 'svelte';
	import type { Session } from './session.svelte';
	import { paramViews } from '../state/params';
	import { newSweepDef, parametricStudies, parseValueList, removeSweepPatch, setSweepPatch, sweepCount, sweepDefOf, sweepProblem, type SweepDef } from '../state/sweep';
	import { appLog } from '../state/log.svelte';
	import { fmt } from '../gfx/ticks';
	import { poolSize } from '../engine/pool';

	let { s, id = null, inner = null }: { s: Session; /** existing parametric study */ id?: string | null; /** a new sweep of this study */ inner?: string | null } = $props();

	type Axis = SweepDef['axes'][number] & { text: string };
	type Draft = { id: string; study: string; axes: Axis[] };
	const data = $derived(s.model.data);
	const params = $derived(paramViews((data as { params?: never } | null)?.params, undefined));
	const studies = $derived(((data as { studies?: Array<{ id?: unknown; type?: unknown }> } | null)?.studies ?? []).filter((x) => typeof x.id === 'string' && x.type !== 'parametric').map((x) => x.id as string));
	const existing = $derived(parametricStudies(data).map((x) => x.id));

	const toDraft = (d: SweepDef): Draft => ({ ...d, axes: d.axes.map((a) => ({ ...a, text: a.values.join(', ') })) });
	const fromDraft = (d: Draft): SweepDef => ({ id: d.id.trim(), study: d.study, axes: d.axes.map(({ text, ...a }) => ({ ...a, values: a.mode === 'values' ? parseValueList(text) : [] })) });
	function initial(): Draft {
		const cur = id ? sweepDefOf(data, id) : null;
		if (cur) return toDraft(cur);
		const d = newSweepDef(data, params);
		return toDraft(inner ? { ...d, study: inner } : d);
	}
	let draft = $state<Draft>({ id: '', study: '', axes: [] });
	let dirty = $state(false);
	let msg = $state<{ text: string; bad: boolean } | null>(null);
	// the draft follows the spec (undo, YAML, agent edits) while it is untouched, and resets when another node opens
	let lastNode = '', lastSpec = '';
	$effect(() => {
		const node = `${id ?? ''}|${inner ?? ''}`;
		const spec = JSON.stringify(id ? sweepDefOf(data, id) : null);
		untrack(() => {
			if (node !== lastNode || (spec !== lastSpec && !dirty)) { draft = initial(); dirty = false; if (node !== lastNode) msg = null; }
			lastNode = node;
			lastSpec = spec;
		});
	});
	const isNew = $derived(!id || !existing.includes(id));
	const def = $derived(fromDraft(draft));
	const problem = $derived(sweepProblem(data, def, isNew));
	const count = $derived(problem ? 0 : sweepCount(def));
	const unitOf = (name: string) => { const p = params.find((x) => x.name === name); return p && p.unit !== '1' ? p.unit : ''; };
	function edit(f: () => void) { f(); dirty = true; msg = null; }
	function preview(a: Axis): string {
		const u = a.unit ? ` ${a.unit}` : '';
		if (a.mode === 'values') { const v = parseValueList(a.text); return v.length ? `${v.join(', ')}${u}` : ''; }
		const x0 = Number(a.start), x1 = Number(a.stop);
		if (!Number.isFinite(x0) || !Number.isFinite(x1) || !(a.n >= 2)) return `${a.start} .. ${a.stop}${u}, ${a.n} points`;
		const v = Array.from({ length: a.n }, (_, i) => x0 + ((x1 - x0) * i) / (a.n - 1));
		return `${v.slice(0, 8).map((x) => fmt(x, 4)).join(', ')}${v.length > 8 ? ', ...' : ''}${u}`;
	}
	async function apply() {
		const r = setSweepPatch(data, def);
		if (!r.ok) { msg = { text: r.reason, bad: true }; return; }
		if (!r.patch.length) { msg = { text: 'no change', bad: false }; return; }
		const op = await s.model.apply(r.patch, `${isNew ? 'add' : 'edit'} parametric sweep ${r.id}`);
		if (!op) { msg = { text: 'not applied (see Messages)', bad: true }; return; }
		s.study = r.id;
		dirty = false;
		if (isNew) draft = initial();
		msg = { text: `${isNew ? 'added' : 'updated'} ${r.id}: ${count} points; Compute runs it`, bad: false };
		appLog.info(`sweep ${r.id}: ${count} points over ${def.axes.map((a) => a.param).join(' x ')}; study picker set to ${r.id}`);
	}
	async function remove() {
		if (!id) return;
		const r = removeSweepPatch(data, id);
		if (!r.ok) { msg = { text: r.reason, bad: true }; return; }
		await s.model.apply(r.patch, `remove parametric sweep ${id}`);
		if (s.study === id) s.study = null;
	}
</script>

<div class="sw">
	<div class="subh dim" data-tip="A parametric study runs its inner study once per point; axes combine row-major (first slowest). Each point is a full solve.">{isNew ? 'new parametric sweep' : `parametric sweep ${id}`}</div>
	{#if isNew}
		<label class="r"><span class="k">id</span><input class="mono" value={draft.id} oninput={(e) => edit(() => (draft.id = e.currentTarget.value))} data-tip="Id of the new parametric study" /></label>
	{/if}
	<label class="r"><span class="k">study</span>
		<select value={draft.study} onchange={(e) => edit(() => (draft.study = e.currentTarget.value))} data-tip="Study solved at every point">
			{#if !draft.study}<option value="">(choose)</option>{/if}
			{#each studies as x (x)}<option value={x}>{x}</option>{/each}
		</select>
	</label>
	{#each draft.axes as a, i (i)}
		<div class="ax">
			<div class="r">
				<select class="mono" value={a.param} onchange={(e) => edit(() => { a.param = e.currentTarget.value; a.unit = unitOf(a.param); })} data-tip="Swept parameter">
					{#if !a.param}<option value="">(param)</option>{/if}
					{#each params as p (p.name)}<option value={p.name}>{p.name}</option>{/each}
				</select>
				<span class="seg">
					<button class:on={a.mode === 'values'} onclick={() => edit(() => (a.mode = 'values'))} data-tip="Explicit value list">list</button>
					<button class:on={a.mode === 'range'} onclick={() => edit(() => (a.mode = 'range'))} data-tip="n points from start to stop, inclusive">range</button>
				</span>
				<input class="mono unit" value={a.unit} oninput={(e) => edit(() => (a.unit = e.currentTarget.value.trim()))} placeholder="unit" data-tip={`Unit of the values (the param's unit: ${unitOf(a.param) || 'none'}); empty for unitless values or values with their own units`} />
				<button class="x" onclick={() => edit(() => draft.axes.splice(i, 1))} data-tip="Remove this axis" aria-label="remove axis">x</button>
			</div>
			{#if a.mode === 'values'}
				<input class="mono" value={a.text} oninput={(e) => edit(() => (a.text = e.currentTarget.value))} placeholder="1, 2, 5" data-tip="Values separated by commas, semicolons or spaces; a value may carry its own unit or be an expression of params" />
			{:else}
				<div class="r rng">
					<input class="mono" value={a.start} oninput={(e) => edit(() => (a.start = e.currentTarget.value))} placeholder="start" data-tip="Start (inclusive)" />
					<input class="mono" value={a.stop} oninput={(e) => edit(() => (a.stop = e.currentTarget.value))} placeholder="stop" data-tip="Stop (inclusive)" />
					<input class="mono n" type="number" min="2" step="1" value={a.n} oninput={(e) => edit(() => (a.n = Math.round(Number(e.currentTarget.value))))} data-tip="Number of points (>= 2)" />
				</div>
			{/if}
			<div class="pv dim mono" data-tip={preview(a)}>{preview(a)}</div>
		</div>
	{/each}
	<div class="r acts">
		<button disabled={draft.axes.length >= 4} onclick={() => edit(() => draft.axes.push({ param: '', mode: 'values', values: [], start: '', stop: '', n: 5, unit: '', text: '' }))} data-tip="Add a swept parameter (at most 4)">+ axis</button>
		<span class="cnt" class:warn={count > 50} data-tip={count > 50 ? 'Each point is one full solve; large sweeps take long' : 'Points (product of the axes)'}>{problem ? '' : `${count} point${count === 1 ? '' : 's'}`}</span>
		<span class="gap"></span>
		<select class="wk" value={s.sweepWorkers === null ? 'auto' : String(s.sweepWorkers)} onchange={(e) => { const v = e.currentTarget.value; s.sweepWorkers = v === 'auto' ? null : Number(v); }} data-tip={`Points solved at once in parallel workers (auto: min(points, 4, cores - 1, memory GB / 2) = ${poolSize(Math.max(1, count))} here; 1 = one after another). Each worker holds its own mesh and solver memory. Not stored in the model.`}>
			<option value="auto">auto</option>{#each [1, 2, 3, 4] as n (n)}<option value={String(n)}>{n} worker{n === 1 ? '' : 's'}</option>{/each}
		</select>
		{#if !isNew}<button onclick={remove} data-tip="Delete this parametric study (one operation; Undo restores it)">Remove</button>{/if}
		<button class="pri" disabled={!!problem || (!dirty && !isNew)} onclick={apply} data-tip={problem || 'Write the sweep into the model (one operation) and make it the study Compute runs'}>{isNew ? 'Add sweep' : 'Apply'}</button>
	</div>
	{#if problem && dirty}<div class="m na">{problem}</div>{/if}
	{#if msg}<div class="m" class:crit={msg.bad}>{msg.text}</div>{/if}
</div>

<style>
	.sw { display: flex; flex-direction: column; gap: 3px; border-left: 1px solid var(--line); padding-left: 6px; margin: 2px 0; }
	.subh { font-size: 11px; }
	.r { display: flex; align-items: center; gap: 4px; min-width: 0; }
	.k { width: 40px; color: var(--ink-2); font-size: 11px; flex: none; }
	.r input, .r select { min-width: 0; flex: 1; height: 20px; font-size: 11px; }
	.ax > input { width: 100%; height: 20px; font-size: 11px; }
	.ax { display: flex; flex-direction: column; gap: 2px; padding: 3px 0; border-top: 1px solid var(--line); }
	.unit { max-width: 56px; }
	.n { max-width: 48px; }
	.seg { display: inline-flex; flex: none; }
	.seg button { height: 20px; font-size: 11px; padding: 0 5px; }
	.seg button.on { border-color: var(--accent); color: var(--ink); }
	.x { height: 20px; width: 20px; padding: 0; font-size: 11px; flex: none; }
	.pv { font-size: 10px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.acts button { height: 20px; font-size: 11px; padding: 0 6px; }
	.pri { border-color: var(--accent); }
	.cnt { font-size: 11px; color: var(--ink-2); }
	.cnt.warn { color: var(--warn); }
	.gap { flex: 1; }
	.wk { height: 20px; font-size: 11px; }
	.m { font-size: 11px; }
</style>
