<script lang="ts">
	// SPDX-License-Identifier: GPL-3.0-or-later
	// Inset over the field view for driven solves (DevLog-052 s.2 item 4), data from the Solution extras `wave2d`:
	// S-parameters vs frequency (|S| in dB, or phase in degrees, unwrapped along frequency) for one input column, and the
	// far field sigma_2D(phi) at the shown frequency (polar, linear in m or dB re 1 m; or Cartesian over phi).
	import type { Wave2DExtras } from '../engine/protocol';
	import LinePlot, { type Series } from '../results/LinePlot.svelte';
	import PolarPlot from './PolarPlot.svelte';
	import { bandSeries, latticeConstant, farFields, powerBalance, sParamSeries } from './driven';
	import { fmt, fmtEng } from './ticks';

	let { w, view, step = 0, top = 34, onclose }: { w: Wave2DExtras; view: 'sparams' | 'farfield' | 'bands'; step?: number; /** px from the top of the graphics panel (below the toolbar) */ top?: number; onclose: () => void } = $props();

	let quantity = $state<'dB' | 'phase'>('dB');
	let inp = $state(0);
	let wrapPh = $state(false);
	let polar = $state(true);
	let ffDb = $state(false);
	const sp = $derived(sParamSeries(w, { wrap: wrapPh }));
	const inputs = $derived.by(() => {
		const out: Array<{ j: number; label: string }> = [];
		for (const s of sp.series) if (!out.some((o) => o.j === s.inp)) out.push({ j: s.inp, label: s.inLabel });
		return out;
	});
	const single = $derived(sp.nFreq === 1);
	const series = $derived<Series[]>(sp.series.filter((s) => s.inp === (inputs.some((o) => o.j === inp) ? inp : (inputs[0]?.j ?? 0))).map((s) => ({ name: s.name, tip: s.tip, x: s.x, y: quantity === 'dB' ? s.dB : s.deg, markers: single || s.x.length < 12, line: !single })));
	const balance = $derived(powerBalance(w));
	const balTip = $derived.by(() => {
		if (!balance.length) return '';
		let worst = 0;
		for (const b of balance) worst = Math.max(worst, Math.abs(b.sum - 1));
		return `sum over outputs of |S|^2 per input: 1 for a lossless structure with every propagating mode reported; largest deviation from 1 here ${fmt(worst, 3)} (${balance.length} input columns over ${sp.nFreq} frequencies)`;
	});
	const ffs = $derived(farFields(w));
	const ff = $derived(ffs.find((f) => f.f === w.perFrequency[Math.min(step, w.perFrequency.length - 1)]?.f) ?? ffs[0] ?? null);
	const ffSeries = $derived<Series[]>(ff ? [{ name: 'σ2D', tip: '2D scattering width σ2D(φ), φ from +x', x: ff.phiDeg, y: ffDb ? ff.sigma.map((v) => (v > 0 ? 10 * Math.log10(v) : NaN)) : ff.sigma }] : []);
	let bandNorm = $state(false);
	const aLat = $derived(latticeConstant(w));
	const bs = $derived(view === 'bands' ? bandSeries(w, { normalized: bandNorm }) : null);
	const fLabel = (f: number) => { const e = fmtEng(f, 'Hz', 4); return `${e.num} ${e.unit}`; };
</script>

