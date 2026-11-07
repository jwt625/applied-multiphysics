// SPDX-License-Identifier: GPL-3.0-or-later
// Results tree operations (DevLog-027 gates 3, 4): every enabled "+" entry of every section and group type yields a
// valid spec through the op log; undo restores the text byte for byte and redo reproduces it; the same patch through
// the agent's apply_ops gives the same text; duplicate / disable / move / delete round trip; a cut-line end drag
// coalesces into one op. Runs the real mesher and FE module in Node (kirsch-exact, helmholtz-coil, box-acoustics).
// Run: node --max-old-space-size=1536 --test apps/web/src/lib/results/plot-ops.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createOpLog, parseSpecText, type OpLog, type Registry } from '@amp/spec';
import type { Mesh, Solution } from '@amp/spec/types';
import { physicsRegistry, prepareRun, registry as modules, RESULT_NAMES } from '@amp/physics';
import { AgentSession, MemoryStore, memoryBackend, RecordingNavHost } from '@amp/agent';
import { addMenu, addPatch, cascadeRemovePatch, cutLineEndPatch, cutLinePatch, cutPointPatch, duplicatePatch, movePatch, quickViewPatch, removePatch, togglePatch, type PlotCtx } from './plot-ops.ts';

const simText = (id: string) => readFileSync(new URL(`../../../../../sims/${id}.yaml`, import.meta.url), 'utf8');
const reg: Registry = physicsRegistry();

async function solved(id: string, solve = true): Promise<{ text: string; mesh: Mesh; sol: Solution | null }> {
	const text = simText(id);
	const log = await createOpLog(text, { registry: reg });
	const ctx = await prepareRun({ spec: log.data as Record<string, unknown> });
	const type = (log.data as { physics: Array<{ id: string; type: string }> }).physics.find((p) => p.id === ctx.physicsId)!.type;
	const sol = solve ? await modules[type]!.run(ctx) : null;
	return { text, mesh: ctx.mesh, sol };
}

async function agentApply(text: string, ops: unknown[]): Promise<string> {
	const log = await createOpLog(text, { registry: reg });
	const memory = await MemoryStore.open(memoryBackend({}));
	const s = new AgentSession({ log, registry: reg, memory, nav: new RecordingNavHost(null), sessionId: 'gate' });
	const r = await s.execute('apply_ops', { ops, reason: 'gate: same YAML diff as the UI' });
	assert.equal(r.isError, false, JSON.stringify(r.content).slice(0, 400));
	return log.text;
}

/** Apply every enabled entry of every menu (sections, then each group created), checking validity, undo, redo. */
async function everyEntry(text: string, mesh: Mesh, sol: Solution | null, tag: string): Promise<{ added: string[]; disabled: string[] }> {
	const log: OpLog = await createOpLog(text, { registry: reg });
	const ctx = (): PlotCtx => ({ data: log.data, mesh, sol, names: RESULT_NAMES });
	const added: string[] = [], disabled: string[] = [];
	const tryEntries = async (entries: ReturnType<typeof addMenu>) => {
		for (const e of entries) {
			if (e.disabled) { disabled.push(`${e.section}/${e.group ?? ''}/${e.type}: ${e.disabled}`); continue; }
			const a = addPatch(ctx(), e);
			assert.ok(a, `${tag} ${e.type}`);
			const before = log.text;
			const op = await log.apply(a.patch, { actor: 'user' });
			assert.ok(op.validation.ok, `${tag} ${e.section}/${e.type}: ${op.validation.errors.join('; ')}`);
			assert.ok(parseSpecText(log.text, reg).ok, `${tag} ${e.type} parse`);
			assert.deepEqual(op.invalidates, ['plots'], `${tag} ${e.type} invalidates plots only`);
			const after = log.text;
			await log.undo({ actor: 'user' });
			assert.equal(log.text, before, `${tag} ${e.type} undo`);
			await log.redo({ actor: 'user' });
			assert.equal(log.text, after, `${tag} ${e.type} redo`);
			added.push(`${e.section}/${e.group ?? ''}/${e.type}`);
		}
	};
	// groups first, so their item menus can be exercised
	for (const sec of ['datasets', 'evaluations', 'plots', 'tables'] as const) await tryEntries(addMenu(ctx(), sec));
	const r = log.data as { results: { evaluations?: Array<{ id: string }>; plots?: Array<{ id: string }> } };
	for (const g of r.results.evaluations ?? []) await tryEntries(addMenu(ctx(), 'evaluations', g.id));
	for (const g of r.results.plots ?? []) await tryEntries(addMenu(ctx(), 'plots', g.id));
	// tables after the evaluation group exists
	await tryEntries(addMenu(ctx(), 'tables'));
	return { added, disabled };
}

