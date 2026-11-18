<script lang="ts">
	// SPDX-License-Identifier: GPL-3.0-or-later
	// 3D toolbar controls (split from Graphics.svelte, DevLog-052): cutaway (revolved views), section, slice, isosurfaces,
	// deformation scale.
	import { fmt } from './ticks';

	let {
		rev, results, nodal, hasDisp, deform, autoScale,
		cutaway = $bindable(true), clipOn = $bindable(false), clipAxis = $bindable(0), clipFrac = $bindable(0.5),
		sliceOn = $bindable(false), sliceAxis = $bindable(2), sliceFrac = $bindable(0.5), isoOn = $bindable(false), isoN = $bindable(5),
		deformOn = $bindable(true), deformUser = $bindable(null)
	}: {
		rev: boolean; results: boolean; nodal: boolean; hasDisp: boolean; deform: number; autoScale: number;
		cutaway?: boolean; clipOn?: boolean; clipAxis?: 0 | 1 | 2; clipFrac?: number; sliceOn?: boolean; sliceAxis?: 0 | 1 | 2; sliceFrac?: number;
		isoOn?: boolean; isoN?: number; deformOn?: boolean; deformUser?: number | null;
	} = $props();
</script>

{#if rev}<button class:on={cutaway} data-tip="Cutaway: a quarter of the revolved body removed (phi 270 to 360 deg); the two meridional section planes show the field inside (the vertex-averaged P1 projection of the (r, z) Nedelec solution times the azimuthal factor)" onclick={() => (cutaway = !cutaway)}>Cutaway</button>{/if}
<button class:on={clipOn} data-tip="Section: cut away the half space beyond the plane" onclick={() => (clipOn = !clipOn)}>Section</button>
{#if clipOn}
	<select bind:value={clipAxis}>{#each ['x', 'y', 'z'] as a, i}<option value={i}>{a}</option>{/each}</select>
	<input type="range" min="0" max="1" step="0.005" bind:value={clipFrac} data-tip="Section position (fraction of the bounding box)" />
{/if}
{#if results && nodal}
	<button class:on={sliceOn} data-tip="Slice plane of the field" onclick={() => (sliceOn = !sliceOn)}>Slice</button>
	{#if sliceOn}
		<select bind:value={sliceAxis}>{#each ['x', 'y', 'z'] as a, i}<option value={i}>{a}</option>{/each}</select>
		<input type="range" min="0" max="1" step="0.005" bind:value={sliceFrac} />
	{/if}
	<button class:on={isoOn} data-tip="Isosurfaces at evenly spaced levels inside the colour range" onclick={() => (isoOn = !isoOn)}>Iso</button>
	{#if isoOn}<input class="n" type="number" min="1" max="12" bind:value={isoN} data-tip="Number of isosurfaces" />{/if}
{/if}
{#if hasDisp}
	<button class:on={deformOn} data-tip="Deformation p + s u" onclick={() => (deformOn = !deformOn)}>Deform</button>
	<input class="n" type="number" value={fmt(deform, 3)} data-tip={`deformation scale s; auto = 10 % of the bounding-box diagonal over max |u| = ${fmt(autoScale)}`} onchange={(e) => { const v = Number((e.currentTarget as HTMLInputElement).value); deformUser = Number.isFinite(v) && v >= 0 ? v : null; }} />
	{#if deformUser !== null}<button data-tip="Back to the automatic scale" onclick={() => (deformUser = null)}>auto</button>{/if}
{/if}

<style>
	.n { width: 56px; }
</style>