<div class="inset" style:top="{top}px" role="region" aria-label={view === 'sparams' ? 'S-parameters' : view === 'bands' ? 'Band diagram' : 'Far field'}>
	<div class="hd">
		{#if view === 'bands'}
			<span class="t" data-tip={`Band diagram: eigenfrequencies of the periodic cell along the wave-vector path (${bs?.series.length ?? 0} bands, ${w.bands?.distance.length ?? 0} path points); x = cumulative path length |Δk| in 1/m, labelled at the named points`}>Bands</span>
			{#if aLat}<button class:on={bandNorm} data-tip={`Normalized frequency f a / c0 with the lattice constant a = |a1| = ${fmtEng(aLat, 'm').num} ${fmtEng(aLat, 'm').unit}; off: f in Hz`} onclick={() => (bandNorm = !bandNorm)}>f a/c0</button>{/if}
		{:else if view === 'sparams'}
			<span class="t" data-tip={`Power-normalised scattering parameters of the port modes (out, in); ${sp.nFreq} frequenc${sp.nFreq === 1 ? 'y' : 'ies'}. ${balTip}`}>S-parameters</span>
			<div class="modes">
				<button class:on={quantity === 'dB'} data-tip="|S| in dB (20 log10 |S|)" onclick={() => (quantity = 'dB')}>|S| dB</button>
				<button class:on={quantity === 'phase'} data-tip="arg S in degrees" onclick={() => (quantity = 'phase')}>phase</button>
			</div>
			{#if quantity === 'phase'}<button class:on={wrapPh} data-tip="Wrapped to (-180, 180] deg; off: unwrapped along frequency" onclick={() => (wrapPh = !wrapPh)}>wrap</button>{/if}
			{#if inputs.length > 1}
				<select bind:value={inp} data-tip="Input column j of S_ij (the excited port and mode)">
					{#each inputs as o}<option value={o.j}>in: {o.label}</option>{/each}
				</select>
			{/if}
		{:else}
			<span class="t" data-tip={ff ? `2D scattering width σ2D(φ) at ${fLabel(ff.f)} (far field of the scattered field, per unit length); max ${fmtEng(ff.max, 'm').num} ${fmtEng(ff.max, 'm').unit}` : 'no far field at this frequency'}>Far field{ff && ffs.length > 1 ? ` ${fLabel(ff.f)}` : ''}</span>
			<div class="modes">
				<button class:on={polar} data-tip="Polar plot" onclick={() => (polar = true)}>polar</button>
				<button class:on={!polar} data-tip="σ2D over φ (degrees)" onclick={() => (polar = false)}>φ axis</button>
			</div>
			<button class:on={ffDb} data-tip="dB relative to 1 m (10 log10(σ2D / 1 m)); polar view floored 40 dB below the maximum" onclick={() => (ffDb = !ffDb)}>dB</button>
		{/if}
		<span class="sp"></span>
		<button class="x" data-tip="Close" aria-label="Close" onclick={onclose}>×</button>
	</div>
	<div class="bd">
		{#if view === 'bands'}
			{#if bs}<LinePlot series={bs.series.map((x) => ({ ...x, markers: x.x.length < 12 }))} xLabel="path length |Δk| (1/m)" yLabel={bandNorm && aLat ? 'f a / c0' : `f (${bs.yUnit})`} xMarks={bs.marks} ariaLabel="band diagram" toggles={false} />
			{:else}<div class="msg dim">no band data</div>{/if}
		{:else if view === 'sparams'}
			{#if series.length}
				<LinePlot {series} xLabel={`f (${sp.xUnit})`} yLabel={quantity === 'dB' ? '|S| (dB)' : 'arg S (deg)'} ariaLabel="S-parameters vs frequency" toggles={false} legend />
			{:else}<div class="msg dim">no S-parameters: the model has no ports with propagating modes</div>{/if}
		{:else if ff}
			{#if polar}<PolarPlot phiDeg={ff.phiDeg} r={ff.sigma} unit="m" db={ffDb} label="scattering width polar plot" />
			{:else}<LinePlot series={ffSeries} xLabel="φ (deg)" yLabel={ffDb ? 'σ2D (dB re 1 m)' : 'σ2D (m)'} ariaLabel="scattering width vs angle" toggles={!ffDb} legend />{/if}
		{:else}<div class="msg dim">no far field: the model has no plane-wave excitation or a lossy background</div>{/if}
	</div>
</div>

<style>
	.inset { position: absolute; right: 90px; top: 34px; width: min(48%, 520px); height: min(52%, 320px); min-width: 260px; min-height: 200px; background: #0d0d0d; border: 1px solid var(--border); display: flex; flex-direction: column; z-index: 2; }
	.hd { display: flex; gap: 3px; align-items: center; padding: 2px 4px; border-bottom: 1px solid var(--line); font-size: 11px; flex-wrap: wrap; }
	.t { color: var(--ink); margin-right: 4px; }
	.modes { display: flex; }
	.modes button + button { border-left: 0; }
	.sp { flex: 1; }
	.x { min-width: 22px; }
	.bd { position: relative; flex: 1; min-height: 0; display: flex; flex-direction: column; }
	.msg { margin: auto; font-size: 11px; padding: 8px; text-align: center; }
	@media (max-width: 760px) { .inset { left: 6px; right: 6px; width: auto; top: 64px; height: 45%; } }
</style>
