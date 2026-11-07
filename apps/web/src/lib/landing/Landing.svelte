<script lang="ts">
	// SPDX-License-Identifier: GPL-3.0-or-later
	// Landing page (DevLog-030, after the gdsjam example gallery in this project's style): search, category chips with
	// counts, the examples grouped by category (Multiphysics first), one card per sims file with geometry / mesh /
	// result previews. Same entry set as the workbench library picker.
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import Tip from '../ui/Tip.svelte';
	import Card from './Card.svelte';
	import { CATALOG, CATEGORIES, libraryFor, matches, type Category } from '../library/catalog';
	import { DEFAULT_SIM, HEROES, SIM_IDS } from '../sims';
	import { previewOf } from './previews';

	// Same rule as the workbench picker (Workbench.svelte, coordinator DevLog-021): EM problems solved through the
	// acoustics module show the field as pressure in Pa, so they stay out of the library until an EM module runs them.
	const ANALOG = new Set(CATALOG.filter((e) => e.analog && e.physics.includes('acoustics') && e.category !== 'acoustics').map((e) => e.id));
	const lib = libraryFor(SIM_IDS.filter((id) => !ANALOG.has(id)), CATALOG.filter((e) => !ANALOG.has(e.id)));
	const total = lib.entries.length + lib.uncatalogued.length;

	let query = $state('');
	let cats = $state<Category[]>([]);
	let search = $state<HTMLInputElement>();

	const hits = $derived(lib.entries.filter((e) => matches(e, query)));
	const counts = $derived(new Map(CATEGORIES.map((c) => [c.id, hits.filter((e) => e.category === c.id).length])));
	const present = CATEGORIES.filter((c) => lib.entries.some((e) => e.category === c.id));
	const groups = $derived(present.filter((c) => !cats.length || cats.includes(c.id)).map((c) => ({ ...c, items: hits.filter((e) => e.category === c.id) })).filter((g) => g.items.length));
	const words = $derived(query.toLowerCase().split(/\s+/).filter(Boolean));
	const others = $derived(cats.length ? [] : lib.uncatalogued.filter((id) => words.every((w) => id.toLowerCase().includes(w))));
	const shown = $derived(groups.reduce((n, g) => n + g.items.length, 0) + others.length);

	function toggle(c: Category) { cats = cats.includes(c) ? cats.filter((x) => x !== c) : [...cats, c]; }
	function clear() { query = ''; cats = []; search?.focus(); }

	onMount(() => {
		const key = (e: KeyboardEvent) => {
			const t = e.target as HTMLElement | null;
			const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
			if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); search?.focus(); search?.select(); }
			else if (e.key === 'Escape' && t === search) { if (query) query = ''; else search?.blur(); }
		};
		window.addEventListener('keydown', key);
		return () => window.removeEventListener('keydown', key);
	});
</script>

