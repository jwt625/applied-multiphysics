<script lang="ts">
	// SPDX-License-Identifier: GPL-3.0-or-later
	// Headline overlay of a Play view (DevLog-015 s.1.1 item 3): the spec's headline results (post/headline.ts, spec
	// units) or, for eigen studies, the selected mode's frequency, large at the top-left of the field; a short highlight
	// when a new value arrives (no tweened numbers). Below it the full-accuracy badge (post/accuracy.ts): estimated
	// discretization error of the finest level against the paired case's tolerance; missing evidence shows as N/A.
	import type { Session } from '../workbench/session.svelte';
	import { headlines, type Headline } from '../post/headline';
	import { verdict } from '../post/accuracy';
	import { fmt, fmtEng, fmtMs } from '../gfx/ticks';
	import { unitLabel } from '../gfx/units';
	import { SYMBOL } from './heroes';

	let { s, step = 0 }: { s: Session; step?: number } = $props();
	let list = $state.raw<Headline[]>([]);
	$effect(() => {
		const sol = s.solution, mesh = s.mesh, params = s.model.parsed?.params;
		const results = ((s.model.data as { results?: unknown[] } | null)?.results ?? []) as Parameters<typeof headlines>[0];
		if (!sol || !mesh || !params || sol.meshHash !== mesh.hash) { list = []; return; }
		void headlines(results, sol, mesh, params, s.post).then((h) => { if (s.solution === sol) list = h.filter((x) => x.value !== null); });
	});
	const eig = $derived(s.solution?.steps?.kind === 'eigen' ? s.solution.steps : null);
	const modeScalars = $derived(s.solution?.scalars ?? {});
	const sym = (id: string): [string, string] => SYMBOL[id] ?? (id.includes('_') ? [id.slice(0, id.indexOf('_')), id.slice(id.indexOf('_') + 1)] : [id, '']);
	type Row = { id: string; sym: [string, string]; num: string; unit: string; tip: string };
	const rows = $derived.by((): Row[] => {
		if (eig) {
			const f = eig.values[step];
			if (f === undefined) return [];
			const e = fmtEng(f, eig.unit || 'Hz', 4), m = modeScalars[`m_${step}`]?.value, ne = modeScalars[`neff_${step}`]?.value;
			const out: Row[] = [];
			if (ne !== undefined) out.push({ id: 'neff', sym: ['n', 'eff'], num: fmt(ne, 6), unit: '', tip: `effective index of mode ${step}` });
			else out.push({ id: 'f', sym: ['f', String(step)], num: e.num, unit: e.unit, tip: `eigenfrequency of mode ${step}: ${fmt(f, 7)} ${eig.unit}${m !== undefined ? `, azimuthal order m = ${m}` : ''}` });
			if (m !== undefined) out.push({ id: 'm', sym: ['m', ''], num: String(m), unit: '', tip: 'azimuthal order of the mode (axisymmetric solve)' });
			return out;
		}
		return list.map((h) => ({ id: h.id, sym: sym(h.label), num: fmt(h.value!, 4), unit: unitLabel(h.unit), tip: h.tip }));
	});
	// highlight on a new value (it encodes "changed")
	let flash = $state(false);
	let lastKey = '';
	$effect(() => {
		const k = rows.map((r) => r.num).join('|');
		if (k && lastKey && k !== lastKey) { flash = true; setTimeout(() => (flash = false), 450); }
		lastKey = k;
	});
	const mark = $derived(s.staleSolution ? 'stale' : s.solutionCoarse ? 'coarse' : '');
	const acc = $derived(s.acc);
	const idx = $derived(eig ? step : 0);
	const v = $derived(acc ? verdict(acc, idx) : null);
	/** relative change between the two finest levels (shown when Richardson is not available; never as "within") */
	const lastChange = $derived.by(() => {
		const L = acc?.levels ?? [];
		if (L.length < 2) return null;
		const a = L.at(-1)!.values[idx], b = L.at(-2)!.values[idx];
		return a !== undefined && b !== undefined && a !== 0 ? Math.abs((a - b) / a) : null;
	});
	const accTip = $derived.by(() => {
		if (!acc) return '';
		const L = acc.levels.map((l) => `h ${l.h}: ${l.dof} DOF, ${fmtMs(l.ms)}, ${l.values[idx] !== undefined ? fmt(l.values[idx]!, 7) : 'N/A'}`).join('\n');
		const r = acc.rich[idx];
		const tol = acc.conv.tol ? (acc.conv.tol.rel !== undefined ? `rel ${acc.conv.tol.rel}` : `abs ${acc.conv.tol.abs}`) : 'N/A';
		return `Full-accuracy sequence: the same model on nested meshes (${acc.conv.hNote}), solved after the full run.\n${L}\n` +
			(r ? `observed order ${r.p_obs === null ? 'N/A' : r.p_obs.toPrecision(3)}${acc.conv.order ? ` (expected ${acc.conv.order})` : ''}; extrapolated ${r.f_ext === null ? 'N/A' : fmt(r.f_ext, 7)}; GCI of the finest level ${r.gci_fine === null ? 'N/A' : r.gci_fine.toExponential(2)} (Celik et al. 2008, eval harness rule)\n` : '') +
			`tolerance of ${acc.def.metric} in ${acc.conv.caseId}: ${tol}.\nDiscretization error of this model only: differences between this model and the case's spec are not included.` +
			(acc.reason ? `\n${acc.reason}` : '') + (acc.doneAt ? `\nsequence ${fmtMs(acc.doneAt - acc.startedAt)}; page load to gated accuracy ${fmtMs(acc.doneAt)}` : '');
	});
