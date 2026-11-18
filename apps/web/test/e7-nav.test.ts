// SPDX-License-Identifier: GPL-3.0-or-later
// Agent navigation host of the web app (state/nav.svelte.ts agentNavHost, DevLog-053): cancel, sweep point, probes,
// quick view and camera presets over a fake session, fake view hooks and a fake camera, plus the trail. nav.svelte.ts
// uses Svelte runes, so it is compiled with svelte/compiler (server output) as in nav-studies.test.ts. Expected values
// written out by hand.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { pathToFileURL } from 'node:url';
import { compileModule } from 'svelte/compiler';
import type { ProbeRow } from '../src/lib/post/probe.ts';

const lib = new URL('../src/lib/', import.meta.url);
const cache = new URL('../node_modules/.cache/amp-e7-test/', import.meta.url);
async function loadNav() {
	let js = stripTypeScriptTypes(readFileSync(new URL('state/nav.svelte.ts', lib), 'utf8'));
	js = js.replace(/from '\.\.\/engine\/protocol'/, `from '${new URL('engine/protocol.ts', lib).href}'`).replace(/from '\.\.\/gfx\/capture'/, `from '${new URL('gfx/capture.ts', lib).href}'`);
	const code = compileModule(js, { generate: 'server', filename: 'nav.svelte.js' }).js.code;
	mkdirSync(cache, { recursive: true });
	const f = new URL(`nav-${process.pid}.mjs`, cache);
	writeFileSync(f, code);
	return import(pathToFileURL(f.pathname).href) as Promise<typeof import('../src/lib/state/nav.svelte.ts')>;
}
after(() => rmSync(cache, { recursive: true, force: true }));

function fakeSession() {
	const calls: string[] = [];
	const s = {
		status: 'idle', acc: null as { status: string } | null, pointLoading: -1, active: 0,
		sweep: {
			studyId: 'par', innerId: 'std1', done: 2, axes: [{ param: 'D', unit: 'mm' }],
			points: [
				{ index: 0, label: 'D = 8 mm', values: { D: 8 }, status: 'solved', held: true },
				{ index: 1, label: 'D = 10 mm', values: { D: 10 }, status: 'solved', held: false },
				{ index: 2, label: 'D = 12 mm', values: { D: 12 }, status: 'cancelled', held: false }
			]
		} as { studyId: string; innerId: string; done: number; axes: Array<{ param: string; unit: string }>; points: Array<{ index: number; label: string; values: Record<string, number>; status: string; held: boolean }> } | null,
		cancel() { calls.push('cancel'); },
		selectPoint(i: number) { calls.push(`select ${i}`); s.active = i; }
	};
	return { s, calls };
}
const base = (calls: string[]) => ({
	focusNode: () => ({ ok: true }), openSettings: () => ({ ok: true }), highlightSelection: () => ({ ok: true }),
	setCamera: (r: { kind: string }) => (calls.push(`base camera ${r.kind}`), r.kind === 'fit' ? { ok: true } : { ok: false, message: `camera '${r.kind}' is not implemented` }),
	setViewMode: () => ({ ok: true }), screenshot: () => null
});

test('cancel: only when something runs; sweep listing and point selection', async () => {
	const N = await loadNav();
	const { s, calls } = fakeSession();
	const h = N.agentNavHost(base(calls), 'agent:t', { session: s, hooks: () => null });
	assert.deepEqual(await h.cancelRun!(), { ok: true, message: 'nothing was running' });
	s.status = 'solving';
	s.sweep!.points[2]!.status = 'solving';
	assert.deepEqual(await h.cancelRun!(), { ok: true, message: 'cancelled: solve, sweep' });
	assert.deepEqual(calls, ['cancel']);
	s.sweep!.points[2]!.status = 'cancelled';
	const sw = h.sweep!()!;
	assert.deepEqual({ study: sw.study, inner: sw.inner, done: sw.done, total: sw.total, shown: sw.shown }, { study: 'par', inner: 'std1', done: 2, total: 3, shown: 0 });
	assert.deepEqual(sw.points[1], { index: 1, label: 'D = 10 mm', status: 'solved', shown: false, selectable: true, values: { D: { value: 10, unit: 'mm' } } });
	assert.equal(sw.points[2]!.selectable, false);
	assert.deepEqual(await h.selectSweepPoint!(1), { ok: true });
	assert.equal(s.active, 1);
	assert.deepEqual(await h.selectSweepPoint!(2), { ok: false, message: 'point 2 is cancelled' });
	assert.deepEqual(await h.selectSweepPoint!(9), { ok: false, message: 'no sweep point 9' });
	s.sweep = null;
	assert.equal(h.sweep!(), null);
	const tail = N.navTrail.entries.slice(-5).map((e) => `${e.actor} ${e.tool}:${e.ok}`);
	assert.deepEqual(tail, ['agent:t cancel_run:true', 'agent:t cancel_run:true', 'agent:t select_sweep_point:true', 'agent:t select_sweep_point:false', 'agent:t select_sweep_point:false']);
});

