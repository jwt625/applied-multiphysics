<script lang="ts">
	// SPDX-License-Identifier: GPL-3.0-or-later
	// One example card (DevLog-030): 4:3 preview with geometry / mesh / result views (result default; hovering or
	// clicking a view tab switches), title, physics (or the coupling chain), dimension, run status; details in the
	// tooltip. The card opens the workbench; heroes get a Play badge.
	import { resolve } from '$app/paths';
	import { entryTip, physicsChain, type CatalogEntry } from '../library/catalog';
	import { defaultView, previewUrl, VIEWS, type PreviewEntry, type View } from './previews';

	let { id, entry, preview, eager = false }: { id: string; entry: CatalogEntry | null; preview: PreviewEntry | null; eager?: boolean } = $props();

	const STATUS: Record<string, string> = { pass: 'gated targets pass', fail: 'a gated target fails', error: 'run error', pending: 'pending', info: 'only non-gated targets ran', 'not-run': 'no harness run of this file' };
	const first = $derived(defaultView(preview));
	let view = $state<View | null>(null);
	const shown = $derived(view && preview?.files[view] ? view : first);
	const file = $derived(shown ? preview?.files[shown] ?? null : null);
	const chain = $derived(entry ? physicsChain(entry) : null);
	const href = $derived(resolve(`/workbench?sim=${encodeURIComponent(id)}`));
	const tip = $derived.by(() => {
		const head = entry ? entryTip(entry) : `sims/${id}.yaml (no catalog entry)`;
		const miss = Object.entries(preview?.missing ?? {}).map(([k, v]) => `${k} preview: ${v}`);
		const pv = !preview ? 'Preview: not generated' : `Preview: ${preview.date}${preview.cells ? `, ${preview.cells} cells` : ''}`;
		return [head, pv, ...miss, 'Click: open in the workbench'].join('\n');
	});
	const viewTip = (v: (typeof VIEWS)[number]) => preview?.files[v.id] ? v.tip : `${v.tip}: ${preview?.missing?.[v.id] ?? 'no image'}`;
</script>

<div class="card" role="group" aria-label={entry?.title ?? id} onpointerleave={() => (view = null)}>
	<a class="hit" {href} data-sveltekit-reload data-tip={tip}>
		<div class="pv">
			{#if file}
				<img src={previewUrl(file)} alt="{entry?.title ?? id}: {VIEWS.find((v) => v.id === shown)?.tip}" width="480" height="360" loading={eager ? 'eager' : 'lazy'} decoding="async" />
			{:else}
				<span class="nopv">no preview</span>
			{/if}
		</div>
		<div class="ti">{entry?.title ?? id}</div>
		<div class="meta">
			<span class="st {entry?.ref.status ?? 'not-run'}" title={STATUS[entry?.ref.status ?? 'not-run']}></span>
			{#if chain}
				{#each chain as p, i}{#if i}<span class="arr">-&gt;</span>{/if}<span class="ph">{p}</span>{/each}
			{:else}
				{#each entry?.physics ?? [] as p}<span class="ph">{p}</span>{/each}
			{/if}
			<span class="sp"></span>
			{#if entry}<span class="dm">{entry.dimension}</span>{/if}
		</div>
	</a>
	{#if preview}
		<div class="tabs" role="tablist" aria-label="Preview view">
			{#each VIEWS as v}
				<button role="tab" aria-selected={shown === v.id} class:on={shown === v.id} disabled={!preview.files[v.id]} onpointerenter={() => (view = v.id)} onfocus={() => (view = v.id)} onclick={() => (view = v.id)} data-tip={viewTip(v)}>{v.label}</button>
			{/each}
		</div>
	{/if}
	{#if entry?.hero}<a class="play" href={resolve('/play/[sim]', { sim: id })} data-sveltekit-reload data-tip="Play view: drag handles, sliders, live accuracy">Play</a>{/if}
</div>

<style>
	.card { position: relative; background: var(--surface); border: 1px solid var(--line); min-width: 0; }
	.card:hover { border-color: #4a4a44; }
	.hit { display: block; color: var(--ink); }
	.hit:focus-visible { outline: 1px solid var(--accent); outline-offset: -1px; }
	.pv { position: relative; aspect-ratio: 4 / 3; background: var(--bg); border-bottom: 1px solid var(--line); overflow: hidden; }
	.pv img { display: block; width: 100%; height: 100%; object-fit: cover; }
	.nopv { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: var(--na); font-size: 11px; }
	.ti { padding: 4px 6px 0; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.meta { display: flex; align-items: center; gap: 3px; padding: 3px 6px 5px; min-width: 0; overflow: hidden; white-space: nowrap; }
	.ph { font: 10px/14px var(--mono); padding: 0 3px; border: 1px solid var(--line); color: var(--ink-2); flex: 0 0 auto; }
	.arr { font: 10px var(--mono); color: var(--ink-3); }
	.dm { font: 10px var(--mono); color: var(--ink-3); flex: 0 0 auto; }
	.sp { flex: 1 1 auto; }
	.st { width: 7px; height: 7px; flex: 0 0 auto; background: var(--na); margin-right: 2px; }
	.st.pass { background: var(--good); }
	.st.fail, .st.error { background: var(--crit); }
	.st.pending { background: var(--warn); }
	.st.info { background: var(--accent); }
	.st.not-run { background: transparent; border: 1px solid var(--na); }
	.tabs { position: absolute; left: 4px; top: 4px; display: flex; }
	.tabs button { height: 16px; width: 18px; padding: 0; font: 10px var(--mono); background: rgba(13, 13, 13, 0.78); border: 1px solid var(--border); color: var(--ink-2); }
	.tabs button + button { border-left: 0; }
	.tabs button.on { background: #2462b5; border-color: #2462b5; color: #ffffff; }
	.tabs button:disabled { opacity: 0.35; }
	.play { position: absolute; right: 4px; top: 4px; height: 16px; padding: 0 5px; font: 10px/14px var(--mono); background: rgba(13, 13, 13, 0.78); border: 1px solid var(--accent); color: var(--ink); }
	.play:hover { background: #2462b5; }
</style>