test('kirsch-exact: every enabled menu entry adds a valid node; undo / redo byte-exact', async () => {
	const { text, mesh, sol } = await solved('kirsch-exact');
	const { added, disabled } = await everyEntry(text, mesh, sol, 'kirsch');
	for (const t of ['datasets//solution', 'datasets//cutpoint', 'datasets//cutline', 'datasets//edge', 'datasets//mirror', 'plots//plot1d', 'plots//plot2d', 'evaluations//group', 'tables//table'])
		assert.ok(added.includes(t), `kirsch adds ${t} (added: ${added.join(', ')})`);
	for (const t of ['surface', 'contour', 'arrow', 'streamline', 'line', 'maxmin', 'point', 'mesh', 'deformation', 'height', 'linegraph', 'pointgraph', 'tablegraph'])
		assert.ok(added.some((a) => a.endsWith(`/${t}`)), `kirsch adds a ${t} item`);
	for (const t of ['point', 'integral', 'average', 'max', 'min', 'measure'])
		assert.ok(added.some((a) => a.startsWith('evaluations/') && a.endsWith(`/${t}`)), `kirsch adds an evaluation ${t}`);
	assert.ok(disabled.some((d) => d.includes('cutplane')) && disabled.some((d) => d.includes('revolve')), 'kirsch: 3D / axisym datasets disabled');
	console.log(`kirsch-exact: ${added.length} entries added, ${disabled.length} disabled:\n  ${disabled.join('\n  ')}`);
});

test('helmholtz-coil (axisym): revolve and plot3d entries; box-acoustics (3D): cutplane, plot3d items', async () => {
	const h = await solved('helmholtz-coil');
	const a = await everyEntry(h.text, h.mesh, h.sol, 'helmholtz');
	assert.ok(a.added.includes('datasets//revolve'), a.added.join(', '));
	const b = await solved('box-acoustics');
	const c = await everyEntry(b.text, b.mesh, b.sol, 'box');
	assert.ok(c.added.includes('datasets//cutplane'), c.added.join(', '));
	for (const t of ['surface', 'slice', 'isosurface', 'volume', 'maxmin', 'mesh'])
		assert.ok(c.added.some((x) => x.startsWith('plots/pg3d') && x.endsWith(`/${t}`)), `box adds plot3d ${t} (${c.added.join(', ')})`);
	console.log(`helmholtz: ${a.added.length} added, ${a.disabled.length} disabled; box: ${c.added.length} added, ${c.disabled.length} disabled`);
});

test('same YAML text for a node created by the UI patch and by agent apply_ops (gate 3)', async () => {
	const { text, mesh, sol } = await solved('kirsch-exact');
	const log = await createOpLog(text, { registry: reg });
	const ctx: PlotCtx = { data: log.data, mesh, sol, names: RESULT_NAMES };
	for (const [sec, type] of [['plots', 'plot1d'], ['datasets', 'cutline'], ['plots', 'plot2d'], ['evaluations', 'group']] as const) {
		const e = addMenu(ctx, sec).find((x) => x.type === type)!;
		const a = addPatch(ctx, e)!;
		const u = await createOpLog(text, { registry: reg });
		await u.apply(a.patch, { actor: 'user' });
		const t2 = await agentApply(text, a.patch);
		assert.equal(t2, u.text, `${type}: agent text equals UI text`);
		assert.notEqual(u.text, text);
	}
	// a drawn cut line with its 1D group (two patch entries, one op)
	const c = cutLinePatch(ctx, [0, 0.005], [0, 0.05], 'solid.sxx')!;
	const u = await createOpLog(text, { registry: reg });
	const op = await u.apply(c.patch, { actor: 'user' });
	assert.ok(op.validation.ok, op.validation.errors.join('; '));
	assert.equal(await agentApply(text, c.patch), u.text);
});

