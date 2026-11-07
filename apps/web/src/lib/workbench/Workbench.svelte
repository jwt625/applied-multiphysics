<script lang="ts">
	// SPDX-License-Identifier: GPL-3.0-or-later
	// COMSOL-grade workbench (DevLog-011 s.1.4): toolbar / [Model Builder | Settings (Form, YAML) | Graphics] / bottom
	// tabs. Pane sizes persist (try/catch). Grid tracks use minmax(0, ...) so panels scroll inside and the canvas only
	// changes size when a splitter or the window does.
	// DevLog-020: every pane edge is a splitter (tree, settings, agent, bottom; graphics takes the rest), clamped to
	// minimum sizes and to the window, double-click / Enter resets; Compute switches the view to Results when its
	// solution arrives; a tree selection switches the view mode (and highlights the node's entities); clicks in
	// Results fill the Table tab; a sweep shows the dataset of the selected point everywhere.
	// Results (DevLog-027): tree "+" menus and node actions are one op each (results/plot-ops.ts); selecting a plot group
	// (or one of its items) shows it in the single graphics pane, a 1D group in the 1D view with an optional split
	// (field above, graph below); a selected cut line shows its end handles; `showPlot(id)` is the agent host hook.
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
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
	import PaneSplitter from './PaneSplitter.svelte';
	import { ProbeTable } from '../state/probes.svelte';
	import { viewFor } from '../state/tree-view';
	import { FOCUS, MIRROR } from '../play/heroes';
	import Tip from '../ui/Tip.svelte';
	import LibraryPicker from '../library/LibraryPicker.svelte';
	import { CATALOG } from '../library/catalog';
	import Plot1D from '../gfx/Plot1D.svelte';
	import { addMenu, addPatch, cascadeRemovePatch, duplicatePatch, movePatch, nodeAt, togglePatch, type MenuEntry } from '../results/plot-ops';
	import type { TreeAction } from './Tree.svelte';
	import type { TreeNode } from '../state/tree';

	// Library: EM problems solved through the acoustics module show the field as pressure in Pa (wrong quantity and unit),
	// so they stay out of the picker until an EM module runs them (coordinator, DevLog-021). Still openable by ?sim=.
	// Other analogs (same module, exact maps) stay listed.
	const ANALOG = new Set(CATALOG.filter((e) => e.analog && e.physics.includes('acoustics') && e.category !== 'acoustics').map((e) => e.id));
	const LIB_ENTRIES = CATALOG.filter((e) => !ANALOG.has(e.id));
	const LIB_IDS = SIM_IDS.filter((id) => !ANALOG.has(id));

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
	const DEFAULT = { tree: 220, settings: 340, agent: 300, bottom: 170 } as const;
	type Pane = keyof typeof DEFAULT;
	/** minimum pane sizes, px; the graphics pane keeps at least GW x GH */
	const MIN: Record<Pane, number> = { tree: 140, settings: 220, agent: 240, bottom: 60 };
	const GW = 240, GH = 160;
	let sizes = $state<Record<Pane, number>>({ ...DEFAULT });
	/** px of column splitters (3 each; the agent splitter exists only while the agent pane is open) */
	const SPL = () => (agentOpen ? 9 : 6);
	let mainW = $state(0);
	let wbH = $state(0);
	/** largest size of a pane that leaves the others at their current size and the graphics pane at GW x GH */
	function maxOf(k: Pane): number {
		if (k === 'bottom') return Math.max(MIN.bottom, (wbH || 900) - 30 - 3 - GH);
		const others = (['tree', 'settings', 'agent'] as const).filter((x) => x !== k && (x !== 'agent' || agentOpen)).reduce((a, x) => a + eff[x], 0);
		return Math.max(MIN[k], (mainW || 1440) - others - SPL() - GW);
	}
	/** sizes as drawn: the stored ones clamped to the window (the stored values are kept for a larger window) */
	const eff = $derived.by(() => {
		const W = (mainW || 1440) - SPL(), H = wbH || 900;
		const tree = Math.max(MIN.tree, Math.min(sizes.tree, W - GW - MIN.settings - (agentOpen ? MIN.agent : 0)));
		const settings = Math.max(MIN.settings, Math.min(sizes.settings, W - GW - tree - (agentOpen ? MIN.agent : 0)));
		const agent = Math.max(MIN.agent, Math.min(sizes.agent, W - GW - tree - settings));
		const bottom = Math.max(MIN.bottom, Math.min(sizes.bottom, H - 33 - GH));
		return { tree, settings, agent, bottom };
	});
	function resize(k: Pane, px: number) { sizes[k] = Math.round(Math.min(maxOf(k), Math.max(MIN[k], px))); }
	function reset(k: Pane) { sizes[k] = DEFAULT[k]; save(); }
	let highlight = $state<string[]>([]);
	/** highlight of the selected tree node (separate from the agent's highlight_selection) */
	let treeHi = $state<string[]>([]);
	const probes = new ProbeTable();
	// hero models: symmetry mirroring and the region of interest of the Play view (taken once per model; DevLog-015)
	let roi = $state<[number, number, number, number] | null>(null);
	$effect(() => { const p = s?.model.parsed?.params; if (!roi && p && FOCUS[simId]) roi = FOCUS[simId]!(p); });
	let agentOpen = $state(false);
	/** RESULT_NAMES of @amp/physics (field and scalar names per physics type) for the add-menu templates before a solve */
	let resultNames = $state.raw<Record<string, { fields: string[]; scalars: string[] }> | undefined>(undefined);
	/** plot groups shown (DevLog-027): a 2D group drawn by Graphics (null = quick view), a 1D group in the 1D view */
	let plot2d = $state<string | null>(null);
	let plot1d = $state<string | null>(null);
	/** which view the single pane shows without the split */
	let pane = $state<'2d' | '1d'>('2d');
	let split = $state(false);
	/** pointer of the selected cut-line dataset (its ends become handles) */
	/** id of the selected cut-line dataset (resolved to its current pointer, so moves, undo and agent edits keep it) */
	let editId = $state<string | null>(null);
	const editLine = $derived.by(() => {
		const ds = (s?.model.data as { results?: { datasets?: Array<{ id?: unknown; type?: unknown }> } } | null)?.results?.datasets ?? [];
		const i = editId ? ds.findIndex((d) => d?.id === editId && d.type === 'cutline') : -1;
		return i >= 0 ? `/results/datasets/${i}` : null;
	});
	/** timings for the gates: cut-line handle move to op, 1D re-plot compute */
	let dragMs = $state(0);
	let plotMs = $state(0);
	let plotSeq = $state(0);
	// the panel stays mounted once opened (closing hides it; the chat and its session survive)
	let agentMounted = $state(false);
	$effect(() => { if (agentOpen) agentMounted = true; });

	// Navigation host for the agent (L9, @amp/agent NavigationHost): UI state only, every call in the navigation trail.
	function navHost(actor: string): NavigationHost & { showPlot(id: string): NavResult } {
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
				showPlot: (id: string) => rec('show_plot', { plot: id }, showPlot(id)),
			screenshot: async (view) => {
				const c = captureGraphics();
				rec('screenshot', { view: view ?? 'graphics' }, c ? { ok: true } : { ok: false, message: 'graphics canvas not available' });
				return c ? { mediaType: 'image/png', ...c } : null;
			}
		};
	}
	const KEY = 'amp-web-panes';

	onMount(() => {
		try {
			const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Record<string, unknown> | null;
			if (v && typeof v === 'object') for (const k of Object.keys(DEFAULT) as Pane[]) { const x = v[k]; if (typeof x === 'number' && Number.isFinite(x)) sizes[k] = Math.max(MIN[k], x); }
		} catch { /* storage unavailable */ }
		let alive = true;
		void (async () => {
			try {
				const t0 = performance.now();
				const [text, phys] = await Promise.all([loadSimText(simId), loadPhysics()]);
					const { reg, source } = appRegistry(phys);
					resultNames = phys?.RESULT_NAMES;
				const sess = await Session.open(simId, text, reg);
				sess.sweepEnabled = true;
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
			if (HOOKS) (window as unknown as { __ampWorkbench?: unknown }).__ampWorkbench = {
				get session() { return s; }, setTab: (t: BottomTab) => (bottomTab = t), setMode: (m: Mode) => (mode = m), get mode() { return mode; }, get sizes() { return { ...sizes }; }, get eff() { return { ...eff }; }, get probes() { return probes.rows; }, nav: navHost,
				// DevLog-027 gates: plot state, timings, the browser half of gate 7 (R1 fixture hash in a module worker)
				get plots() { return { plot2d, plot1d, pane, split, editLine, dragMs, plotMs, plotSeq }; }, showPlot, setSplit: (v: boolean) => (split = v), select: (p: string) => treeSelect(p),
				gate7: () => new Promise((res) => { const w = new Worker(new URL('../results/plot-gate7.worker.ts', import.meta.url), { type: 'module', name: 'amp-gate7' }); w.onmessage = (e) => { res(e.data); w.terminate(); }; w.onerror = (e) => { res({ ok: false, error: e.message }); w.terminate(); }; w.postMessage('run'); })
			};
		return () => { alive = false; window.removeEventListener('keydown', key); s?.dispose(); };
	});

	function save() { try { localStorage.setItem(KEY, JSON.stringify(sizes)); } catch { /* storage unavailable */ } }

	const tree = $derived(s ? buildTree(s.model.data, s.model.parsed?.issues ?? []) : []);
	/** physics types of the first study, in the study's order (header label of multiphysics models, C11) */
	const studyPhys = $derived.by(() => {
		const d = s?.model.data as { physics?: Array<{ id?: string; type?: string }>; studies?: Array<{ physics?: string[] }> } | null | undefined;
		return (d?.studies?.[0]?.physics ?? []).map((id) => d?.physics?.find((p) => p.id === id)?.type ?? id);
	});
	const node = $derived(findNode(tree, selected) ?? tree[1] ?? null);

	// Compute delivered a full-resolution solution: show it (a later manual mode click is not undone)
	let seenSolved = 0;
	$effect(() => { const n = s?.solvedSeq ?? 0; if (n > seenSolved) { seenSolved = n; mode = 'results'; } });

	/** tree selection: settings of the node, and the view mode / highlight it implies (state/tree-view.ts); a plot group
	 *  (or item) is shown in the graphics pane; a cut-line dataset gets its end handles */
	function treeSelect(p: string) {
		selected = p;
		mobilePane = 'settings';
		const n = findNode(tree, p);
		const v = viewFor(n, s?.model.data ?? null, s?.mesh ?? null);
		if (v.mode) mode = v.mode;
		treeHi = v.ids;
		const at = s ? nodeAt(s.model.data, p) : null;
		editId = at?.sec === 'datasets' && at.node.type === 'cutline' ? String(at.node.id) : null;
		if (n?.section === 'plots' && n.kind === 'result') {
			const g = s ? nodeAt(s.model.data, p.replace(/\/items\/\d+$/, '')) : null;
			if (g) show(String(g.node.id), String(g.node.type));
		}
	}
	/** show a plot group: 2D drawn by Graphics (Results mode), 1D in the 1D view; 3D groups are drawn in stage R4 */
	function show(id: string, type: string) {
		if (type === 'plot1d') { plot1d = id; if (!split) pane = '1d'; }
		else { plot2d = id; pane = '2d'; mode = 'results'; }
	}
	/** agent host hook (`show_plot`, lane R3): select the group in the tree and show it */
	function showPlot(id: string): NavResult {
		const r = (s?.model.data as { results?: { plots?: Array<{ id?: unknown; type?: unknown }> } } | null)?.results?.plots ?? [];
		const i = r.findIndex((g) => g?.id === id);
		if (i < 0) return { ok: false, message: `no plot group '${id}' (results.plots ids: ${r.map((g) => String(g?.id)).join(', ') || 'none'})` };
		selected = `/results/plots/${i}`;
		show(id, String(r[i]!.type));
		mobilePane = 'graphics';
		return r[i]!.type === 'plot3d' ? { ok: true, message: '3D plot groups are drawn from stage R4; the graphics pane shows a not-drawn badge' } : { ok: true };
	}
	const ctxOf = () => ({ data: s?.model.data ?? null, mesh: s?.mesh ?? null, sol: s?.solution && s.mesh && s.solution.meshHash === s.mesh.hash ? s.solution : null, names: resultNames });
	function menuFor(n: TreeNode): MenuEntry[] {
		if (!s || !n.section) return [];
		return addMenu(ctxOf(), n.section, n.kind === 'result' ? n.rid : undefined);
	}
	async function addEntry(e: MenuEntry) {
		if (!s) return;
		try {
			const a = addPatch(ctxOf(), e);
			if (!a) return;
			const op = await s.model.apply(a.patch, `add ${e.label} ${a.id}`);
			if (!op) return;
			treeSelect(a.pointer);
			if (e.section === 'plots' && !e.group) show(a.id, e.type);
		} catch (err) { appLog.error(`add ${e.label}: ${(err as Error).message}`); }
	}
	/** nodes a delete removes with the node (it and everything that reads it), for the menu label */
	const deleteSet = (n: TreeNode): string[] => (s ? cascadeRemovePatch(s.model.data, n.pointer).removed : []);
	async function treeAction(n: TreeNode, a: TreeAction) {
		if (!s) return;
		try { await treeAction0(n, a); } catch (err) { appLog.error(`${a} ${n.label}: ${(err as Error).message}`); }
	}
	async function treeAction0(n: TreeNode, a: TreeAction) {
		if (!s) return;
		const d = s.model.data;
		if (a === 'delete') {
			const c = cascadeRemovePatch(d, n.pointer);
			const op = await s.model.apply(c.patch, `delete ${c.removed.join(', ')}`);
			if (op && c.removed.length > 1) appLog.info(`deleted ${n.label} and the nodes that read it: ${c.removed.slice(1).join(', ')} (Undo restores them)`);
			if (op) { if (plot2d && c.removed.includes(plot2d)) plot2d = null; if (plot1d && c.removed.includes(plot1d)) plot1d = null; selected = n.pointer.replace(/\/(items\/)?\d+$/, '') || '/results'; }
		} else if (a === 'duplicate') {
			const r = duplicatePatch(d, n.pointer);
			if (r && (await s.model.apply(r.patch, `duplicate ${n.label} as ${r.id}`))) treeSelect(r.pointer);
		} else if (a === 'toggle') await s.model.apply(togglePatch(d, n.pointer), `${n.off ? 'enable' : 'disable'} ${n.label}`);
		else {
			const r = movePatch(d, n.pointer, a === 'up' ? -1 : 1);
			if (r && (await s.model.apply(r.patch, `move ${n.label} ${a}`))) selected = r.pointer;
		}
	}
	/** a 1D group exists to show (selected or the first one) */
	const g1 = $derived.by(() => {
		const ps = ((s?.model.data as { results?: { plots?: Array<{ id?: unknown; type?: unknown }> } } | null)?.results?.plots ?? []);
		return plot1d && ps.some((g) => g?.id === plot1d && g.type === 'plot1d') ? plot1d : null;
	});
	const show1d = $derived(!!g1 && (split || pane === '1d'));
	const show2d = $derived(!show1d || split);
	/** the shown 2D group still exists (a delete or undo can remove it) */
	const g2id = $derived(plot2d && ((s?.model.data as { results?: { plots?: Array<{ id?: unknown }> } } | null)?.results?.plots ?? []).some((g) => g?.id === plot2d) ? plot2d : null);
	const activePtr = $derived.by(() => {
		const ps = ((s?.model.data as { results?: { plots?: Array<{ id?: unknown }> } } | null)?.results?.plots ?? []);
		const id = show1d && !split ? g1 : g2id;
		const i = ps.findIndex((g) => g?.id === id);
		return i >= 0 ? `/results/plots/${i}` : '';
	});
	const hiShown = $derived(highlight.length ? highlight : treeHi);

	/** session view for the headline numbers: the params of the displayed dataset (sweep point) */
	const hasSweep = $derived(!!s?.sweep);
	const hv = $derived.by(() => {
		const x = s;
		if (!x || !hasSweep) return x;
		return {
			get solution() { return x.solution; }, get mesh() { return x.mesh; }, post: x.post,
			get staleSolution() { return x.staleSolution; }, get solutionCoarse() { return x.solutionCoarse; },
			get caseFilled() { return x.caseFilled; }, get caseInfo() { return x.caseInfo; },
			model: { get parsed() { return { params: x.activeParams }; }, get data() { return x.model.data; } }
		} as unknown as Session;
	});

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
	<div class="wb" bind:clientHeight={wbH} style="--tw: {eff.tree}px; --sw: {eff.settings}px; --bh: {eff.bottom}px; --cw: {agentOpen ? eff.agent : 0}px; --cs: {agentOpen ? 3 : 0}px">
		<div class="tb">
			<a class="home" href={resolve('/')} data-tip="Example library (landing page)">amp</a>
			<LibraryPicker current={simId} onpick={goModel} available={LIB_IDS} entries={LIB_ENTRIES} />
			{#if studyPhys.length > 1}<span class="phys" data-tip="Physics solved by the first study (couplings set the solve order)">{studyPhys.join(' + ')}</span>{/if}
			<button disabled={!s || s.status === 'solving'} onclick={() => s?.buildMesh()} data-tip="Build the mesh (geometry and mesh edits re-mesh automatically)">Mesh</button>
			<button disabled={!s || s.status === 'solving'} onclick={() => s?.requestCompute()} data-tip="Mesh and run the registered physics module of the first study">Compute</button>
			<button disabled={!s || (s.status !== 'solving' && s.status !== 'meshing')} onclick={() => s?.cancel()} data-tip="Cancel the run">Cancel</button>
			{#if s?.caseInfo}
				<label class="case" data-tip={`Fill properties that are N/A in the model with the sourced inputs of eval case ${s.caseInfo.id}:\n${s.caseInfo.materials}\n${s.caseFilled.length ? `last run used: ${s.caseFilled.join(', ')}` : 'last run used no case value (materials from the model)'}`}><input type="checkbox" bind:checked={s.useCase} /> N/A from {s.caseInfo.id}{s.caseFilled.length ? ` (${s.caseFilled.length} used)` : ''}</label>
			{/if}
			<span class="gap"></span>
			<button disabled={!s?.model.canUndo} onclick={() => s?.model.undo()} data-tip="Undo (Ctrl/Cmd+Z)">Undo</button>
			<button disabled={!s?.model.canRedo} onclick={() => s?.model.redo()} data-tip="Redo (Shift+Ctrl/Cmd+Z)">Redo</button>
			<button disabled={!s} onclick={copyShare} data-tip="Copy a link that holds the spec diff from the original model">Share</button>
			{#if HEROES.includes(simId)}<a class="btn" href={resolve('/play/[sim]', { sim: simId })} data-sveltekit-reload data-tip="Play view of this model">Play</a>{/if}
			<button class="agentb" class:on={agentOpen} onclick={() => (agentOpen = !agentOpen)} data-tip="Agent panel (bring your own key; edits land in the Timeline as agent ops with a reason)">Agent</button>
			{#if highlight.length}<button onclick={() => (highlight = [])} data-tip={`Clear the highlight: ${highlight.join(' ')}`}>Clear highlight</button>{/if}
			<span class="st" class:warn={s?.status === 'unavailable'} class:crit={s?.status === 'error'}>{statusText}</span>
			<div class="mob">
				{#each ['tree', 'settings', 'graphics', 'bottom'] as const as p}<button class:on={mobilePane === p} onclick={() => (mobilePane = p)}>{p === 'bottom' ? 'log' : p}</button>{/each}
			</div>
		</div>
		<div class="main" bind:clientWidth={mainW}>
			<section class="pane tree" class:mshow={mobilePane === 'tree'}>
				<div class="ph">Model Builder</div>
					<div class="pb">{#if s}<Tree nodes={tree} selected={node?.pointer ?? ''} onselect={treeSelect} unavailable={s.status === 'unavailable'} menu={menuFor} onadd={addEntry} onaction={treeAction} active={activePtr} deletes={deleteSet} />{/if}</div>
			</section>
			<PaneSplitter dir="col" label="Resize Model Builder" size={eff.tree} min={MIN.tree} max={maxOf('tree')} onsize={(px) => resize('tree', px)} onreset={() => reset('tree')} onend={save} />
			<section class="pane settings" class:mshow={mobilePane === 'settings'}>
				<div class="ph tabs">
					<button class:on={settingsTab === 'form'} onclick={() => (settingsTab = 'form')}>Settings</button>
					<button class:on={settingsTab === 'yaml'} onclick={() => (settingsTab = 'yaml')} data-tip="Edit the YAML text; applied as one operation by splice">YAML</button>
				</div>
				<div class="pb">
					{#if s && walker}
							{#if settingsTab === 'form'}<div class="scroll"><Settings {s} {node} {walker} menu={menuFor} onadd={addEntry} onaction={treeAction} onshow={(p) => { const g = nodeAt(s!.model.data, p); if (g) show(String(g.node.id), String(g.node.type)); }} shown={activePtr} /></div>{:else}<YamlTab m={s.model} />{/if}
					{/if}
				</div>
			</section>
			<PaneSplitter dir="col" label="Resize Settings" size={eff.settings} min={MIN.settings} max={maxOf('settings')} onsize={(px) => resize('settings', px)} onreset={() => reset('settings')} onend={save} />
			<section class="pane graphics" class:mshow={mobilePane === 'graphics'}>
					{#if s}
						<div class="gview" class:split={show1d && show2d}>
							<div class="g2" class:hide={!show2d}>
								<Graphics {s} bind:mode {fitKey} highlight={hiShown} focus={roi} mirror={MIRROR[simId] ?? null} {probes} onprobe={() => (bottomTab = 'table')}
									plot={g2id} onplot={(id) => { plot2d = id; if (id) { const ps = (s?.model.data as { results?: { plots?: Array<{ id?: unknown }> } } | null)?.results?.plots ?? []; const i = ps.findIndex((g) => g?.id === id); if (i >= 0) selected = `/results/plots/${i}`; } }}
									{editLine} tools oncreated={(r) => { selected = r.pointer; editId = r.dataset; if (r.group) { plot1d = r.group; split = true; } }} ondragms={(ms) => (dragMs = ms)} />
								{#if mode === 'results' && hv}<Headlines s={hv} boxed />{/if}
								{#if g1 && !show1d}<button class="g1btn" data-tip={`Show the 1D plot group ${g1}`} onclick={() => (pane = '1d')}>1D: {g1}</button>{/if}
							</div>
							{#if show1d && g1}
								<div class="g1">
									<div class="g1h">
										<span class="mono" data-tip={`1D plot group ${g1}`}>{g1}</span>
										<span class="gap"></span>
										<button class:on={split} data-tip="Split: the field view above, this graph below" onclick={() => { split = !split; if (!split) pane = '1d'; }}>Split</button>
										{#if !split}<button data-tip="Show the field view (2D)" onclick={() => (pane = '2d')}>Field</button>{/if}
										<button data-tip="Close the 1D view" onclick={() => { pane = '2d'; split = false; }}>Close</button>
									</div>
									<div class="g1b"><Plot1D {s} group={g1} onms={(ms) => { plotMs = ms; plotSeq++; }} /></div>
								</div>
							{/if}
						</div>
					{:else}<div class="loading dim">Loading model...</div>{/if}
			</section>
			{#if agentOpen}<PaneSplitter dir="col" label="Resize Agent panel" sign={-1} size={eff.agent} min={MIN.agent} max={maxOf('agent')} onsize={(px) => resize('agent', px)} onreset={() => reset('agent')} onend={save} />{/if}
			<section class="pane agent" class:hidden={!agentOpen}>
				<div class="ph">Agent</div>
				<div class="pb">{#if s && agentMounted}<AgentPanel {s} nav={navHost} />{/if}</div>
			</section>
		</div>
		<PaneSplitter dir="row" label="Resize bottom panel" sign={-1} size={eff.bottom} min={MIN.bottom} max={maxOf('bottom')} onsize={(px) => resize('bottom', px)} onreset={() => reset('bottom')} onend={save} />
		<section class="bottom" class:mshow={mobilePane === 'bottom'}>
			{#if s}<Bottom {s} bind:tab={bottomTab} onjump={jump} {probes} />{/if}
		</section>
	</div>
{/if}

<style>
	.fail { padding: 20px; color: var(--crit); }
	.wb { height: 100%; display: grid; grid-template-rows: 30px minmax(0, 1fr) 3px var(--bh); background: var(--bg); }
	.tb .home { color: var(--ink); text-decoration: none; font-weight: 600; padding: 0 4px; }
	.tb .phys { color: var(--ink-2); white-space: nowrap; padding: 0 4px; }
	.tb { display: flex; align-items: center; gap: 4px; padding: 0 6px; background: var(--surface); border-bottom: 1px solid var(--line); min-width: 0; overflow: hidden; }
	.gap { width: 8px; flex: none; }
	.case { display: flex; align-items: center; gap: 3px; font-size: 11px; color: var(--ink-2); white-space: nowrap; }
	.btn { display: inline-flex; align-items: center; height: 22px; padding: 0 8px; border: 1px solid var(--border); background: var(--surface-3); color: var(--ink); }
	.st { margin-left: 8px; font-size: 11px; color: var(--ink-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.mob { display: none; margin-left: auto; }
	.main { display: grid; grid-template-columns: var(--tw) 3px var(--sw) 3px minmax(0, 1fr) var(--cs) var(--cw); min-height: 0; }
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
	.gview { position: absolute; inset: 0; display: grid; grid-template-rows: minmax(0, 1fr); }
	.gview.split { grid-template-rows: minmax(0, 1fr) minmax(0, 1fr); }
	.g2, .g1 { position: relative; min-height: 0; overflow: hidden; }
	.g2.hide { display: none; }
	.g1 { display: grid; grid-template-rows: 22px minmax(0, 1fr); background: var(--bg); }
	.gview.split .g1 { border-top: 1px solid var(--line); }
	.g1h { display: flex; align-items: center; gap: 3px; padding: 0 4px; font-size: 11px; color: var(--ink-2); border-bottom: 1px solid var(--line); }
	.g1h button { height: 18px; font-size: 11px; padding: 0 6px; }
	.g1h button.on { border-color: var(--accent); }
	.g1b { position: relative; min-height: 0; }
	.g1btn { position: absolute; right: 90px; bottom: 22px; height: 20px; font-size: 11px; }
	.loading { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; }
	.bottom { position: relative; min-height: 0; }
	@media (max-width: 760px) {
		.wb { grid-template-rows: auto minmax(0, 1fr) 0 0; }
		/* fixed height (same in the route shell) so the page does not shift after mount (audit M1) */
		.tb { flex-wrap: wrap; align-content: flex-start; padding: 3px 6px; height: 84px; row-gap: 3px; }
		.tb .case, .tb .agentb { display: none; }
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
