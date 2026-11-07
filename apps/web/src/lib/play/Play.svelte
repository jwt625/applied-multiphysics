<script lang="ts">
	// SPDX-License-Identifier: GPL-3.0-or-later
	// Play view per hero (DevLog-001 Q8, DevLog-011 s.1.7): a large canvas with drag handles, a few sliders with exact
	// fields bound to spec params, presets, share-by-URL (the spec diff), coarse re-mesh / re-solve while dragging.
	// Every drag is one coalesced operation in the same op log as the workbench.
	import { onMount } from 'svelte';
	import { units } from '@amp/spec';
	import { loadSimText } from '../sims';
	import { loadPhysics, moduleList } from '../engine/physics';
	import { appRegistry } from '../engine/registry';
	import { Session } from '../workbench/session.svelte';
	import { decodeShare } from '../state/diff';
	import { paramPatchSI, paramViews, type ParamView } from '../state/params';
	import { appLog } from '../state/log.svelte';
	import { fmt, fmtMs } from '../gfx/ticks';
	import Graphics, { type Mode } from '../gfx/Graphics.svelte';
	import type { Handle } from '../gfx/Canvas2D.svelte';
	import ParamSlider from '../ui/ParamSlider.svelte';
	import Tip from '../ui/Tip.svelte';
	import { FOCUS, HANDLES, presetsFor } from './heroes';

	let { simId, share = '' }: { simId: string; share?: string } = $props();
	let s = $state.raw<Session | null>(null);
	let failed = $state('');
	let mode = $state<Mode>('geometry');
	let shareMsg = $state('');
	let hasPhysics = $state(false);

	onMount(() => {
		let alive = true;
		void (async () => {
			try {
				const [text, phys] = await Promise.all([loadSimText(simId), loadPhysics()]);
				const { reg } = appRegistry(phys);
				const sess = await Session.open(simId, text, reg);
				if (!alive) return sess.dispose();
				hasPhysics = moduleList(phys).length > 0;
				sess.autoCompute = hasPhysics;
				if (share) {
					try { await sess.model.apply(decodeShare(share), 'from share URL'); } catch (e) { appLog.error(`share URL: ${(e as Error).message}`); }
				}
				s = sess;
				if (hasPhysics) { mode = 'results'; void sess.compute(); } else void sess.buildMesh();
			} catch (e) {
				failed = (e as Error).message;
			}
		})();
		(window as unknown as { __ampPlay?: unknown }).__ampPlay = { get session() { return s; } };
		return () => { alive = false; s?.dispose(); };
	});

	const data = $derived((s?.model.data ?? null) as Record<string, unknown> | null);
	const original = $derived((s?.model.originalData ?? null) as Record<string, unknown> | null);
	const params = $derived(paramViews(data?.params as never, original?.params as never).filter((p) => p.value !== null).slice(0, 6));
	const info = $derived(s?.model.parsed?.params);
	const presets = $derived(presetsFor(original));
	const title = $derived((data?.title as string | undefined) ?? simId);
	const defs = $derived(HANDLES[simId] ?? []);
	const handles = $derived.by((): Handle[] => {
		if (!info || !s?.m2) return [];
		const out: Handle[] = [];
		for (const d of defs) {
			const at = d.at(info);
			if (at && Number.isFinite(at.x) && Number.isFinite(at.y)) out.push({ id: d.id, tip: d.tip, ...at });
		}
		return out;
	});

	// the focus box is taken once per model (the view stays put while the user drags)
	let focus = $state<[number, number, number, number] | null>(null);
	$effect(() => { if (!focus && info && FOCUS[simId]) focus = FOCUS[simId]!(info); });

	const factor = (u: string) => { try { return units.parseUnit(u || '1').factor; } catch { return 1; } };

	function stepParam(p: ParamView, v: number) {
		if (!s) return;
		const pi = info?.get(p.name);
		if (!pi) return;
		void s.model.dragStep(paramPatchSI(data?.params as Record<string, unknown>, p.name, v * factor(p.unit), pi.dim), `drag ${p.name}`);
	}

	function onhandle(id: string, x: number, y: number, phase: 'move' | 'end') {
		if (!s || !info) return;
		const d = defs.find((h) => h.id === id);
		const pi = d ? info.get(d.param) : undefined;
		const pv = params.find((p) => p.name === d?.param) ?? paramViews(data?.params as never, original?.params as never).find((p) => p.name === d?.param);
		if (!d || !pi) return;
		let v = d.value(x, y, info);
		if (pv?.span) { const f = factor(pv.unit); v = Math.min(pv.span[1] * f, Math.max(pv.span[0] * f, v)); }
		if (!(v > 0)) return;
		void s.model.dragStep(paramPatchSI(data?.params as Record<string, unknown>, d.param, v, pi.dim), `drag ${d.param} on the canvas`).then(() => { if (phase === 'end') s?.finishDrag(); });
	}

	async function preset(values: Record<string, number>, name: string) {
		if (!s || !data) return;
		const patch = [];
		for (const [k, v] of Object.entries(values)) {
			const pi = info?.get(k);
			const pv = paramViews(data.params as never, original?.params as never).find((p) => p.name === k);
			if (!pi || !pv) continue;
			const cur = pv.value;
			if (cur === v) continue;
			patch.push(...paramPatchSI(data.params as Record<string, unknown>, k, v * factor(pv.unit), pi.dim));
		}
		await s.model.apply(patch, `preset ${name}`);
	}

	async function copyShare() {
		if (!s) return;
		const code = s.model.sharePatch().length ? `#d=${s.model.shareCode()}` : '';
		const url = `${location.origin}/play/${simId}${code}`;
		history.replaceState(null, '', url);
		try { await navigator.clipboard.writeText(url); shareMsg = `copied (${url.length} chars)`; } catch { shareMsg = url; }
	}

	const scalars = $derived(s?.solution ? Object.entries(s.solution.scalars) : []);
