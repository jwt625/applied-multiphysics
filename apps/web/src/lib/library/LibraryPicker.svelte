<script lang="ts">
	// SPDX-License-Identifier: GPL-3.0-or-later
	// Example library picker (lane W3, DevLog-021 s.3): the sims grouped by category, with search, filters (category,
	// physics, dimension, eval class) and a hover tooltip per row (eval case, reference, run status). Popover mode: a
	// trigger button that opens the panel under it; inline mode: the panel only. Picking calls `onpick(id)`; the host
	// loads the model (e.g. Workbench goModel). Not mounted by this lane.
	import { SIM_IDS } from '../sims';
	import { CATALOG, CATEGORIES, entryTip, libraryFor, matches, type CatalogEntry, type Category, type Dim, type EvalClass, type RefStatus } from './catalog';

	let {
		current = '',
		onpick,
		available = SIM_IDS,
		entries = CATALOG,
		inline = false,
		open = $bindable(false),
	}: {
		/** id of the open model (marked in the list, shown on the trigger) */
		current?: string;
		/** called with the picked sims id; the popover closes itself */
		onpick: (id: string) => void;
		/** sims ids that exist (default sims.ts SIM_IDS); entries without a file are hidden, files without an entry are listed under Other */
		available?: readonly string[];
		entries?: readonly CatalogEntry[];
		/** render the panel only, always open (no trigger) */
		inline?: boolean;
		/** popover state (bindable) */
		open?: boolean;
	} = $props();

	const SHORT: Record<Category, string> = { multiphysics: 'Multiphysics', heat: 'Heat', structural: 'Structural', 'em-static': 'EM static', rf: 'RF', optics: 'Optics', acoustics: 'Acoustics', 'fluids-rt': 'Fluids / RT' };
	const DIMS: Dim[] = ['2D', 'axisym', '3D'];
	const CLASSES: EvalClass[] = ['a', 'b', 'c'];
	const STATUS_TIP: Record<RefStatus, string> = {
		pass: 'gated targets pass', fail: 'a gated target fails', error: 'run error', pending: 'not runnable yet (see tooltip)',
		info: 'only non-gated targets ran', 'not-run': 'no harness run of this file',
	};

	let query = $state('');
	let cats = $state<Category[]>([]);
	let dims = $state<Dim[]>([]);
	let classes = $state<EvalClass[]>([]);
	let physics = $state('');
	let active = $state(0);
	let root = $state<HTMLDivElement>();
	let search = $state<HTMLInputElement>();
	let listEl = $state<HTMLDivElement>();
	// dropdown: fixed at the trigger's rect so a clipping ancestor (toolbar overflow: hidden) cannot cut it (coordinator 2026-11-06)
	let pos = $state('');
	$effect(() => {
		if (!open || inline || !root) return;
		const place = () => { const r = root!.getBoundingClientRect(); pos = `top: ${r.bottom + 2}px; left: ${Math.max(8, Math.min(r.left, innerWidth - Math.min(720, innerWidth - 16) - 8))}px`; };
		place(); addEventListener('resize', place);
		return () => removeEventListener('resize', place);
	});

	const lib = $derived(libraryFor(available, entries));
	const physicsList = $derived([...new Set(lib.entries.flatMap((e) => e.physics))].sort());
	const filters = $derived({ categories: cats, dims, classes, physics: physics ? [physics] : [] });
	const shown = $derived(lib.entries.filter((e) => matches(e, query, filters)));
	const anyFilter = $derived(!!(query || cats.length || dims.length || classes.length || physics));
	const groups = $derived(CATEGORIES.map((c) => ({ ...c, items: shown.filter((e) => e.category === c.id) })));
	// uncatalogued files carry no metadata: hidden by any filter, matched by id against the search words
	const others = $derived(cats.length || dims.length || classes.length || physics ? [] : lib.uncatalogued.filter((id) => query.toLowerCase().split(/\s+/).filter(Boolean).every((w) => id.toLowerCase().includes(w))));
	/** flat pick order (keyboard): grouped entries, then the uncatalogued ids */
	const order = $derived([...groups.flatMap((g) => g.items.map((e) => e.id)), ...others]);
	const cur = $derived(lib.entries.find((e) => e.id === current));
	const isOpen = $derived(inline || open);

	$effect(() => { void order.length; active = Math.min(active, Math.max(0, order.length - 1)); });
	$effect(() => { if (open && !inline) queueMicrotask(() => search?.focus()); });
	$effect(() => {
		if (!open || inline) return;
		const away = (e: PointerEvent) => { if (root && !root.contains(e.target as Node)) open = false; };
		document.addEventListener('pointerdown', away, true);
		return () => document.removeEventListener('pointerdown', away, true);
	});

	function toggle<T>(list: T[], v: T): T[] { return list.includes(v) ? list.filter((x) => x !== v) : [...list, v]; }
	function pick(id: string) { onpick(id); if (!inline) open = false; }
	function clearAll() { query = ''; cats = []; dims = []; classes = []; physics = ''; search?.focus(); }
	function onkey(e: KeyboardEvent) {
		if (e.key === 'Escape') { if (!inline) { open = false; e.stopPropagation(); } return; }
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			e.preventDefault();
			if (!order.length) return;
			active = (active + (e.key === 'ArrowDown' ? 1 : order.length - 1)) % order.length;
			listEl?.querySelector(`[data-id="${CSS.escape(order[active]!)}"]`)?.scrollIntoView({ block: 'nearest' });
		} else if (e.key === 'Enter' && order[active]) { e.preventDefault(); pick(order[active]!); }
	}
	const idx = (id: string) => order.indexOf(id);