test('duplicate, disable / enable, move, delete: valid and undo byte-exact; cut-line end drag is one op', async () => {
	const { text, mesh, sol } = await solved('kirsch-exact');
	const log = await createOpLog(text, { registry: reg });
	const ctx = (): PlotCtx => ({ data: log.data, mesh, sol, names: RESULT_NAMES });
	const c = cutLinePatch(ctx(), [0, 0.005], [0, 0.05], 'solid.sxx')!;
	await log.apply(c.patch, { actor: 'user' });
	const p = cutPointPatch(ctx(), [0.02, 0.02])!;
	await log.apply(p.patch, { actor: 'user' });
	const base = log.text;
	const steps: Array<[string, unknown[] | null | undefined]> = [
		['duplicate dataset', duplicatePatch(log.data, c.pointer)?.patch],
		['duplicate plot group', duplicatePatch(log.data, '/results/plots/1')?.patch],
		['disable', togglePatch(log.data, '/results/plots/0')],
		['move down', movePatch(log.data, '/results/datasets/0', 1)?.patch],
		['delete point dataset', removePatch(log.data, p.pointer)]
	];
	for (const [name, patch] of steps) {
		assert.ok(patch && patch.length, name);
		const before = log.text;
		const op = await log.apply(patch as never, { actor: 'user' });
		assert.ok(op.validation.ok, `${name}: ${op.validation.errors.join('; ')}`);
		await log.undo({ actor: 'user' });
		assert.equal(log.text, before, `${name} undo`);
	}
	assert.equal(log.text, base);
	// enable after disable removes the key again
	await log.apply(togglePatch(log.data, '/results/plots/0'), { actor: 'user' });
	await log.apply(togglePatch(log.data, '/results/plots/0'), { actor: 'user' });
	assert.equal(log.text, base);
	// end drag: 30 steps, each a single-path replace with coalesce -> one op
	const n0 = log.ops.length;
	for (let k = 0; k < 30; k++) await log.apply(cutLineEndPatch(ctx(), c.pointer, 'to', [0.001 * k, 0.05]), { actor: 'user' }, k ? { coalesce: { windowMs: 1500 } } : undefined);
	assert.equal(log.ops.length, n0 + 1, 'drag = 1 op');
	assert.equal(log.ops.at(-1)!.coalesced, 30);
	assert.ok(log.ops.at(-1)!.validation.ok);
});

test('quick view: Save as plot group is one valid op', async () => {
	const { text, mesh, sol } = await solved('kirsch-exact');
	const log = await createOpLog(text, { registry: reg });
	const q = quickViewPatch({ data: log.data, mesh, sol }, { field: 'u', comp: -1, components: 2, axisym: false, step: 0, nSteps: 1, unit: 'mm', rule: 'robust', log: false, colormap: 'cividis', contours: true, levels: 14, wire: false })!;
	const op = await log.apply(q.patch, { actor: 'user' });
	assert.ok(op.validation.ok, op.validation.errors.join('; '));
	const g = (log.data as { results: { plots: Array<{ id: string; items: Array<{ type: string; expr: string }> }> } }).results.plots.at(-1)!;
	assert.equal(g.id, q.id);
	assert.equal(g.items[0]!.expr, 'sqrt(solid.u.x^2 + solid.u.y^2)');
	assert.deepEqual(g.items.map((i) => i.type), ['surface', 'contour']);
});

test('delete cascades to the nodes that read the node: one op, valid spec, undo byte-exact', async () => {
	const { text, mesh, sol } = await solved('kirsch-exact');
	const log = await createOpLog(text, { registry: reg });
	const ctx = (): PlotCtx => ({ data: log.data, mesh, sol, names: RESULT_NAMES });
	await log.apply(cutLinePatch(ctx(), [0, 0.005], [0, 0.05], 'solid.sxx')!.patch, { actor: 'user' });
	const before = log.text;
	const c = cascadeRemovePatch(log.data, '/results/datasets/1');
	assert.deepEqual(c.removed.sort(), ['cln1', 'lg1']); // the 1D group (no data of its own) stays, empty
	const op = await log.apply(c.patch, { actor: 'user' });
	assert.ok(op.validation.ok, op.validation.errors.join('; '));
	await log.undo({ actor: 'user' });
	assert.equal(log.text, before);
	const all = cascadeRemovePatch(log.data, '/results/datasets/0');
	const op2 = await log.apply(all.patch, { actor: 'user' });
	assert.ok(op2.validation.ok, op2.validation.errors.join('; '));
	assert.ok(all.removed.includes('sxx_map') && all.removed.includes('cln1'), all.removed.join(','));
});
