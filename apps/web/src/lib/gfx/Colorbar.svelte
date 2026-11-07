<script lang="ts">
	// SPDX-License-Identifier: GPL-3.0-or-later
	// Colorbar in absolute display units (s.6): nice ticks plus the end values (linear) or decades (log), 3 significant
	// figures; the tooltip states the quantity, the range rule and any normalization. Vertical on the right; horizontal
	// along the bottom on phones (<= 760 px, audit M12).
	import { cssGradient, type ColormapName } from './colormaps';
	import { fmt, logTicks, niceTicks } from './ticks';
	import { scaleT, type ScaleMode } from './renderer2d';
	import { unitLabel } from './units';

	let { colormap, min, max, scale = 'linear', label, unit, note = '', rule = 'full', scoped = false, levels = [] }: { colormap: ColormapName; min: number; max: number; scale?: ScaleMode; label: string; unit: string; note?: string; rule?: 'full' | 'robust'; scoped?: boolean; levels?: number[] } = $props();

	const pos = (v: number) => 100 * Math.min(1, Math.max(0, scaleT(v, scale, { min, max })));
	// contour levels drawn on the canvas, marked inside the bar
	const marks = $derived(levels.map(pos).filter((p) => p > 0.5 && p < 99.5));

	// interior nice ticks that do not crowd the end labels, plus both ends (audit M7)
	const ticks = $derived.by(() => {
		const inner = (scale === 'log' ? logTicks(min, max) : niceTicks(min, max, 5)).filter((t) => Math.abs(pos(t) - 0) > 7 && Math.abs(pos(t) - 100) > 7);
		return [min, ...inner, max];
	});
	const u = $derived(unitLabel(unit));
	const tip = $derived(`${label}${u ? ` [${u}]` : ' (dimensionless)'}\nrange ${fmt(min)} to ${fmt(max)}${u ? ` ${u}` : ''}${scale === 'log' ? ', log scale' : ''}\nrule: ${rule === 'robust' ? 'area-weighted 1st-99th percentile (values outside saturate)' : 'full min to max'}${scoped ? ', over the view box' : ''}${levels.length ? `\ncontour lines at the ${levels.length} marks in the bar (step ${fmt(levels.length > 1 ? levels[1]! - levels[0]! : 0)}${u ? ` ${u}` : ''})` : ''}${note ? `\n${note}` : ''}`);
</script>

<div class="cb" data-tip={tip}>
	<div class="lab mono">{u || (note ? 'norm.' : '1')}{rule === 'robust' ? ' p1-99' : ''}</div>
	<div class="bar v" style="background: {cssGradient(colormap)}">
		{#each marks as m}<div class="lvl" style="bottom: {m}%"></div>{/each}
		{#each ticks as t}<div class="tick" style="bottom: {pos(t)}%"><span class="mono">{fmt(t)}</span></div>{/each}
	</div>
	<div class="bar h" style="background: {cssGradient(colormap, false, 'to right')}">
		{#each marks as m}<div class="lvlh" style="left: {m}%"></div>{/each}
		{#each ticks as t}<div class="tickh" style="left: {pos(t)}%"><span class="mono">{fmt(t)}</span></div>{/each}
	</div>
</div>

<style>
	.cb { position: absolute; right: 0; top: 0; bottom: 0; width: 84px; padding: 10px 6px 26px 12px; background: #0d0d0d; border-left: 1px solid var(--line); display: flex; flex-direction: column; align-items: flex-start; pointer-events: none; }
	.lab { font-size: 12px; color: var(--ink); margin-bottom: 10px; white-space: nowrap; pointer-events: auto; }
	.bar { position: relative; border: 1px solid var(--border); }
	.bar.v { width: 14px; flex: 1; pointer-events: auto; }
	.lvl { position: absolute; left: 0; right: 0; height: 0; border-top: 1px solid rgba(13, 13, 13, 0.55); }
	.lvlh { position: absolute; top: 0; bottom: 0; width: 0; border-left: 1px solid rgba(13, 13, 13, 0.55); }
	.bar.h { display: none; }
	.tick { position: absolute; left: 14px; height: 0; border-top: 1px solid var(--ink-3); width: 4px; }
	.tick span { position: absolute; left: 7px; top: -7px; font-size: 10px; color: var(--ink-2); white-space: nowrap; }
	.tickh { position: absolute; top: 12px; width: 0; height: 4px; border-left: 1px solid var(--ink-3); }
	.tickh span { position: absolute; top: 4px; left: 0; transform: translateX(-50%); font-size: 10px; color: var(--ink-2); white-space: nowrap; }
	@media (max-width: 760px) {
		.cb { top: auto; left: 0; right: 0; bottom: 0; width: auto; height: 52px; flex-direction: row; align-items: flex-start; gap: 10px; padding: 8px 22px 4px 8px; border-left: 0; border-top: 1px solid var(--line); }
		.bar.v { display: none; }
		.bar.h { display: block; flex: 1; height: 12px; margin-top: 2px; pointer-events: auto; }
	}
</style>