</script>

<div class="lib" class:inline bind:this={root}>
	{#if !inline}
		<button class="trig" class:on={open} onclick={() => (open = !open)} data-tip={cur ? `${entryTip(cur)}\n\nClick: example library` : `${current || 'no model'}\nClick: example library`} aria-haspopup="listbox" aria-expanded={open}>
			{#if cur}<span class="tc">{SHORT[cur.category]}</span><span class="tt">{cur.title}</span>{:else}<span class="tt mono">{current || 'Library'}</span>{/if}
			<span class="caret"></span>
		</button>
	{/if}
	{#if isOpen}
		<div class="panel" style={inline ? undefined : pos} role="dialog" aria-label="Example library" tabindex="-1" onkeydown={onkey}>
			<div class="row1">
				<input bind:this={search} bind:value={query} placeholder="Search id, title, tag, case (e.g. SM-21)" spellcheck="false" data-tip="Every word must match id, title, category, physics, eval case or tag. Up / Down to move, Enter to open, Esc to close" />
				<select bind:value={physics} data-tip="Physics module of the model">
					<option value="">physics: any</option>
					{#each physicsList as p}<option value={p}>{p}</option>{/each}
				</select>
				<span class="count" data-tip="Shown / in the library">{shown.length + others.length} / {lib.entries.length + lib.uncatalogued.length}</span>
				<button class="clr" disabled={!anyFilter} onclick={clearAll} data-tip="Clear search and filters">Clear</button>
			</div>
			<div class="row2">
				{#each CATEGORIES as c}
					<button class="chip" class:on={cats.includes(c.id)} onclick={() => (cats = toggle(cats, c.id))} data-tip={`${c.label}: ${c.tip}`}>{SHORT[c.id]}</button>
				{/each}
				<span class="sep"></span>
				{#each DIMS as d}
					<button class="chip" class:on={dims.includes(d)} onclick={() => (dims = toggle(dims, d))} data-tip={`Model dimension ${d} (a 1D case solved on a strip counts as 2D)`}>{d}</button>
				{/each}
				<span class="sep"></span>
				{#each CLASSES as k}
					<button class="chip" class:on={classes.includes(k)} onclick={() => (classes = toggle(classes, k))} data-tip={`Eval class ${k} (eval/cases/${k})`}>{k}</button>
				{/each}
			</div>
			<div class="list" bind:this={listEl} role="listbox" aria-label="Models">
				{#each groups as g (g.id)}
					{#if g.items.length || !anyFilter}
						<div class="grp">
						<div class="gh" class:empty={!g.items.length} data-tip={g.tip}>{g.label}<span class="gn">{g.items.length}</span></div>
						{#each g.items as e (e.id)}
							<button class="it" class:act={idx(e.id) === active} class:cur={e.id === current} data-id={e.id} role="option" aria-selected={e.id === current} onclick={() => pick(e.id)} onpointermove={() => (active = idx(e.id))} data-tip={entryTip(e)}>
								<span class="st {e.ref.status}" title={STATUS_TIP[e.ref.status]}></span>
								<span class="id">{e.id}</span>
								<span class="ti">{e.title}</span>
								<span class="ph">{e.physics.join(', ')}</span>
								<span class="dm">{e.dimension}</span>
								<span class="cs">{e.evalCases.join(' ')}</span>
								<span class="fl">{#if e.hero}<i data-tip="Has a Play view">P</i>{/if}{#if e.analog}<i data-tip={`Analog: ${e.analog}`}>A</i>{/if}</span>
							</button>
						{/each}
						</div>
					{/if}
				{/each}
				{#if others.length}
					<div class="grp">
					<div class="gh" data-tip="sims files without a catalog entry yet">Other<span class="gn">{others.length}</span></div>
					{#each others as id (id)}
						<button class="it" class:act={idx(id) === active} class:cur={id === current} data-id={id} role="option" aria-selected={id === current} onclick={() => pick(id)} onpointermove={() => (active = idx(id))} data-tip={`sims/${id}.yaml (no catalog entry)`}>
							<span class="st not-run"></span><span class="id">{id}</span><span class="ti na">no catalog entry</span><span class="ph"></span><span class="dm"></span><span class="cs"></span><span class="fl"></span>
						</button>
					{/each}
					</div>
				{/if}
				{#if !order.length}<div class="none">No model matches.</div>{/if}
			</div>
		</div>
	{/if}
</div>

<style>
	.lib { position: relative; display: inline-block; font-size: 12px; }
	.lib.inline { display: block; height: 100%; }
	button { font: inherit; color: inherit; border-radius: 0; }
	.trig { display: inline-flex; align-items: center; gap: 6px; height: 22px; max-width: 340px; padding: 0 6px; background: var(--surface-2); border: 1px solid var(--border); cursor: pointer; }
	.trig:hover, .trig.on { background: var(--surface-3); }
	.tc { color: var(--ink-3); font-size: 11px; }
	.tt { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.mono, .id, .cs { font-family: var(--mono); }
	.caret { width: 0; height: 0; border-left: 4px solid transparent; border-right: 4px solid transparent; border-top: 4px solid var(--ink-3); }
	.panel { position: fixed; z-index: 60; width: min(720px, calc(100vw - 16px)); max-height: min(72vh, 600px); display: flex; flex-direction: column; background: var(--surface); border: 1px solid var(--border); box-shadow: 0 6px 18px rgba(0, 0, 0, 0.55); outline: none; }
	.inline .panel { position: static; width: 100%; max-height: none; height: 100%; box-shadow: none; }
	.row1, .row2 { display: flex; align-items: center; gap: 4px; padding: 4px; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
	.row1 input { flex: 1 1 200px; min-width: 0; height: 22px; padding: 0 6px; background: var(--bg); color: var(--ink); border: 1px solid var(--border); border-radius: 0; font: inherit; }
	.row1 input:focus { outline: 1px solid var(--accent); outline-offset: -1px; }
	.row1 select { height: 22px; background: var(--surface-2); color: var(--ink); border: 1px solid var(--border); border-radius: 0; font: inherit; }
	.count { color: var(--ink-3); font-family: var(--mono); font-size: 11px; padding: 0 4px; }
	.clr { height: 22px; padding: 0 6px; background: var(--surface-2); border: 1px solid var(--border); cursor: pointer; }
	.clr:disabled { opacity: 0.4; cursor: default; }
	.chip { height: 20px; padding: 0 6px; background: transparent; border: 1px solid var(--line); color: var(--ink-2); cursor: pointer; font-size: 11px; }
	.chip:hover { background: var(--hover); }
	.chip.on { background: var(--sel); border-color: var(--accent); color: var(--ink); }
	.sep { width: 1px; height: 14px; background: var(--line); margin: 0 2px; }
	.list { overflow-y: auto; flex: 1 1 auto; min-height: 0; }
	.gh { position: sticky; top: 0; z-index: 1; display: flex; align-items: center; gap: 6px; height: 20px; padding: 0 6px; background: var(--surface-2); color: var(--ink-2); font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; border-bottom: 1px solid var(--line); }
	.gh.empty { color: var(--na); }
	.gn { color: var(--ink-3); font-family: var(--mono); }
	.it { display: grid; grid-template-columns: 8px 168px minmax(0, 1fr) 92px 44px 88px 22px; align-items: center; gap: 6px; width: 100%; height: var(--row, 20px); padding: 0 6px; background: transparent; border: 0; text-align: left; cursor: pointer; }
	.it.act { background: var(--hover); }
	.it.cur { background: var(--sel); }
	.it > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.id { color: var(--ink); font-size: 11px; }
	.ti { color: var(--ink-2); }
	.ti.na, .none { color: var(--na); }
	.ph, .dm { color: var(--ink-3); font-size: 11px; }
	.cs { color: var(--ink-3); font-size: 11px; }
	.fl { display: flex; gap: 2px; }
	.fl i { font-style: normal; font-size: 9px; line-height: 12px; padding: 0 2px; border: 1px solid var(--line); color: var(--ink-3); }
	.st { width: 7px; height: 7px; background: var(--na); }
	.st.pass { background: var(--good); }
	.st.fail, .st.error { background: var(--crit); }
	.st.pending { background: var(--warn); }
	.st.info { background: var(--accent); }
	.st.not-run { background: transparent; border: 1px solid var(--na); }
	.none { padding: 8px; }
	@media (max-width: 640px) {
		.it { grid-template-columns: 8px minmax(0, 1fr) 44px 22px; }
		.it .ti, .it .ph { display: none; }
		.it .cs { display: none; }
	}
</style>
