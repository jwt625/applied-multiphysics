<script lang="ts">
	// SPDX-License-Identifier: GPL-3.0-or-later
	// Settings of the selected tree node: forms generated from the registry's JSON Schema (schema/form.ts), the
	// Parameters table, and read-only listings for provenance, assumptions and missing. Every commit is one operation.
	import { resolveQuantity, units } from '@amp/spec';
	import type { Session } from './session.svelte';
	import { SchemaWalker, type Field } from '../schema/form';
	import type { TreeNode } from '../state/tree';
	import { getAt, setOp } from '../state/diff';
	import { paramValue, paramViews } from '../state/params';
	import { scopeOf } from '../engine/spec-adapter';
	import { fmt } from '../gfx/ticks';
	import FieldEditor from '../ui/FieldEditor.svelte';
	import { loadMaterials, materialRows } from '../materials';
	import type { Library } from '@amp/materials';
	import ParamSlider from '../ui/ParamSlider.svelte';

	let { s, node, walker }: { s: Session; node: TreeNode | null; walker: SchemaWalker } = $props();
	const m = $derived(s.model);
	const data = $derived(m.data as Record<string, unknown> | null);
	const issues = $derived(m.parsed?.issues ?? []);
	const scope = $derived(scopeOf(m.parsed?.params ?? new Map()));

	function resolve(v: unknown): string {
		if (v === undefined) return 'not set';
		try {
			const r = resolveQuantity(v, scope);
			if (r.na) return 'N/A';
			return `= ${fmt(r.si, 6)} ${units.formatUnit(r.dim)} (SI)`;
		} catch (e) {
			return typeof v === 'object' ? '' : `${(e as Error).message}`;
		}
	}
	const issueAt = (p: string) => issues.filter((i) => i.pointer === p || i.pointer.startsWith(p + '/')).map((i) => i.message).join('\n');

	async function set(pointer: string, v: unknown) {
		const patch = setOp(m.data, pointer, v);
		if (patch.length) await m.apply(patch, `set ${pointer}`);
	}

	const fields = $derived.by((): Field[] => {
		if (!node || !data || node.kind === 'params') return [];
		const value = getAt(data, node.pointer);
		return walker.fields(data, node.pointer, value, new Set(node.childKeys ?? []));
	});
	const params = $derived(paramViews(data?.params as never, (m.originalData as { params?: never } | null)?.params));
	const paramInfo = $derived(m.parsed?.params);
	const listing = $derived(node && ['provenance', 'assumptions', 'missing'].includes(node.kind) ? getAt(data, node.pointer) : null);
	let matLib = $state.raw<Library | null>(null);
	let matIssues = $state<string[]>([]);
	$effect(() => { if (node?.kind === 'material' && !matLib) void loadMaterials().then((r) => { matLib = r.lib; matIssues = r.issues; }); });
	const mat = $derived.by(() => {
		if (node?.kind !== 'material' || !matLib) return null;
		const ref = (getAt(data, node.pointer) as { ref?: string } | undefined)?.ref;
		return ref ? (materialRows(matLib, ref) ?? { id: ref, name: '', rows: [] }) : null;
	});
	const nodeIssues = $derived(node ? issues.filter((i) => i.pointer === node.pointer || i.pointer.startsWith(node.pointer + '/')) : []);
</script>

<div class="set">
	{#if !node}
		<div class="dim pad">Select a node in the Model Builder.</div>
	{:else}
		<div class="hdr"><span class="t">{node.label}</span><span class="dim mono">{node.sub ?? ''}</span><span class="dim mono ptr" data-tip="JSON Pointer of this node">{node.pointer || '/'}</span></div>
		{#if nodeIssues.length}
			<div class="iss">{#each nodeIssues as i}<div class="crit" data-tip={i.pointer}>{i.line ? `${i.line}:${i.col} ` : ''}{i.dotted}: {i.message}</div>{/each}</div>
		{/if}
		{#if node.kind === 'params'}
			<div class="grp">
				{#each params as p (p.name)}
					{@const info = paramInfo?.get(p.name)}
					<ParamSlider {p} resolved={info ? `= ${fmt(info.si, 6)} ${units.formatUnit(info.dim)} (SI)` : ''} oncommit={(v) => set(p.pointer, paramValue(p, v))}
						onpreview={(v) => void m.dragStep(setOp(m.data, p.pointer, paramValue(p, v)), `drag ${p.name}`)} ondragend={() => s.finishDrag()} />
				{/each}
			</div>
		{:else if listing !== null}
			<pre class="lst mono">{JSON.stringify(listing, null, 1)}</pre>
		{:else}
			{#snippet group(fs: Field[], depth: number)}
				{#each fs as f (f.pointer)}
					{#if f.widget.kind === 'object' && depth < 4}
						<div class="sub" style="margin-left: {depth * 8}px">
							<div class="subh dim">{f.key}</div>
							{@render group(walker.fields(data, f.pointer, f.value ?? {}), depth + 1)}
						</div>
					{:else}
						<div style="margin-left: {depth * 8}px"><FieldEditor {f} onset={set} {resolve} issue={issueAt(f.pointer)} /></div>
					{/if}
				{/each}
			{/snippet}
			<div class="grp">{@render group(fields, 0)}</div>
			{#if mat}
				<div class="sub"><div class="subh dim">library: {mat.name || `${mat.id} not in materials/`}</div>
					{#each mat.rows as r}
						<div class="mrow" data-tip={r.tip}><span class="mono">{r.prop}</span><span class="mono" class:na={r.na}>{r.text}</span><span class="dim mono">{r.unit}</span></div>
					{/each}
					{#each matIssues as mi}<div class="crit">{mi}</div>{/each}
				</div>
			{/if}
			{#if node.kind === 'study'}
				<div class="sub"><div class="subh dim">readiness</div>
					{#if s.status === 'unavailable'}{#each s.reasons as r}<div class="na">{r}</div>{/each}
					{:else if s.status === 'solved'}<div>solved{s.staleSolution ? ' (stale)' : ''}</div>
					{:else}<div class="dim">not run (Compute)</div>{/if}
				</div>
			{/if}
		{/if}
	{/if}
</div>

<style>
	.set { padding: 6px 8px; display: flex; flex-direction: column; gap: 6px; }
	.pad { padding: 8px 0; }
	.hdr { display: flex; gap: 8px; align-items: baseline; border-bottom: 1px solid var(--line); padding-bottom: 4px; }
	.t { font-weight: 600; }
	.ptr { margin-left: auto; font-size: 10px; }
	.grp { display: flex; flex-direction: column; gap: 2px; }
	.sub { border-left: 1px solid var(--line); padding-left: 6px; margin: 2px 0; display: flex; flex-direction: column; gap: 2px; }
	.subh { font-size: 11px; }
	.iss { font-size: 11px; display: flex; flex-direction: column; gap: 2px; }
	.mrow { display: grid; grid-template-columns: 64px minmax(0, 1fr) 72px; gap: 6px; font-size: 11px; }
	.mrow span:nth-child(2) { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.lst { margin: 0; font-size: 11px; white-space: pre-wrap; color: var(--ink-2); }
</style>
