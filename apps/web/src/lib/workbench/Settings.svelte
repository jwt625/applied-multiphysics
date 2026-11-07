<script lang="ts">
	// SPDX-License-Identifier: GPL-3.0-or-later
	// Settings of the selected tree node: forms generated from the registry's JSON Schema (schema/form.ts), the
	// Parameters table, and read-only listings for provenance, assumptions and missing. Every commit is one operation.
	// Results (DevLog-027): `x-amp-ref` fields are pickers of the ids they may name (compatible first; others disabled
	// with the reason); folders and groups list their add entries; results nodes have the tree actions as buttons.
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
	import { fmtMs } from '../gfx/ticks';
	import { refOptions, type MenuEntry } from '../results/plot-ops';
	import type { TreeAction } from './Tree.svelte';

	let { s, node, walker, menu, onadd, onaction, onshow, shown = '' }: {
		s: Session; node: TreeNode | null; walker: SchemaWalker;
		menu?: (n: TreeNode) => MenuEntry[]; onadd?: (e: MenuEntry) => void; onaction?: (n: TreeNode, a: TreeAction) => void;
		/** show a plot group in the graphics pane; `shown` = its pointer when shown */
		onshow?: (pointer: string) => void; shown?: string;
	} = $props();
	/** a union whose every alternative is a string (e.g. linegraph x: 'arc' or an expression) is edited as plain text */
	const stringOnly = (f: Field): boolean => {
		const alts = (f.schema.anyOf ?? f.schema.oneOf) as Array<Record<string, unknown>> | undefined;
		return !!alts?.length && alts.every((a0) => { const a = walker.deref(a0); return a.type === 'string' || typeof a.const === 'string'; });
	};
	const refKind = (f: Field): string | null => (typeof f.schema['x-amp-ref'] === 'string' ? (f.schema['x-amp-ref'] as string) : null);
	const addEntries = $derived(node && (node.kind === 'rfolder' || node.addable) && menu ? menu(node) : []);
	/** pointer of the plot group of a plot node (the group itself, or an item's group) */
	const plotGroup = $derived(node?.section === 'plots' && node.kind === 'result' ? node.pointer.replace(/\/items\/\d+$/, '') : '');
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
	/** dataset selector: shown on the study and result nodes while the session holds a sweep (DevLog-020 s.1.3) */
	const showDs = $derived(!!s.sweep && !!node && ['studies', 'study', 'results', 'result'].includes(node.kind));
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
					{:else if refKind(f)}
						{@const opts = refOptions(data, f.pointer, refKind(f)!)}
						{@const cur = typeof f.value === 'string' ? f.value : ''}
						<div class="ref" class:bad={!!issueAt(f.pointer)} style="margin-left: {depth * 8}px" data-key={f.key}>
							<span class="k" data-tip={`${f.description ?? f.key}${f.required ? ' (required)' : ''}${issueAt(f.pointer) ? `\n${issueAt(f.pointer)}` : ''}`}>{f.key}{f.required ? '' : '?'}</span>
							<select value={cur} data-tip={`id of a ${refKind(f)} (x-amp-ref); incompatible ids are disabled`} onchange={(e) => set(f.pointer, (e.currentTarget as HTMLSelectElement).value || undefined)}>
								{#if !f.required || !cur}<option value="">{f.required ? '(choose)' : '(group default)'}</option>{/if}
								{#if cur && !opts.some((o) => o.id === cur)}<option value={cur}>{cur} (not found)</option>{/if}
								{#each opts as o (o.id)}<option value={o.id} disabled={!o.ok && o.id !== cur}>{o.label}{o.ok ? '' : `: ${o.why}`}</option>{/each}
							</select>
						</div>
					{:else if f.widget.kind === 'snippet' && stringOnly(f) && (f.value === undefined || typeof f.value === 'string')}
						<div style="margin-left: {depth * 8}px"><FieldEditor f={{ ...f, widget: { kind: 'string', untrusted: false } }} onset={set} {resolve} issue={issueAt(f.pointer)} /></div>
					{:else}
						<div style="margin-left: {depth * 8}px"><FieldEditor {f} onset={set} {resolve} issue={issueAt(f.pointer)} /></div>
					{/if}
				{/each}
			{/snippet}
			{#if node.kind === 'result' && onaction}
				<div class="acts">
					{#if plotGroup && onshow}<button class:on={shown === plotGroup} data-tip="Show this plot group in the graphics pane" onclick={() => onshow(plotGroup)}>Show</button>{/if}
					<button data-tip="Copy after this node with new ids (one operation)" onclick={() => onaction(node, 'duplicate')}>Duplicate</button>
					<button data-tip={node.off ? 'Compute this node again (removes enabled: false)' : 'enabled: false: the node and everything that reads it are not computed'} onclick={() => onaction(node, 'toggle')}>{node.off ? 'Enable' : 'Disable'}</button>
					<button data-tip="Move one place up" onclick={() => onaction(node, 'up')}>Up</button>
					<button data-tip="Move one place down" onclick={() => onaction(node, 'down')}>Down</button>
					<button data-tip="Remove the node and every results node that reads it (one operation; Undo restores them)" onclick={() => onaction(node, 'delete')}>Delete</button>
				</div>
			{/if}
			<div class="grp">{@render group(fields, 0)}</div>
			{#if addEntries.length}
				<div class="sub"><div class="subh dim">add {node.kind === 'rfolder' ? `to ${node.label}` : 'item'}</div>
					<div class="adds">{#each addEntries as e (e.type)}<button disabled={!!e.disabled} data-tip={e.disabled ? `${e.tip}\nnot available: ${e.disabled}` : e.tip} onclick={() => onadd?.(e)}>{e.label}</button>{/each}</div>
				</div>
			{/if}
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
			{#if showDs && s.sweep}
				{@const sw = s.sweep}
				<div class="sub"><div class="subh dim" data-tip={`parametric study ${sw.studyId} over inner study ${sw.innerId}; axes row-major (first slowest)`}>dataset: {sw.studyId}, {sw.done}/{sw.points.length} points</div>
					<select class="ds" value={s.active} onchange={(e) => s.selectPoint(Number((e.currentTarget as HTMLSelectElement).value))} data-tip="Displayed dataset: the plot, colorbar, probes and headline numbers show this point">
						{#if s.active < 0 || s.status !== 'solving'}<option value={-1}>{sw.done ? 'base model (spec values)' : 'no dataset yet'}</option>{/if}
						{#each sw.points as p}<option value={p.index} disabled={!p.held && p.status !== 'solved'}>{p.label} ({p.index + 1}/{sw.points.length})</option>{/each}
					</select>
					<div class="dsl mono">
						{#each sw.points as p}
							<div class="dsr" class:on={p.index === s.active} role="button" tabindex="0" aria-disabled={!p.held && p.status !== 'solved'} data-tip={p.message || `${p.label}: ${p.status}${p.dof ? `, ${p.dof} DOF` : ''}${p.status === 'solved' && !p.held ? '; mesh and solution not held in memory (re-solved on selection); scalars kept' : ''}`}
								onclick={() => (p.held || p.status === 'solved') && s.selectPoint(p.index)} onkeydown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && (p.held || p.status === 'solved')) { e.preventDefault(); s.selectPoint(p.index); } }}>
								<span class="dim">{p.index + 1}</span><span>{p.label}</span><span class:na={p.status !== 'solved'} class="dim">{p.status === 'solved' ? `${fmtMs(p.ms)}${p.held ? '' : ' *'}` : p.status}</span>
							</div>
						{/each}
					</div>
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
	.ds { max-width: 100%; border-color: #e0a526; }
	.dsl { display: flex; flex-direction: column; font-size: 11px; }
	.dsr { display: grid; grid-template-columns: 22px minmax(0, 1fr) 72px; gap: 6px; padding: 0 4px; cursor: default; }
	.dsr:hover { background: var(--hover); }
	.dsr.on { background: var(--sel); }
	.ref { display: grid; grid-template-columns: 96px minmax(0, 1fr); gap: 6px; align-items: center; min-height: 24px; }
	.ref .k { color: var(--ink-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.ref.bad .k { color: var(--crit); }
	.ref select { min-width: 0; }
	.acts, .adds { display: flex; flex-wrap: wrap; gap: 3px; }
	.acts button, .adds button { height: 20px; padding: 0 6px; font-size: 11px; }
	.acts button.on { border-color: var(--accent); }
	.lst { margin: 0; font-size: 11px; white-space: pre-wrap; color: var(--ink-2); }
</style>
