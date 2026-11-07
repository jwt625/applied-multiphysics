<script lang="ts">
	// SPDX-License-Identifier: GPL-3.0-or-later
	// COMSOL-grade workbench (DevLog-011 s.1.4): toolbar / [Model Builder | Settings (Form, YAML) | Graphics] / bottom
	// tabs. Pane sizes persist (try/catch). Grid tracks use minmax(0, ...) so panels scroll inside and the canvas only
	// changes size when a splitter or the window does.
	import { onMount } from 'svelte';
	import { specJsonSchema } from '@amp/spec';
	import { HEROES, SIM_IDS, loadSimText } from '../sims';
	import { loadPhysics } from '../engine/physics';
	import { appRegistry } from '../engine/registry';
	import { Session } from './session.svelte';
	import { SchemaWalker } from '../schema/form';
	import { buildTree, findNode } from '../state/tree';
	import { decodeShare } from '../state/diff';
	import { appLog } from '../state/log.svelte';
	import { fmtMs } from '../gfx/ticks';
	import Tree from './Tree.svelte';
	import Settings from './Settings.svelte';
	import YamlTab from './YamlTab.svelte';
	import Bottom, { type BottomTab } from './Bottom.svelte';
	import Graphics, { type Mode } from '../gfx/Graphics.svelte';
	import { captureGraphics } from '../gfx/capture';
	import { HOOKS } from '../shell/hooks';
	import Headlines from '../ui/Headlines.svelte';
	import AgentPanel from '../agent/AgentPanel.svelte';
	import { navTrail, resolvePointer, type CameraRequest, type NavigationHost, type NavResult, type ViewMode } from '../state/nav.svelte';
	import Splitter from '../ui/Splitter.svelte';
	import Tip from '../ui/Tip.svelte';

	let { simId, share = '' }: { simId: string; share?: string } = $props();

	let s = $state.raw<Session | null>(null);
	let walker = $state.raw<SchemaWalker | null>(null);
	let failed = $state('');
	let selected = $state('/params');
	let settingsTab = $state<'form' | 'yaml'>('form');
	let mode = $state<Mode>('mesh');
	let bottomTab = $state<BottomTab>('messages');
	let mobilePane = $state<'tree' | 'settings' | 'graphics' | 'bottom'>('graphics');
	let fitKey = $state(0);
	let sizes = $state({ tree: 220, settings: 340, bottom: 170 });
	let highlight = $state<string[]>([]);
	let agentOpen = $state(false);
	// the panel stays mounted once opened (closing hides it; the chat and its session survive)
	let agentMounted = $state(false);
	$effect(() => { if (agentOpen) agentMounted = true; });

	// Navigation host for the agent (L9, @amp/agent NavigationHost): UI state only, every call in the navigation trail.
	function navHost(actor: string): NavigationHost {
		const rec = (tool: string, args: Record<string, unknown>, r: NavResult) => navTrail.record(actor, tool, args, r);
		const sel = (pointer: string): NavResult => {
			const p = s ? resolvePointer(s.model.data, pointer) : null;
			if (p === null) return { ok: false, message: `no node at ${pointer}` };
			jump(p);
			return { ok: true };
		};
		return {
			focusNode: (pointer) => rec('focus_node', { pointer }, (() => { const r = sel(pointer); if (r.ok) mobilePane = 'tree'; return r; })()),
			openSettings: (pointer, field) => rec('open_settings', { pointer, ...(field ? { field } : {}) }, (() => {
				const r = sel(pointer);
				if (r.ok && field) queueMicrotask(() => (document.querySelector(`[data-key="${CSS.escape(field)}"] input, [data-key="${CSS.escape(field)}"] select`) as HTMLElement | null)?.focus());
				return r;
			})()),
			highlightSelection: (ids) => rec('highlight_selection', { ids }, (() => { highlight = [...ids]; mode = 'geometry'; return { ok: true }; })()),
			setCamera: (req: CameraRequest) => rec('set_camera', { ...req }, req.kind === 'fit' ? (fitKey++, { ok: true }) : { ok: false, message: `camera '${req.kind}' is not implemented in v0 (fit only)` }),
			setViewMode: (m: ViewMode) => rec('set_view_mode', { mode: m }, ((mode = m), { ok: true })),
			screenshot: async (view) => {
				const c = captureGraphics();
				rec('screenshot', { view: view ?? 'graphics' }, c ? { ok: true } : { ok: false, message: 'graphics canvas not available' });
				return c ? { mediaType: 'image/png', ...c } : null;
			}
		};
	}
	const KEY = 'amp-web-panes';

	onMount(() => {
		try { const v = JSON.parse(localStorage.getItem(KEY) ?? 'null'); if (v && typeof v.tree === 'number') sizes = { ...sizes, ...v }; } catch { /* storage unavailable */ }
		let alive = true;
		void (async () => {
			try {
				const t0 = performance.now();
				const [text, phys] = await Promise.all([loadSimText(simId), loadPhysics()]);
				const { reg, source } = appRegistry(phys);
				const sess = await Session.open(simId, text, reg);
				if (!alive) return sess.dispose();
				walker = new SchemaWalker(specJsonSchema(reg) as Record<string, unknown>);
				appLog.info(`opened ${simId} (${text.length} B) with ${source} in ${fmtMs(performance.now() - t0)}`);
				if (share) {
					try { await sess.model.apply(decodeShare(share), 'from share URL'); appLog.info('applied the shared spec diff'); }
					catch (e) { appLog.error(`share URL: ${(e as Error).message}`); }
				}
				s = sess;
				void sess.buildMesh();
			} catch (e) {
				failed = (e as Error).message;
			}
		})();
		const key = (e: KeyboardEvent) => {
			const t = e.target as HTMLElement | null;
			if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
			if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && s) { e.preventDefault(); void (e.shiftKey ? s.model.redo() : s.model.undo()); }
		};
		window.addEventListener('keydown', key);
		if (HOOKS) (window as unknown as { __ampWorkbench?: unknown }).__ampWorkbench = { get session() { return s; }, setTab: (t: BottomTab) => (bottomTab = t), setMode: (m: Mode) => (mode = m), nav: navHost };
		return () => { alive = false; window.removeEventListener('keydown', key); s?.dispose(); };
	});

	function save() { try { localStorage.setItem(KEY, JSON.stringify(sizes)); } catch { /* storage unavailable */ } }
	const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

	const tree = $derived(s ? buildTree(s.model.data, s.model.parsed?.issues ?? []) : []);
	const node = $derived(findNode(tree, selected) ?? tree[1] ?? null);

	function goModel(id: string) { location.href = `?sim=${encodeURIComponent(id)}`; }
	async function copyShare() {
		if (!s) return;
		const url = `${location.origin}${location.pathname}?sim=${encodeURIComponent(simId)}${s.model.sharePatch().length ? `#d=${s.model.shareCode()}` : ''}`;
		try { await navigator.clipboard.writeText(url); appLog.info(`share URL copied (${url.length} chars)`); } catch { appLog.info(`share URL: ${url}`); }
		history.replaceState(null, '', url);
	}
	function jump(pointer: string) {
		let p = pointer;
		while (p && !findNode(tree, p)) p = p.slice(0, p.lastIndexOf('/'));
		selected = p || '';
		settingsTab = 'form';
		mobilePane = 'settings';
	}
	const statusText = $derived(!s ? '' : s.status === 'solving' ? 'computing' : s.status === 'meshing' ? 'meshing' : s.status === 'unavailable' ? 'results unavailable' : s.status === 'error' ? 'error' : s.status === 'solved' ? `solved ${fmtMs(s.lastOutcomeMs)}` : s.meshInfo ? `meshed ${fmtMs(s.meshInfo.roundTripMs)}` : '');
