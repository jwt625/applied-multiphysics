// SPDX-License-Identifier: GPL-3.0-or-later
// View state in the link (gfx/view-link.ts, DevLog-052): encode / decode round trip, invalid input, hash handling.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { currentViewCode, decodeView, encodeView, registerViewState, viewCodeOf, withView, withViewCode, type ViewState } from '../src/lib/gfx/view-link.ts';

test('round trip of every key', () => {
	const v: ViewState = { mode: 'results', field: 'w.Ez', part: 'inst', comp: -1, step: 3, phase: 1.23457, cm: 'twilight', reverse: true, rule: 'robust', log: false, axes: 'scale', cam: { pos: [1.5e-6, -2, 3.25], target: [0, 0.5, -1e-3] } };
	assert.deepEqual(decodeView(encodeView(v)), v);
	assert.deepEqual(decodeView(encodeView({ cam: 'top', cm: 'auto' })), { cam: 'top', cm: 'auto' });
	assert.deepEqual(decodeView(encodeView({})), {});
});

test('the code is URL-safe and survives the hash next to the model code', () => {
	const code = encodeView({ field: 'es_oc.V', cam: { pos: [1, 2, 3], target: [0, 0, 0] } });
	assert.ok(/^[A-Za-z0-9%._~-]+$/.test(code), code);
	const url = withView('https://x.test/workbench?sim=a#d=ABC', code);
	assert.equal(url, `https://x.test/workbench?sim=a#d=ABC&v=${code}`);
	assert.equal(viewCodeOf(url.slice(url.indexOf('#'))), code);
	assert.equal(withView(url, encodeView({ step: 1 })), `https://x.test/workbench?sim=a#d=ABC&v=${encodeView({ step: 1 })}`);
	assert.equal(withView('https://x.test/w?sim=a', ''), 'https://x.test/w?sim=a');
	assert.equal(viewCodeOf('#v=s%3A2'), 's%3A2');
});

test('unknown keys and invalid values are dropped', () => {
	const v = decodeView(encodeURIComponent('m:plot~f:1bad~p:nope~c:2.5~s:-1~cm:jet~rv:yes~r:robust~zz:1~cam:1_2_3~ax:axes'));
	assert.deepEqual(v, { rule: 'robust', axes: 'axes' });
	assert.deepEqual(decodeView('%E0%A4%A'), {});
});

test('registry: the mounted view answers, an unmounted one does not', () => {
	assert.equal(currentViewCode(), '');
	const off = registerViewState(() => ({ step: 2 }));
	assert.equal(decodeView(currentViewCode()).step, 2);
	assert.ok(withViewCode('u?sim=a').startsWith('u?sim=a#v='));
	off();
	assert.equal(currentViewCode(), '');
});
