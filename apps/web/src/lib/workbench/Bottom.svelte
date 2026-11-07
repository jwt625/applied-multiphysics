<script lang="ts">
	// SPDX-License-Identifier: GPL-3.0-or-later
	// Bottom tabs: Messages (validation, readiness, missing evidence), Log (timestamp-first rows), Progress (worker
	// stages), Timeline (operation log), Table (probe points clicked in Results, DevLog-020; and since lane R3, DevLog-028,
	// one sub-tab per table / evaluation group of the spec, computed in the post worker on the displayed dataset, session
	// memory only, no export; probe rows can be pinned into a cutpoint dataset + point evaluation by one user op). Each
	// tab scrolls inside its own box.
	import type { Session } from './session.svelte';
	import { appLog, tsShort } from '../state/log.svelte';
	import Timeline from './Timeline.svelte';
	import { navTrail } from '../state/nav.svelte';
	import MemoryTab from '../agent/MemoryTab.svelte';
	import type { ProbeTable } from '../state/probes.svelte';
	import { columns, toTsv } from '../post/probe';
	import { fmt } from '../gfx/ticks';
	import { unitLabel } from '../gfx/units';
	import { resultsOf } from '@amp/spec';
	import { resultsClient, runOf, runStudies, type CellMeta, type ResultTable } from '../results/api.ts';
	import { pinPatch, PIN_GROUP } from '../results/eval-pin.ts';

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
	// ---- evaluation tables (sub-tabs next to the probe rows) ----
	let sub = $state('probes');
	const tableList = $derived.by(() => {
		const r = resultsOf(s.model.data);
		const fromTable = new Set(r.tables.map((t) => t.from));
		return [
			...r.tables.filter((t) => typeof t.id === 'string').map((t) => ({ id: t.id, label: t.label ?? t.id, tip: `table ${t.id} of evaluation group ${t.from}${t.enabled === false ? ' (disabled)' : ''}` })),
			...r.evaluations.filter((g) => typeof g.id === 'string' && !fromTable.has(g.id)).map((g) => ({ id: g.id, label: g.label ?? g.id, tip: `evaluation group ${g.id} (${Array.isArray(g.items) ? g.items.length : 0} items)${g.enabled === false ? ' (disabled)' : ''}` })),
		];
	});
	$effect(() => { if (sub !== 'probes' && !tableList.some((t) => t.id === sub)) sub = 'probes'; });
	let tbl = $state.raw<ResultTable | null>(null);
	let tblErr = $state('');
	let tblBusy = $state(false);
	let tok = 0;
	$effect(() => {
		const id = sub, data = s.model.data, sol = s.solution, mesh = s.mesh, params = s.activeParams, label = s.activeLabel;
		if (tab !== 'table' || id === 'probes') return;
		const my = ++tok;
		tblBusy = true;
		void (async () => {
			try {
				const run = await runOf({ solution: sol, mesh, activeParams: params, activeLabel: label, model: { data } });
				if (!run) { if (my === tok) { tbl = null; tblErr = 'No solution on the shown mesh: Compute first.'; } return; }
				const t = await resultsClient(s.post).table(data, id, [run]);
				if (my === tok) { tbl = t; tblErr = ''; }
			} catch (e) { if (my === tok) { tbl = null; tblErr = (e as Error).message; } }
			finally { if (my === tok) tblBusy = false; }
		})();
	});
	const head = (c: { name: string; unit: string }) => (c.unit ? `${c.name} (${unitLabel(c.unit)})` : c.name);
	const cellText = (v: number | string | null) => (v === null ? 'N/A' : typeof v === 'number' ? fmt(v, 7) : v);
	function cellTip(t: ResultTable, ri: number, ci: number): string {
		const r = t.rows[ri]!, c = t.columns[ci]!, m: CellMeta | null = r.meta[ci] ?? null, e = r.errors[ci];
		const lines = [c.tip];
		if (c.kind === 'step' || c.kind === 'index') lines.push(`solution step ${r.step}`);
		if (e) lines.push(`not evaluated: ${e}`);
		if (m) {
			lines.push(`SI ${m.si.toPrecision(10)} ${m.siUnit}`);
			if (m.method) lines.push(`method ${m.method}${m.n !== undefined ? `, ${m.n} points` : ''}${m.continuous === false ? ', discontinuous across elements' : ''}`);
			if (m.at) lines.push(`at (${m.at.map((x) => x.toPrecision(5)).join(', ')}) m`);
			if (m.nOutside) lines.push(`${m.nOutside} points outside the mesh (skipped)`);
			if (m.nNaN) lines.push(`${m.nNaN} NaN points`);
			if (m.coverage) lines.push(`line inside the mesh: ${m.coverage.covered.toPrecision(6)} of ${m.coverage.length.toPrecision(6)} m`);
			if (m.measure) lines.push(`measure ${m.measure.value.toPrecision(6)} ${m.measure.unit}`);
		}
		return lines.join('\n');
	}
	// ---- pin probe rows (one user op) ----
	let pinMsg = $state('');
	async function pin(rows: typeof prow) {
		const data = s.model.data, sol = s.solution, mesh = s.mesh;
		if (!rows.length || !mesh) return;
		const studies = runStudies(data);
		const st = ((data as { studies?: Array<{ id?: string; physics?: string[] }> } | null)?.studies ?? []).find((x) => x.id === studies[0]);
		const physicsId = st?.physics?.length === 1 ? st.physics[0] : undefined;
		const { patch, items, skipped } = pinPatch(data, rows, {
			studies, ...(physicsId ? { physicsId } : {}), axisym: !!mesh.axisym, dim: mesh.dim, eigen: sol?.steps?.kind === 'eigen',
			components: (f) => sol?.fields.find((x) => x.name === f)?.components,
		});
		if (!patch.length) { pinMsg = `nothing pinned: ${skipped.map((k) => `#${k.n} ${k.reason}`).join('; ')}`; return; }
		const op = await s.model.apply(patch, `pin probe ${rows.map((r) => `#${r.n}`).join(', ')} as ${items.join(', ')}`);
		pinMsg = op ? `pinned ${items.join(', ')} in ${PIN_GROUP}${skipped.length ? `; skipped ${skipped.map((k) => `#${k.n}`).join(', ')}` : ''}` : 'pin failed (see Messages)';
		if (op) sub = PIN_GROUP;
		setTimeout(() => (pinMsg = ''), 4000);
	}
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
					<div class="subs" role="tablist">
						<button role="tab" aria-selected={sub === 'probes'} class:on={sub === 'probes'} onclick={() => (sub = 'probes')} data-tip="Probe points clicked in the Results view (UI state, not in the model)">Probes{prow.length ? ` (${prow.length})` : ''}</button>
						{#each tableList as t (t.id)}<button role="tab" aria-selected={sub === t.id} class:on={sub === t.id} onclick={() => (sub = t.id)} data-tip={t.tip}>{t.label}</button>{/each}
					</div>
					{#if sub === 'probes'}
						<button disabled={!prow.length} onclick={copyTsv} data-tip="Copy the table as tab-separated values (header with units)">Copy TSV</button>
						<button disabled={!prow.length || !s.solution} onclick={() => pin(prow)} data-tip={`Pin every row: one model edit adding a cutpoint dataset and a point evaluation per row to ${PIN_GROUP} (values then computed like every evaluation, on every dataset and step)`}>Pin all</button>
						<button disabled={!prow.length} onclick={() => probes?.clear()} data-tip="Remove every row">Clear</button>
						<span class="dim n">{pinMsg || copied || `${prow.length} point${prow.length === 1 ? '' : 's'}`}</span>
					{:else}
						<span class="dim n" data-tip={tbl ? `${tbl.cached ? 'from the session cache' : `computed in ${tbl.ms.toFixed(1)} ms`} (post worker, @amp/post kernels); node hash ${tbl.hash.slice(0, 12)}; session memory only` : ''}>
							{#if tblBusy}computing{:else if tbl}{tbl.rows.length} row{tbl.rows.length === 1 ? '' : 's'}{/if}{#if s.staleSolution}<span class="warn"> stale</span>{:else if s.solutionCoarse}<span class="warn"> coarse</span>{/if}{pinMsg ? ` ${pinMsg}` : ''}
						</span>
					{/if}
				</div>
				<div class="list" bind:this={tbox}>
					{#if sub !== 'probes'}
						{#if tblErr}<div class="m dim">{tblErr}</div>
						{:else if tbl}
							{#each tbl.errors as e}<div class="m"><span class="na">not evaluated</span> {e}</div>{/each}
							{#if tbl.rows.length}
								{#if tbl.orient === 'columns'}
									<table class="pt mono">
										<tbody>
											{#each tbl.columns as c, ci (c.key)}
												<tr><th data-tip={c.tip}>{head(c)}</th>{#each tbl.rows as r, ri}<td class:num={c.kind !== 'dataset'} class:na={r.cells[ci] === null} data-tip={cellTip(tbl, ri, ci)}>{cellText(r.cells[ci] ?? null)}</td>{/each}</tr>
											{/each}
										</tbody>
									</table>
								{:else}
									<table class="pt mono">
										<thead><tr>{#each tbl.columns as c (c.key)}<th data-tip={c.tip}>{head(c)}</th>{/each}</tr></thead>
										<tbody>
											{#each tbl.rows as r, ri}
												<tr>{#each tbl.columns as c, ci (c.key)}<td class:num={c.kind !== 'dataset'} class:dim={c.kind === 'index'} class:na={r.cells[ci] === null} data-tip={cellTip(tbl, ri, ci)}>{cellText(r.cells[ci] ?? null)}</td>{/each}</tr>
											{/each}
										</tbody>
									</table>
								{/if}
							{/if}
						{/if}
					{:else if !prow.length}<div class="m dim">No probe points. Click in the Results view to evaluate the shown field at a point (exact FE value).</div>
					{:else}
						<table class="pt mono">
							<thead><tr>{#each pcols as c}<th>{c}</th>{/each}<th></th><th></th></tr></thead>
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
										<td><button class="x" disabled={!s.solution} onclick={() => pin([r])} data-tip={`Pin this point: one model edit adding a cutpoint dataset and a point evaluation of ${r.field} to ${PIN_GROUP}`} aria-label="pin row">pin</button></td>
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
	.subs { display: flex; gap: 0; margin-right: 6px; overflow-x: auto; }
	.subs button { height: 20px; border: 1px solid var(--line); border-right-width: 0; background: transparent; color: var(--ink-2); font-size: 11px; padding: 0 8px; white-space: nowrap; }
	.subs button:last-child { border-right-width: 1px; }
	.subs button.on { background: var(--surface-3); color: var(--ink); box-shadow: inset 0 -2px 0 var(--accent); }
	.pt tbody th { position: sticky; left: 0; background: var(--surface-3); color: var(--ink-2); font-weight: normal; text-align: left; padding: 0 10px 0 8px; white-space: nowrap; }
	.pt td.na { color: var(--ink-3); }
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