</script>

<Tip />
{#if failed}
	<div class="fail">Failed to open {simId}: {failed}</div>
{:else}
	<div class="wb" style="--tw: {sizes.tree}px; --sw: {sizes.settings}px; --bh: {sizes.bottom}px; --cw: {agentOpen ? 300 : 0}px">
		<div class="tb">
			<select value={simId} onchange={(e) => goModel((e.currentTarget as HTMLSelectElement).value)} data-tip="Model (sims/*.yaml)">
				{#each SIM_IDS as id}<option value={id}>{id}</option>{/each}
			</select>
			<button disabled={!s} onclick={() => s?.buildMesh()} data-tip="Build the mesh (geometry and mesh edits re-mesh automatically)">Mesh</button>
			<button disabled={!s || s.status === 'solving'} onclick={() => s?.requestCompute()} data-tip="Mesh and run the registered physics module of the first study">Compute</button>
			<button disabled={!s || (s.status !== 'solving' && s.status !== 'meshing')} onclick={() => s?.cancel()} data-tip="Cancel the run">Cancel</button>
			{#if s?.caseInfo}
				<label class="case" data-tip={`Fill properties that are N/A in the model with the sourced inputs of eval case ${s.caseInfo.id}:\n${s.caseInfo.materials}\n${s.caseFilled.length ? `last run used: ${s.caseFilled.join(', ')}` : 'last run used no case value (materials from the model)'}`}><input type="checkbox" bind:checked={s.useCase} /> N/A from {s.caseInfo.id}{s.caseFilled.length ? ` (${s.caseFilled.length} used)` : ''}</label>
			{/if}
			<span class="gap"></span>
			<button disabled={!s?.model.canUndo} onclick={() => s?.model.undo()} data-tip="Undo (Ctrl/Cmd+Z)">Undo</button>
			<button disabled={!s?.model.canRedo} onclick={() => s?.model.redo()} data-tip="Redo (Shift+Ctrl/Cmd+Z)">Redo</button>
			<button disabled={!s} onclick={copyShare} data-tip="Copy a link that holds the spec diff from the original model">Share</button>
			{#if HEROES.includes(simId)}<a class="btn" href="/play/{simId}" data-sveltekit-reload data-tip="Play view of this model">Play</a>{/if}
			<button class="agentb" class:on={agentOpen} onclick={() => (agentOpen = !agentOpen)} data-tip="Agent panel (bring your own key; edits land in the Timeline as agent ops with a reason)">Agent</button>
			{#if highlight.length}<button onclick={() => (highlight = [])} data-tip={`Clear the highlight: ${highlight.join(' ')}`}>Clear highlight</button>{/if}
			<span class="st" class:warn={s?.status === 'unavailable'} class:crit={s?.status === 'error'}>{statusText}</span>
			<div class="mob">
				{#each ['tree', 'settings', 'graphics', 'bottom'] as const as p}<button class:on={mobilePane === p} onclick={() => (mobilePane = p)}>{p === 'bottom' ? 'log' : p}</button>{/each}
			</div>
		</div>
		<div class="main">
			<section class="pane tree" class:mshow={mobilePane === 'tree'}>
				<div class="ph">Model Builder</div>
				<div class="pb">{#if s}<Tree nodes={tree} selected={node?.pointer ?? ''} onselect={(p) => { selected = p; mobilePane = 'settings'; }} unavailable={s.status === 'unavailable'} />{/if}</div>
			</section>
			<Splitter dir="col" label="resize Model Builder" onmove={(d) => { sizes.tree = clamp(sizes.tree + d, 140, 480); save(); }} />
			<section class="pane settings" class:mshow={mobilePane === 'settings'}>
				<div class="ph tabs">
					<button class:on={settingsTab === 'form'} onclick={() => (settingsTab = 'form')}>Settings</button>
					<button class:on={settingsTab === 'yaml'} onclick={() => (settingsTab = 'yaml')} data-tip="Edit the YAML text; applied as one operation by splice">YAML</button>
				</div>
				<div class="pb">
					{#if s && walker}
						{#if settingsTab === 'form'}<div class="scroll"><Settings {s} {node} {walker} /></div>{:else}<YamlTab m={s.model} />{/if}
					{/if}
				</div>
			</section>
			<Splitter dir="col" label="resize Settings" onmove={(d) => { sizes.settings = clamp(sizes.settings + d, 220, 720); save(); }} />
			<section class="pane graphics" class:mshow={mobilePane === 'graphics'}>
				{#if s}<Graphics {s} bind:mode {fitKey} {highlight} />{#if mode === 'results'}<Headlines {s} boxed />{/if}{:else}<div class="loading dim">Loading model...</div>{/if}
			</section>
			<section class="pane agent" class:hidden={!agentOpen}>
				<div class="ph">Agent</div>
				<div class="pb">{#if s && agentMounted}<AgentPanel {s} nav={navHost} />{/if}</div>
			</section>
		</div>
		<Splitter dir="row" label="resize bottom panel" onmove={(d) => { sizes.bottom = clamp(sizes.bottom - d, 60, 600); save(); }} />
		<section class="bottom" class:mshow={mobilePane === 'bottom'}>
			{#if s}<Bottom {s} bind:tab={bottomTab} onjump={jump} />{/if}
		</section>
	</div>
{/if}

<style>
	.fail { padding: 20px; color: var(--crit); }
	.wb { height: 100%; display: grid; grid-template-rows: 30px minmax(0, 1fr) 3px var(--bh); background: var(--bg); }
	.tb { display: flex; align-items: center; gap: 4px; padding: 0 6px; background: var(--surface); border-bottom: 1px solid var(--line); min-width: 0; overflow: hidden; }
	.tb select { width: 150px; }
	.gap { width: 8px; flex: none; }
	.case { display: flex; align-items: center; gap: 3px; font-size: 11px; color: var(--ink-2); white-space: nowrap; }
	.btn { display: inline-flex; align-items: center; height: 22px; padding: 0 8px; border: 1px solid var(--border); background: var(--surface-3); color: var(--ink); }
	.st { margin-left: 8px; font-size: 11px; color: var(--ink-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.mob { display: none; margin-left: auto; }
	.main { display: grid; grid-template-columns: var(--tw) 3px var(--sw) 3px minmax(0, 1fr) var(--cw); min-height: 0; }
	.agent { border-left: 1px solid var(--line); }
	.hidden { display: none; }
	.pane { display: grid; grid-template-rows: 24px minmax(0, 1fr); min-width: 0; min-height: 0; background: var(--surface); }
	.ph { display: flex; align-items: center; padding: 0 8px; border-bottom: 1px solid var(--line); color: var(--ink-2); font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
	.ph.tabs { padding: 0; }
	.ph.tabs button { border: 0; border-right: 1px solid var(--line); background: transparent; height: 23px; font-size: 11px; text-transform: uppercase; color: var(--ink-2); }
	.ph.tabs button.on { color: var(--ink); box-shadow: inset 0 -2px 0 var(--accent); }
	.pb { position: relative; min-height: 0; overflow: auto; }
	.scroll { position: absolute; inset: 0; overflow: auto; }
	.graphics { display: block; position: relative; }
	.loading { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; }
	.bottom { position: relative; min-height: 0; }
	@media (max-width: 760px) {
		.wb { grid-template-rows: auto minmax(0, 1fr) 0 0; }
		/* fixed height (same in the route shell) so the page does not shift after mount (audit M1) */
		.tb { flex-wrap: wrap; align-content: flex-start; padding: 3px 6px; height: 84px; row-gap: 3px; }
		.tb .case, .tb .agentb { display: none; }
		.tb select { width: 120px; }
		.mob { display: flex; margin-left: 0; width: 100%; }
		.mob button { flex: 1; }
		.st { display: none; }
		.main { grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(0, 1fr); }
		.main > :global(.sp) { display: none; }
		.pane, .graphics { display: none; grid-row: 1; grid-column: 1; }
		.pane.mshow { display: grid; }
		.graphics.mshow { display: block; }
		.bottom { display: none; }
		/* the log pane takes the main grid row (row 2): the toolbar and pane switcher above stay reachable (audit B2) */
		.bottom.mshow { display: block; grid-row: 2; grid-column: 1; }
		.wb:has(.bottom.mshow) .main { display: none; }
		.wb > :global(.sp) { display: none; }
	}
</style>
