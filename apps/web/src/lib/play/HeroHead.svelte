<script lang="ts">
	// SPDX-License-Identifier: GPL-3.0-or-later
	// Headline overlay of a Play view (DevLog-015 s.1.1 item 3): the spec's headline results (post/headline.ts, spec
	// units) or, for eigen studies, the selected mode's frequency, large at the top-left of the field; a short highlight
	// when a new value arrives (no tweened numbers). Below it the full-accuracy badges (post/accuracy.ts; audit S3): the
	// mesh error estimate of the shown quantity against the matched case tolerance, and separately the difference from
	// the case reference value (original parameters only); missing evidence shows as N/A, never green.
	import type { Session } from '../workbench/session.svelte';
	import { headlines, type Headline } from '../post/headline';
	import { caseRef, series, verdict } from '../post/accuracy';
	import { units } from '@amp/spec';
	import { fmt, fmtEng, fmtMs } from '../gfx/ticks';
	import { unitLabel } from '../gfx/units';
	import { SYMBOL } from './heroes';

	let { s, step = 0, asModel = true, accNote = '' }: { s: Session; step?: number; asModel?: boolean; accNote?: string } = $props();
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
	/** SI value of a quantity in the given unit (affine units such as degC included) */
	const toSI = (v: number, u: string) => { try { const q = units.parseUnit(u || '1'); return v * q.factor + q.offset; } catch { return v; } };
	const ser = $derived(acc ? series(acc, s.solutionLevel, idx) : null);
	const ref = $derived(acc && ser ? caseRef(acc, ser.target === null ? null : toSI(ser.target, ser.unit)) : null);
	// mesh error against the tolerance of the case metric that matches this quantity (scalars: the configured metric)
	const tol = $derived(ref?.tol ?? (acc && !('eigen' in acc.def.quantity) ? acc.conv.tol : null));
	const v = $derived(acc ? verdict(acc, idx, s.solutionLevel, tol) : null);
	/** comparison with the case reference value: only while the model's parameters are the original ones */
	const refCmp = $derived.by(() => {
		if (!ref || !ser || ser.target === null) return null;
		const a = toSI(ser.target, ser.unit), b = toSI(ref.value, ref.unit);
		const rel = ref.tol?.abs === undefined || ref.tol.rel !== undefined;
		const d = rel ? Math.abs(a - b) / Math.abs(b) : Math.abs(a - b);
		const lim = rel ? ref.tol?.rel : ref.tol?.abs;
		return { d, rel, kind: lim === undefined ? 'na' : d <= lim ? 'within' : 'above', lim };
	});
	const accTip = $derived.by(() => {
		if (!acc || !v) return '';
		const L = acc.levels.map((l, k) => `h ${l.h}: ${l.dof} DOF, ${fmtMs(l.ms)}, ${v.s.values[k] !== undefined ? `${fmt(v.s.values[k]!, 7)} ${unitLabel(v.s.unit)}` : 'N/A'}`).join('\n');
		const r = v.rich;
		const t = tol ? (tol.rel !== undefined ? `rel ${tol.rel}` : `abs ${tol.abs}`) : 'N/A';
		return `Mesh error estimate: the same model on nested meshes (${acc.conv.hNote}), solved after the full run; this ${eig ? `mode (solver mode ${idx}, matched by frequency${v.s.values.length ? '' : ''} across levels)` : 'quantity'}:\n${L}\n` +
			(r ? `observed order ${r.p_obs === null ? 'N/A' : r.p_obs.toPrecision(3)}${acc.conv.order ? ` (expected ${acc.conv.order})` : ''}; extrapolated ${r.f_ext === null ? 'N/A' : fmt(r.f_ext, 7)}; GCI of the finest level ${r.gci_fine === null ? 'N/A' : r.gci_fine.toExponential(2)} (Celik et al. 2008, eval harness rule)\n` : '') +
			(v.text ? `${v.text}\n` : '') +
			`tolerance: ${t}${ref ? ` (${acc.conv.caseId} ${ref.metric})` : ''}.\nThe mesh error says how well this model is solved, not whether it matches the case: the case reference comparison is the second line, shown only while the parameters are the model's own; this model may differ from the case's spec (domain truncation, finite sections, finite plate).` +
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
		{:else if !acc && accNote}<div class="acc na" data-tip={accNote}>mesh err N/A</div>
		{:else if acc && v}
			<div class="acc {acc.status === 'done' ? v.kind : 'na'}" class:run={acc.status === 'running'} data-tip={accTip}>
				{#if acc.status === 'running'}refining h {acc.next} ({acc.levels.length}/{acc.conv.hFactors.length})
				{:else if acc.status === 'unavailable'}mesh err N/A
				{:else if v.err !== null}mesh err est. {v.err.toExponential(1)}{v.errBasis === 'rel' ? '' : ` ${unitLabel(v.s.unit)}`}{#if v.limit !== null}{' '}(vs tol {v.limit.toExponential(0)}){/if}
				{:else if v.lastChange !== null && !v.s.reason}mesh err N/A, last change {v.lastChange.toExponential(1)}
				{:else}mesh err N/A{v.s.reason.startsWith('0 Hz') ? ' (0 Hz mode)' : ''}{/if}
			</div>
			{#if ref && refCmp && acc.status !== 'running'}
				{#if asModel}<div class="acc {refCmp.kind}" data-tip={`Case reference ${acc.conv.caseId} ${ref.metric} = ${fmt(ref.value, 7)} ${unitLabel(ref.unit)}; difference of the shown value ${refCmp.rel ? 'relative' : 'absolute'}${refCmp.lim !== undefined ? `, case tolerance ${refCmp.lim}` : ''}. This model may differ from the case's spec, so a converged value can still be off`}>vs {acc.conv.caseId} ref: {refCmp.d.toExponential(1)}{refCmp.rel ? ' rel' : ''}{#if refCmp.lim !== undefined}{' '}(tol {refCmp.lim.toExponential(0)}){/if}</div>
				{:else}<div class="acc na" data-tip="The case reference holds for the model's original parameters only">vs {acc.conv.caseId} ref: N/A (parameters changed)</div>{/if}
			{/if}
			{#if acc.status !== 'running' && s.solutionLevel < 1}<div class="lvl dim">h {s.solutionLevel} mesh, {acc.levels.at(-1)?.dof ?? ''} DOF</div>{/if}
		{/if}
	</div>
{/if}

<style>
	.hh { position: absolute; left: 8px; top: 38px; display: flex; flex-direction: column; gap: 2px; padding: 6px 10px 6px 8px; background: rgba(13, 13, 13, 0.9); border-left: 2px solid var(--accent); pointer-events: auto; transition: background-color 0.45s; max-width: calc(100% - 110px); }
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
	.lvl { font: 10px var(--mono); }
	@media (max-width: 760px) {
		.hh { top: 66px; left: 6px; padding: 4px 8px 4px 6px; }
		.v { font-size: 22px; }
	}
</style>
