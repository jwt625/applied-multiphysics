// SPDX-License-Identifier: GPL-3.0-or-later
// Study scope of a run (results/api.ts runStudies, paramsOf; study picker, DevLog-040) and the shared nav-host factory
// (state/nav.svelte.ts makeNavHost, resolvePointer). nav.svelte.ts uses Svelte runes, so the test compiles it with
// svelte/compiler (server output: `$state` becomes a plain field) into node_modules/.cache and imports the result; the
// factory logic is the same code. Expected values written out by hand (lane T1, DevLog-038).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { pathToFileURL } from 'node:url';
import { compileModule } from 'svelte/compiler';
import type { Solution } from '@amp/spec/types';
import { runStudies, paramsOf } from '../src/lib/results/api.ts';

const lib = new URL('../src/lib/', import.meta.url);
const cache = new URL('../node_modules/.cache/amp-t1-test/', import.meta.url);
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

test('runStudies: first study by default; the solved study when given; unknown ids fall back to the first', () => {
	const two = { studies: [{ id: 's1', type: 'stationary' }, { id: 's2', type: 'eigenfrequency' }] };
	assert.deepEqual(runStudies(two), ['s1']);
	assert.deepEqual(runStudies(two, 's2'), ['s2']);
	assert.deepEqual(runStudies(two, null), ['s1']);
	assert.deepEqual(runStudies(two, 'nope'), ['s1']);
	assert.deepEqual(runStudies({}), []);
	assert.deepEqual(runStudies(null), []);
	assert.deepEqual(runStudies({ studies: [{ type: 'stationary' }] }), [], 'a study without a string id answers for nothing');
});

test('runStudies: a parametric study includes its inner study; parametric studies sweeping the solved study are included', () => {
	const par = { studies: [{ id: 'p', type: 'parametric', settings: { study: 's1' } }, { id: 's1', type: 'stationary' }, { id: 'p2', type: 'parametric', settings: { study: 's1' } }, { id: 's3', type: 'stationary' }] };
	assert.deepEqual(runStudies(par), ['p', 's1', 'p2']);
	assert.deepEqual(runStudies(par, 's1'), ['s1', 'p', 'p2']);
	assert.deepEqual(runStudies(par, 's3'), ['s3']);
	assert.deepEqual(runStudies(par, 'p2'), ['p2', 's1', 'p']);
});

test('paramsOf: the params first seen with a solution object are kept (snapshot), a new solution takes the current ones', () => {
	const a = { run: {} } as unknown as Solution, b = { run: {} } as unknown as Solution;
	const p1 = new Map([['L', { si: 1, dim: [1, 0, 0, 0, 0] }]]), p2 = new Map([['L', { si: 2, dim: [1, 0, 0, 0, 0] }]]);
	assert.equal(paramsOf(a, p1).get('L')!.si, 1);
	assert.equal(paramsOf(a, p2).get('L')!.si, 1, 'same solution: the snapshot');
	assert.equal(paramsOf(b, p2).get('L')!.si, 2);
	p1.set('L', { si: 9, dim: [1, 0, 0, 0, 0] });
	assert.equal(paramsOf(a, p2).get('L')!.si, 1, 'the snapshot is a copy');
});

test('makeNavHost: implemented methods answer from the view, missing ones with the view message; every call recorded', async () => {
	const { makeNavHost, navTrail } = await loadNav();
	const seen: unknown[] = [];
	const host = makeNavHost('agent:t1', {
		setViewMode: (m) => { seen.push(['mode', m]); return { ok: true }; },
		focusNode: (p) => { seen.push(['focus', p]); return { ok: false, message: 'no such node' }; }
	}, (tool) => `${tool}: not available in this view`);
	const n0 = navTrail.entries.length;
	assert.deepEqual(host.setViewMode('mesh'), { ok: true });
	assert.deepEqual(host.focusNode('/params'), { ok: false, message: 'no such node' });
	assert.deepEqual(host.openSettings('/params', 'L'), { ok: false, message: 'open_settings: not available in this view' });
	assert.deepEqual(host.highlightSelection(['dom:a'], 'red'), { ok: false, message: 'highlight_selection: not available in this view' });
	assert.deepEqual(host.setCamera({ kind: 'fit' } as never), { ok: false, message: 'set_camera: not available in this view' });
	assert.equal(host.showPlot, undefined, 'no showPlot unless the view implements it');
	// no graphics registered in Node: the screenshot is null and recorded as failed
	assert.equal(await host.screenshot(), null);
	assert.deepEqual(seen, [['mode', 'mesh'], ['focus', '/params']]);
	const rows = navTrail.entries.slice(n0).map((e) => ({ seq: e.seq - n0, actor: e.actor, tool: e.tool, args: e.args, ok: e.ok, message: e.message }));
	assert.deepEqual(rows, [
		{ seq: 1, actor: 'agent:t1', tool: 'set_view_mode', args: { mode: 'mesh' }, ok: true, message: undefined },
		{ seq: 2, actor: 'agent:t1', tool: 'focus_node', args: { pointer: '/params' }, ok: false, message: 'no such node' },
		{ seq: 3, actor: 'agent:t1', tool: 'open_settings', args: { pointer: '/params', field: 'L' }, ok: false, message: 'open_settings: not available in this view' },
		{ seq: 4, actor: 'agent:t1', tool: 'highlight_selection', args: { ids: ['dom:a'] }, ok: false, message: 'highlight_selection: not available in this view' },
		{ seq: 5, actor: 'agent:t1', tool: 'set_camera', args: { kind: 'fit' }, ok: false, message: 'set_camera: not available in this view' },
		{ seq: 6, actor: 'agent:t1', tool: 'screenshot', args: { view: 'graphics' }, ok: false, message: 'graphics canvas not available' }
	]);
	assert.ok(navTrail.entries.slice(n0).every((e) => /^\d{4}-\d{2}-\d{2}T/.test(e.ts)), 'ISO timestamps');
	// a view with showPlot: the call goes through and is recorded as show_plot
	const h2 = makeNavHost('user', { showPlot: (id) => ({ ok: id === 'T_map', ...(id === 'T_map' ? {} : { message: `no plot ${id}` }) }) }, () => 'n/a');
	assert.deepEqual(h2.showPlot!('T_map'), { ok: true });
	assert.deepEqual(h2.showPlot!('x'), { ok: false, message: 'no plot x' });
	assert.deepEqual(navTrail.entries.slice(-2).map((e) => [e.actor, e.tool, e.args, e.ok]), [['user', 'show_plot', { plot: 'T_map' }, true], ['user', 'show_plot', { plot: 'x' }, false]]);
});

test('resolvePointer: @id tokens to indices, escapes kept, missing paths null', async () => {
	const { resolvePointer } = await loadNav();
	const data = { studies: [{ id: 'a' }, { id: 'b' }], 'x/y': { z: 1 } };
	assert.equal(resolvePointer(data, '/studies/@b'), '/studies/1');
	assert.equal(resolvePointer(data, '/studies/0/id'), '/studies/0/id');
	assert.equal(resolvePointer(data, '/studies/@c'), null);
	assert.equal(resolvePointer(data, '/studies/5'), null);
	assert.equal(resolvePointer(data, '/x~1y/z'), '/x~1y/z');
	assert.equal(resolvePointer(data, '/nope'), null);
	assert.equal(resolvePointer(data, ''), '');
	assert.equal(resolvePointer(data, '/'), '');
});