</script>

{#if rows.length}
	<div class="hh" class:flash class:dim={!!mark}>
		{#each rows as r (r.id)}
			<div class="row" data-tip={r.tip}>
				<span class="k">{r.sym[0]}{#if r.sym[1]}<sub>{r.sym[1]}</sub>{/if}</span>
				<span class="v mono">{r.num}</span>{#if r.unit}<span class="u">{r.unit}</span>{/if}
			</div>
		{/each}
		{#if mark}<div class="mk warn">{mark}</div>
		{:else if acc && v}
			<div class="acc {v.kind}" class:run={acc.status === 'running'} data-tip={accTip}>
				{#if acc.status === 'running'}refining h {acc.next} ({acc.levels.length}/{acc.conv.hFactors.length})
				{:else if acc.status === 'unavailable'}accuracy N/A
				{:else if v.err !== null && v.limit !== null}est. err {v.err.toExponential(1)}{v.errBasis === 'rel' ? '' : ` ${unitLabel(s.solution?.steps?.unit ?? '')}`} {v.kind === 'within' ? '<=' : '>'} tol {v.limit.toExponential(0)} <span class="c">{acc.conv.caseId}</span>
				{:else if lastChange !== null}last change {lastChange.toExponential(1)} rel, order N/A <span class="c">{acc.conv.caseId}</span>
				{:else}accuracy N/A{/if}
			</div>
			{#if acc.status !== 'running' && s.solutionLevel < 1}<div class="lvl dim">h {s.solutionLevel} mesh, {acc.levels.at(-1)?.dof ?? ''} DOF</div>{/if}
		{/if}
	</div>
{/if}

<style>
	.hh { position: absolute; left: 8px; top: 38px; display: flex; flex-direction: column; gap: 2px; padding: 6px 10px 6px 8px; background: rgba(13, 13, 13, 0.78); border-left: 2px solid var(--accent); pointer-events: auto; transition: background-color 0.45s; max-width: calc(100% - 110px); }
	.hh.flash { background: rgba(57, 135, 229, 0.28); transition: none; }
	.row { display: flex; align-items: baseline; gap: 8px; white-space: nowrap; }
	.k { font: italic 15px/1 Georgia, 'Times New Roman', serif; color: var(--ink-2); min-width: 28px; }
	.k sub { font-size: 10px; font-style: normal; font-family: var(--sans); }
	.v { font-size: 28px; line-height: 1.05; color: var(--ink); font-weight: 500; letter-spacing: -0.01em; }
	.row + .row .v { font-size: 15px; }
	.u { font-size: 13px; color: var(--ink-2); }
	.dim .v { color: var(--ink-3); }
	.mk { font-size: 10px; border: 1px solid currentColor; padding: 0 4px; align-self: flex-start; }
	.acc { font: 10px var(--mono); padding: 1px 5px; border: 1px solid var(--border); color: var(--ink-2); align-self: flex-start; margin-top: 3px; white-space: nowrap; }
	.acc.within { border-color: var(--good); color: #7fd394; }
	.acc.above { border-color: var(--warn); color: var(--warn); }
	.acc.na { color: var(--na); }
	.acc.run { border-style: dashed; color: var(--ink-2); }
	.acc .c { color: var(--ink-3); }
	.lvl { font: 10px var(--mono); }
	@media (max-width: 760px) {
		.hh { top: 66px; left: 6px; padding: 4px 8px 4px 6px; }
		.v { font-size: 22px; }
	}
</style>