<Tip />
<div class="land">
	<header>
		<span class="brand">applied-multiphysics</span>
		<span class="line dim">browser-native multiphysics: geometry, mesh, solve and results in the browser</span>
		<span class="gap"></span>
		<nav>
			<a href={resolve(`/workbench?sim=${DEFAULT_SIM}`)} data-sveltekit-reload data-tip="Open the workbench (model {DEFAULT_SIM})">Workbench</a>
			<a href={resolve('/play/[sim]', { sim: HEROES[0] ?? DEFAULT_SIM })} data-sveltekit-reload data-tip={`Play views: ${HEROES.join(', ')} (cards marked Play)`}>Play</a>
			<a href="https://github.com/jwt625/applied-multiphysics" rel="noopener" data-tip="Source (GPL-3.0-or-later)">GitHub</a>
		</nav>
	</header>
	<div class="bar">
		<div class="q">
			<input bind:this={search} bind:value={query} type="search" placeholder="Search" spellcheck="false" aria-label="Search examples" data-tip="Every word must match id, title, category, physics, eval case (e.g. SM-21) or tag. / focuses, Esc clears" />
			<kbd>/</kbd>
		</div>
		<div class="chips">
			<button class="chip" class:on={!cats.length} onclick={() => (cats = [])} data-tip="All categories">All<span class="n">{hits.length + (cats.length ? 0 : others.length)}</span></button>
			{#each present as c (c.id)}
				<button class="chip" class:on={cats.includes(c.id)} onclick={() => toggle(c.id)} data-tip={`${c.label}: ${c.tip}`}>{c.label}<span class="n">{counts.get(c.id)}</span></button>
			{/each}
		</div>
		<span class="cnt mono" data-tip="Shown / examples">{shown} / {total}</span>
	</div>
	<main>
		{#each groups as g, gi (g.id)}
			<section>
				<h2 data-tip={g.tip}>{g.label}<span class="n">{g.items.length}</span></h2>
				<div class="grid">
					{#each g.items as e, i (e.id)}<Card id={e.id} entry={e} preview={previewOf(e.id)} eager={gi === 0 && i < 8} />{/each}
				</div>
			</section>
		{/each}
		{#if others.length}
			<section>
				<h2 data-tip="sims files without a catalog entry yet">Other<span class="n">{others.length}</span></h2>
				<div class="grid">
					{#each others as id (id)}<Card {id} entry={null} preview={previewOf(id)} />{/each}
				</div>
			</section>
		{/if}
		{#if !shown}<div class="none dim">No example matches. <button onclick={clear}>Clear</button></div>{/if}
	</main>
</div>

<style>
	.land { height: 100%; overflow-y: auto; overflow-x: hidden; background: var(--bg); }
	header { display: flex; align-items: center; gap: 10px; height: 34px; padding: 0 12px; background: var(--surface); border-bottom: 1px solid var(--line); min-width: 0; }
	.brand { font-weight: 600; white-space: nowrap; }
	.line { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
	.gap { flex: 1 1 auto; }
	nav { display: flex; gap: 2px; flex: 0 0 auto; }
	nav a { height: 22px; display: inline-flex; align-items: center; padding: 0 8px; border: 1px solid var(--border); background: var(--surface-3); color: var(--ink); }
	nav a:hover { background: #30302d; }
	.bar { position: sticky; top: 0; z-index: 5; display: flex; align-items: center; gap: 8px; padding: 6px 12px; background: rgba(13, 13, 13, 0.94); border-bottom: 1px solid var(--line); flex-wrap: wrap; }
	.q { position: relative; flex: 0 1 280px; min-width: 160px; display: flex; }
	.q input { width: 100%; height: 24px; padding: 0 22px 0 6px; }
	.q kbd { position: absolute; right: 5px; top: 5px; pointer-events: none; }
	.chips { display: flex; gap: 3px; flex-wrap: wrap; flex: 1 1 auto; min-width: 0; }
	.chip { height: 22px; padding: 0 6px; background: transparent; border: 1px solid var(--line); color: var(--ink-2); font-size: 11px; display: inline-flex; align-items: center; gap: 5px; }
	.chip:hover:not(:disabled) { background: var(--hover); }
	.chip.on { background: var(--sel); border-color: var(--accent); color: var(--ink); }
	.n { font: 10px var(--mono); color: var(--ink-3); }
	.chip.on .n { color: var(--ink-2); }
	.cnt { color: var(--ink-3); font-size: 11px; }
	main { padding: 4px 12px 24px; }
	section { margin-top: 10px; }
	h2 { display: flex; align-items: center; gap: 6px; margin: 0 0 6px; height: 22px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--ink-2); border-bottom: 1px solid var(--line); }
	.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(208px, 1fr)); gap: 8px; }
	.none { padding: 16px 0; display: flex; gap: 8px; align-items: center; }
	@media (max-width: 640px) {
		header { padding: 0 8px; gap: 8px; }
		.line { display: none; }
		.bar { padding: 6px 8px; gap: 6px; }
		.q { flex: 1 1 100%; }
		.chips { flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none; }
		.chip { flex: 0 0 auto; }
		.cnt { display: none; }
		main { padding: 4px 8px 24px; }
		.grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; }
	}
</style>
