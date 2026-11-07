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
	import Headlines from '../ui/Headlines.svelte';
	import { unitLabel } from '../gfx/units';
	import { HOOKS } from '../shell/hooks';
	import AgentPanel from '../agent/AgentPanel.svelte';
	import { captureGraphics } from '../gfx/capture';
	import { navTrail, type NavigationHost, type NavResult } from '../state/nav.svelte';
	import type { ProviderAdapter } from '@amp/agent';

	let { simId, share = '' }: { simId: string; share?: string } = $props();
	// Pass 2 item 5: the cavity Play view solves the meridional section (emw-axisym, m = 0, 1, 2) and draws the
	// modes revolved in 3D; the 3D Nedelec solver stays available with ?solver=3d
	const AXISYM: Record<string, string> = { 'cylinder-cavity': 'cylinder-cavity-axisym' };
	let solver3d = $state(false);
	const specId = $derived(!solver3d && AXISYM[simId] ? AXISYM[simId]! : simId);
	let agentOpen = $state(false);
	let agentMounted = $state(false);
	let mock = $state.raw<ProviderAdapter | null>(null);
	$effect(() => { if (agentOpen) agentMounted = true; });

	// navigation host of the Play view (agent tools; UI state only, recorded in the navigation trail)
	function navHost(actor: string): NavigationHost {
		const rec = (tool: string, args: Record<string, unknown>, r: NavResult) => navTrail.record(actor, tool, args, r);
		const none = (tool: string, args: Record<string, unknown>) => rec(tool, args, { ok: false, message: 'the Play view has no model tree or settings; open the workbench' });
		return {
			focusNode: (pointer) => none('focus_node', { pointer }),
			openSettings: (pointer, field) => none('open_settings', { pointer, ...(field ? { field } : {}) }),
			highlightSelection: (ids) => rec('highlight_selection', { ids }, { ok: false, message: 'highlight is available in the workbench' }),
			setCamera: (req) => rec('set_camera', { ...req }, { ok: false, message: 'camera control is available in the workbench' }),
			setViewMode: (m) => rec('set_view_mode', { mode: m }, ((mode = m), { ok: true })),
			screenshot: async (view) => {
				const c = captureGraphics();
				rec('screenshot', { view: view ?? 'graphics' }, c ? { ok: true } : { ok: false, message: 'graphics canvas not available' });
				return c ? { mediaType: 'image/png', ...c } : null;
			}
		};
	}
	let s = $state.raw<Session | null>(null);
	let failed = $state('');
	let mode = $state<Mode>('geometry');
	let shareMsg = $state('');
	let hasPhysics = $state(false);

	onMount(() => {
		let alive = true;
		void (async () => {
			try {
				solver3d = new URLSearchParams(location.search).get('solver') === '3d';
				const [text, phys] = await Promise.all([loadSimText(specId), loadPhysics()]);
				const { reg } = appRegistry(phys);
				const sess = await Session.open(specId, text, reg);
				if (!alive) return sess.dispose();
				hasPhysics = moduleList(phys).length > 0;
				sess.autoCompute = hasPhysics;
				if (share) {
					try { await sess.model.apply(decodeShare(share), 'from share URL'); } catch (e) { appLog.error(`share URL: ${(e as Error).message}`); }
				}
				s = sess;
				if (hasPhysics) { mode = 'results'; sess.requestCompute(); } else void sess.buildMesh();
			} catch (e) {
				failed = (e as Error).message;
			}
		})();
		if (HOOKS) (window as unknown as { __ampPlay?: unknown }).__ampPlay = {
			get session() { return s; },
			// tests only: open the agent panel on @amp/agent's scripted mock provider (no network, no key)
			async openAgentMock(steps: unknown[]) { const A = await import('@amp/agent'); mock = new A.ScriptedProvider(steps as never); agentOpen = true; },
			get mock() { return mock; }
		};
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

	// B1 (audit): every drag step goes through the op log; the gesture ends only after its last op has landed, and the
	// exact field commits one op that re-solves through the session (autoCompute on every op that invalidates results)
	let lastStep: Promise<unknown> = Promise.resolve();
	function patchFor(p: ParamView, v: number) {
		const pi = info?.get(p.name);
		return pi ? paramPatchSI(data?.params as Record<string, unknown>, p.name, v * factor(p.unit), pi.dim) : [];
	}
	function stepParam(p: ParamView, v: number) {
		if (!s) return;
		lastStep = s.model.dragStep(patchFor(p, v), `drag ${p.name}`);
	}
	async function endDrag() {
		await lastStep;
		s?.finishDrag();
	}
	async function commitParam(p: ParamView, v: number) {
		if (!s) return;
		await s.model.apply(patchFor(p, v), `set ${p.name}`);
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
		lastStep = s.model.dragStep(paramPatchSI(data?.params as Record<string, unknown>, d.param, v, pi.dim), `drag ${d.param} on the canvas`);
		if (phase === 'end') void endDrag();
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
		const url = `${location.origin}/play/${simId}${solver3d ? '?solver=3d' : ''}${code}`;
		history.replaceState(null, '', url);
		try { await navigator.clipboard.writeText(url); shareMsg = `copied (${url.length} chars)`; } catch { shareMsg = url; }
	}

	// module scalars except the per-mode lists (shown as the mode list); SI with display symbols; dimensionless without "1"
	// per-mode scalars (`<name>_<k>`) are listed for the selected mode only; frequencies are the mode buttons
	const scalars = $derived(s?.solution ? Object.entries(s.solution.scalars).filter(([k]) => { const m = /_(\d+)$/.exec(k); return !m || (Number(m[1]) === step && !/^f_\d+$/.test(k)); }) : []);
	const modes = $derived(s?.solution?.steps?.kind === 'eigen' ? Array.from(s.solution.steps.values) : []);
	const modeUnit = $derived(s?.solution?.steps?.unit ?? '');
	let step = $state(0);
	let playing = $state(false);
	const ranges: Record<string, 'full' | 'robust'> = { 'helmholtz-coil': 'robust' };
	const solState = $derived(!s?.solution ? '' : s.staleSolution ? 'stale' : s.solutionCoarse ? 'coarse' : '');
</script>

<Tip />
{#if failed}
	<div class="fail">Failed to open {simId}: {failed}</div>
{:else}
	<div class="play" class:withagent={agentOpen}>
		<header>
			<a href="/?sim={simId}" data-sveltekit-reload class="dim" data-tip="Open this model in the workbench (same op log format)">workbench</a>
			<span class="t">{title}</span>
			<span class="sp"></span>
			<button disabled={!s || s.status === 'solving'} onclick={() => s?.requestCompute()} data-tip="Compute at full resolution">Compute</button>
			<button disabled={!s?.model.canUndo} onclick={() => s?.model.undo()} data-tip="Undo">Undo</button>
			<button disabled={!s?.model.canRedo} onclick={() => s?.model.redo()} data-tip="Redo">Redo</button>
			<button disabled={!s} onclick={copyShare} data-tip="Copy a link holding the spec diff from the original model">Share</button>
			<button class:on={agentOpen} onclick={() => (agentOpen = !agentOpen)} data-tip="Agent panel (bring your own key)">Agent</button>
			{#if shareMsg}<span class="dim msg">{shareMsg}</span>{/if}
		</header>
		<div class="cv">
			{#if s}<Graphics {s} bind:mode bind:step bind:playing {handles} {onhandle} {focus} compact revolve={specId !== simId} rangeDefault={ranges[simId] ?? 'full'} contoursDefault={simId !== 'helmholtz-coil'} fieldLinesDefault autoAnimate />{/if}
		</div>
		{#if s && agentMounted}<section class="agent" class:hidden={!agentOpen}><AgentPanel {s} nav={navHost} provider={mock} /></section>{/if}
		<aside>
			<div class="h">parameters</div>
			{#each params as p (p.name)}
				{@const pi = info?.get(p.name)}
				<ParamSlider {p} resolved={pi ? `= ${fmt(pi.si, 6)} ${units.formatUnit(pi.dim)} (SI)` : ''} onpreview={(v) => stepParam(p, v)} ondragend={() => void endDrag()} oncommit={(v) => void commitParam(p, v)} />
			{/each}
			{#if presets.length}
				<div class="h">presets</div>
				<div class="pre">{#each presets as pr}<button data-tip={pr.tip} onclick={() => preset(pr.values, pr.name)}>{pr.name}</button>{/each}</div>
			{/if}
			<div class="h">results{#if solState}<span class="warn"> {solState}</span>{/if}</div>
			{#if s}<Headlines {s} big />{/if}
			{#if modes.length}
				<div class="modes">
					{#each modes as f, i}{@const mm = s?.solution?.scalars[`m_${i}`]?.value}<button class:on={i === step} data-tip={`mode ${i}: ${fmt(f, 6)} ${unitLabel(modeUnit)}${mm !== undefined ? `, azimuthal order m = ${mm}` : ''}; click to show`} onclick={() => { step = i; playing = true; mode = 'results'; }}>{fmt(f, 4)} {unitLabel(modeUnit)}{mm !== undefined ? ` m${mm}` : ''}</button>{/each}
				</div>
			{/if}
			{#if scalars.length}
				<div class="sc" class:dimv={!!solState}>
					{#each scalars as [k, q]}<div class="kv mono"><span>{k}</span><span>{fmt(q.value)} {unitLabel(q.unit)}</span></div>{/each}
				</div>
			{:else if !modes.length}
				<div class="na">{s?.status === 'solving' ? 'computing...' : s?.status === 'unavailable' ? `unavailable: ${s.reasons[0] ?? ''}` : hasPhysics ? 'not computed' : 'unavailable: no @amp/physics module registered'}</div>
			{/if}
			{#if s?.caseInfo}
				<label class="case" data-tip={`Fill properties that are N/A in the model with the sourced inputs of eval case ${s.caseInfo.id}:\n${s.caseInfo.materials}`}><input type="checkbox" checked={s.useCase} onchange={(e) => { if (s) { s.useCase = (e.currentTarget as HTMLInputElement).checked; s.requestCompute(); } }} /> N/A inputs from eval case {s.caseInfo.id}</label>
				<div class="dim small">{s.caseFilled.length ? `case values used: ${s.caseFilled.join(', ')}` : 'materials: from the model'}</div>
			{/if}
			{#if AXISYM[simId]}
				<div class="h">solver</div>
				<div class="pre">
					<a class="btn" class:on={!solver3d} href="/play/{simId}" data-sveltekit-reload data-tip="Meridional (r, z) section, azimuthal orders m = 0, 1, 2 (emw-axisym); modes drawn revolved in 3D">axisymmetric</a>
					<a class="btn" class:on={solver3d} href="/play/{simId}?solver=3d" data-sveltekit-reload data-tip="Full 3D Nedelec eigen solve (emw, tet10)">3D</a>
				</div>
			{/if}
			<div class="h">timing</div>
			<div class="kv mono" data-tip="input to result arrival of the last drag step (coarse mesh, sizes x2), before the next frame"><span>drag preview</span><span>{s?.dragMs ? fmtMs(s.dragMs) : '-'}</span></div>
			<div class="kv mono" data-tip="worker round trip of the last full mesh"><span>mesh</span><span>{s?.meshInfo ? `${fmtMs(s.meshInfo.roundTripMs)}, ${s.meshInfo.cells} cells` : '-'}</span></div>
			<div class="kv mono"><span>ops</span><span>{s?.model.ops.length ?? 0}</span></div>
		</aside>
	</div>
{/if}

<style>
	.fail { padding: 20px; color: var(--crit); }
	.play { height: 100%; display: grid; grid-template-columns: minmax(0, 1fr) 300px; grid-template-rows: 34px minmax(0, 1fr); background: var(--bg); }
	.play.withagent { grid-template-columns: minmax(0, 1fr) 300px 320px; }
	.play.withagent header { grid-column: 1 / 4; }
	.agent { position: relative; grid-column: 3; grid-row: 2; border-left: 1px solid var(--line); min-height: 0; }
	.hidden { display: none; }
	header { grid-column: 1 / 3; display: flex; align-items: center; gap: 6px; padding: 0 10px; border-bottom: 1px solid var(--line); background: var(--surface); min-width: 0; overflow: hidden; white-space: nowrap; }
	.t { font-weight: 600; overflow: hidden; text-overflow: ellipsis; }
	.sp { flex: 1; }
	.msg { font-size: 11px; overflow: hidden; text-overflow: ellipsis; max-width: 240px; }
	.cv { position: relative; min-width: 0; min-height: 0; }
	aside { background: var(--surface); border-left: 1px solid var(--line); padding: 8px; display: flex; flex-direction: column; gap: 4px; overflow: auto; min-height: 0; }
	.h { margin-top: 6px; font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--ink-3); }
	.pre { display: flex; flex-wrap: wrap; gap: 3px; }
	.kv { display: flex; justify-content: space-between; gap: 8px; font-size: 11px; }
	.na { font-size: 11px; color: var(--ink-2); }
	.small { font-size: 10px; }
	.btn { display: inline-flex; align-items: center; height: 22px; padding: 0 8px; border: 1px solid var(--border); color: var(--ink-2); font-size: 11px; }
	.btn.on { background: #2462b5; border-color: #2462b5; color: #fff; }
	.modes { display: flex; flex-wrap: wrap; gap: 3px; }
	.modes button { font-size: 11px; }
	.dimv { opacity: 0.55; }
	.case { display: flex; align-items: center; gap: 4px; font-size: 11px; color: var(--ink-2); }
	@media (max-width: 760px) {
		.play { grid-template-columns: minmax(0, 1fr); grid-template-rows: 34px minmax(0, 1fr) 240px; }
		header { grid-column: 1; }
		aside { border-left: 0; border-top: 1px solid var(--line); }
		.play.withagent { grid-template-columns: minmax(0, 1fr); }
		.play.withagent header { grid-column: 1; }
		.agent { grid-column: 1; grid-row: 2; z-index: 3; border-left: 0; }
		/* touch-sized controls on phones (audit M3, top-10 #9) */
		aside :global(button), aside :global(input:not([type='checkbox'])), header button { min-height: 36px; }
		aside :global(input[type='range']) { height: 36px; }
		header > a.dim { display: none; }
	}
</style>