test('probes and quick view go to the registered graphics view; none registered: refused', async () => {
	const N = await loadNav();
	const { s, calls } = fakeSession();
	const h = N.agentNavHost(base(calls), 'agent:t', { session: s });
	assert.deepEqual(await h.probeAdd!([0, 0, 0]), { ok: false, message: 'no results view with a drawn field is open' });
	assert.equal(h.probeList!(), null);
	assert.equal(h.quickView!(), null);
	let rows: ProbeRow[] = [];
	const row = (n: number, p: [number, number, number], dim: 2 | 3): ProbeRow => ({ n, ts: '2026-11-18T00:00:00Z', dim, p, lu: { unit: 'mm', f: 1000 }, field: 'T', value: 300 + n, unit: 'K', dataset: '', point: -1, run: 'r', key: 'k' });
	let qv = { field: 'T', fields: ['T', 'q'], component: null, components: [], colormap: 'auto', colormaps: ['viridis'], range: 'full' as const, log: false, logAvailable: false, contours: false, wire: false, plotGroup: null };
	const off = N.registerViewHooks({
		probes: { get rows() { return rows; }, remove: (n) => { rows = rows.filter((r) => r.n !== n); }, clear: () => { rows = []; } },
		probeAt: async (p) => (p[0] > 1 ? { row: null, message: 'outside the view' } : (rows = [...rows, row(rows.length + 1, p, p[2] === 0 ? 2 : 3)], { row: rows.at(-1)! })),
		quickView: () => ({ ...qv }),
		setQuickView: (patch) => (patch.field && !qv.fields.includes(patch.field) ? { ok: false, message: `no field ${patch.field}` } : ((qv = { ...qv, ...patch } as typeof qv), { ok: true }))
	});
	assert.deepEqual(await h.probeAdd!([0.001, 0.002, 0]), { ok: true, probe: { n: 1, at_m: [0.001, 0.002], field: 'T', value: 301, unit: 'K', dataset: '' } });
	assert.deepEqual((await h.probeAdd!([0.001, 0.002, 0.003])).probe?.at_m, [0.001, 0.002, 0.003]);
	assert.deepEqual(await h.probeAdd!([2, 0, 0]), { ok: false, message: 'outside the view' });
	assert.deepEqual(h.probeList!()!.map((p) => p.n), [1, 2]);
	assert.deepEqual(h.probeRemove!(5), { ok: false, message: 'no probe 5' });
	assert.deepEqual(h.probeRemove!(1), { ok: true });
	assert.deepEqual(h.probeList!()!.map((p) => p.n), [2]);
	assert.deepEqual(h.probeRemove!('all'), { ok: true });
	assert.deepEqual(h.probeList!(), []);
	assert.deepEqual(await h.setQuickView!({ field: 'q', range: 'p1-99' }), { ok: true });
	assert.deepEqual({ f: h.quickView!()!.field, r: h.quickView!()!.range }, { f: 'q', r: 'p1-99' });
	assert.deepEqual(await h.setQuickView!({ field: 'nope' }), { ok: false, message: 'no field nope' });
	off();
	assert.equal(h.quickView!(), null);
});

test('camera: fit and every request without the camera module go to the view host; presets and look_at to the camera', async () => {
	const N = await loadNav();
	const { s, calls } = fakeSession();
	const plain = N.agentNavHost(base(calls), 'agent:t', { session: s, camera: null });
	assert.deepEqual(await plain.setCamera({ kind: 'preset', preset: 'top' }), { ok: false, message: "camera 'preset' is not implemented" });
	const cam: Array<[string, unknown]> = [];
	let has3d = true;
	const h = N.agentNavHost(base(calls), 'agent:t', { session: s, camera: (p, at) => (cam.push([p, at]), has3d) });
	assert.deepEqual(await h.setCamera({ kind: 'fit' }), { ok: true });
	assert.deepEqual(await h.setCamera({ kind: 'preset', preset: 'top' }), { ok: true });
	assert.deepEqual(await h.setCamera({ kind: 'look_at', target: [0, 0, 1e-3] }), { ok: true });
	assert.deepEqual(await h.setCamera({ kind: 'look_at', target: [1, 2, 3], preset: 'left', distance: 0.1 }), { ok: true, message: 'distance is not applied (the view keeps its zoom)' });
	has3d = false;
	assert.deepEqual(await h.setCamera({ kind: 'preset', preset: 'iso' }), { ok: false, message: 'camera presets act on the 3D view; no 3D view is shown' });
	assert.deepEqual(cam, [['top', undefined], ['iso', [0, 0, 1e-3]], ['left', [1, 2, 3]], ['iso', undefined]]);
	assert.deepEqual(calls, ['base camera preset', 'base camera fit']);
});

test('no session (a view without one): parity session methods absent', async () => {
	const N = await loadNav();
	const h = N.agentNavHost(base([]), 'agent:t', { session: null });
	assert.equal(h.cancelRun, undefined);
	assert.equal(h.sweep, undefined);
	assert.equal(typeof h.probeAdd, 'function');
});