</script>

<Tip />
{#if failed}
	<div class="fail">Failed to open {simId}: {failed}</div>
{:else}
	<div class="play">
		<header>
			<a href="/?sim={simId}" data-sveltekit-reload class="dim" data-tip="Open this model in the workbench (same op log format)">workbench</a>
			<span class="t">{title}</span>
			<span class="sp"></span>
			<button disabled={!s?.model.canUndo} onclick={() => s?.model.undo()} data-tip="Undo">Undo</button>
			<button disabled={!s?.model.canRedo} onclick={() => s?.model.redo()} data-tip="Redo">Redo</button>
			<button disabled={!s} onclick={copyShare} data-tip="Copy a link holding the spec diff from the original model">Share</button>
			{#if shareMsg}<span class="dim msg">{shareMsg}</span>{/if}
		</header>
		<div class="cv">
			{#if s}<Graphics {s} bind:mode {handles} {onhandle} {focus} compact clipDefault />{/if}
		</div>
		<aside>
			<div class="h">parameters</div>
			{#each params as p (p.name)}
				{@const pi = info?.get(p.name)}
				<ParamSlider {p} resolved={pi ? `= ${fmt(pi.si, 6)} ${units.formatUnit(pi.dim)} (SI)` : ''} onpreview={(v) => stepParam(p, v)} ondragend={() => s?.finishDrag()} oncommit={(v) => { stepParam(p, v); s?.finishDrag(); }} />
			{/each}
			{#if presets.length}
				<div class="h">presets</div>
				<div class="pre">{#each presets as pr}<button data-tip={pr.tip} onclick={() => preset(pr.values, pr.name)}>{pr.name}</button>{/each}</div>
			{/if}
			<div class="h">results</div>
			{#if s?.caseInfo}
				<label class="case" data-tip={`Material values for properties that are N/A in the model, from eval case ${s.caseInfo.id}:\n${s.caseInfo.materials}`}><input type="checkbox" checked={s.useCase} onchange={(e) => { if (s) { s.useCase = (e.currentTarget as HTMLInputElement).checked; void s.compute(); } }} /> materials from eval case {s.caseInfo.id}</label>
			{/if}
			{#if scalars.length}
				{#each scalars as [k, q]}<div class="kv mono"><span>{k}</span><span>{fmt(q.value)} {q.unit}</span></div>{/each}
			{:else}
				<div class="na">unavailable{s?.status === 'unavailable' ? `: ${s.reasons[0] ?? ''}` : hasPhysics ? '' : ': no @amp/physics module registered yet'}</div>
			{/if}
			<div class="h">timing</div>
			<div class="kv mono" data-tip="input to mesh arrival of the last drag step (coarse mesh, sizes x2), before the next frame"><span>drag re-mesh</span><span>{s?.dragMs ? fmtMs(s.dragMs) : '-'}</span></div>
			<div class="kv mono" data-tip="worker round trip of the last full mesh"><span>mesh</span><span>{s?.meshInfo ? `${fmtMs(s.meshInfo.roundTripMs)}, ${s.meshInfo.cells} cells` : '-'}</span></div>
			<div class="kv mono"><span>ops</span><span>{s?.model.ops.length ?? 0}</span></div>
		</aside>
	</div>
{/if}

<style>
	.fail { padding: 20px; color: var(--crit); }
	.play { height: 100%; display: grid; grid-template-columns: minmax(0, 1fr) 300px; grid-template-rows: 34px minmax(0, 1fr); background: var(--bg); }
	header { grid-column: 1 / 3; display: flex; align-items: center; gap: 6px; padding: 0 10px; border-bottom: 1px solid var(--line); background: var(--surface); min-width: 0; overflow: hidden; white-space: nowrap; }
	.t { font-weight: 600; overflow: hidden; text-overflow: ellipsis; }
	.sp { flex: 1; }
	.msg { font-size: 11px; overflow: hidden; text-overflow: ellipsis; max-width: 240px; }
	.cv { position: relative; min-width: 0; min-height: 0; }
	aside { background: var(--surface); border-left: 1px solid var(--line); padding: 8px; display: flex; flex-direction: column; gap: 4px; overflow: auto; min-height: 0; }
	.h { margin-top: 6px; font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--ink-3); }
	.pre { display: flex; flex-wrap: wrap; gap: 3px; }
	.kv { display: flex; justify-content: space-between; gap: 8px; font-size: 11px; }
	.na { font-size: 11px; }
	.case { display: flex; align-items: center; gap: 4px; font-size: 11px; color: var(--ink-2); }
	@media (max-width: 760px) {
		.play { grid-template-columns: minmax(0, 1fr); grid-template-rows: 34px minmax(0, 1fr) 240px; }
		header { grid-column: 1; }
		aside { border-left: 0; border-top: 1px solid var(--line); }
	}
</style>
