// SPDX-License-Identifier: GPL-3.0-or-later
// Unit test of deploy/worker.js with a mocked fetch (DevLog-017). Run: node --test deploy/
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from './worker.js';

const env = { PAGES_ORIGIN: 'https://applied-multiphysics.pages.dev' };
const ISO = {
	'cross-origin-opener-policy': 'same-origin',
	'cross-origin-embedder-policy': 'require-corp',
	'content-security-policy': "frame-ancestors 'self'",
	'cache-control': 'public, max-age=31536000, immutable'
};
/** @type {Array<{ url: string, init: RequestInit | undefined, input: unknown }>} */
let calls;
/** @type {(url: string) => Response} */
let reply;
const real = globalThis.fetch;

beforeEach(() => {
	calls = [];
	reply = () => new Response('ok', { status: 200, headers: ISO });
	globalThis.fetch = async (input, init) => {
		const url = input instanceof Request ? input.url : String(input);
		calls.push({ url, init, input });
		return reply(url);
	};
});
afterEach(() => { globalThis.fetch = real; });

test('/applied-multiphysics -> 301 to the trailing slash, query kept, no upstream call', async () => {
	const res = await worker.fetch(new Request('https://outside5sigma.com/applied-multiphysics?sim=kirsch-plate'), env);
	assert.equal(res.status, 301);
	assert.equal(res.headers.get('location'), 'https://outside5sigma.com/applied-multiphysics/?sim=kirsch-plate');
	assert.equal(calls.length, 0);
});

test('GET under the base: same path and query on PAGES_ORIGIN, headers intact', async () => {
	const res = await worker.fetch(new Request('https://outside5sigma.com/applied-multiphysics/play/kirsch-plate?solver=3d', { headers: { accept: 'text/html', 'x-forwarded-host': 'evil.example', 'if-none-match': '"abc"' } }), env);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, 'https://applied-multiphysics.pages.dev/applied-multiphysics/play/kirsch-plate?solver=3d');
	const h = new Headers(calls[0].init?.headers);
	assert.equal(h.get('accept'), 'text/html');
	assert.equal(h.get('if-none-match'), '"abc"');
	assert.equal(h.get('x-forwarded-host'), null);
	assert.equal(h.get('host'), null);
	assert.equal(calls[0].init?.method, 'GET');
	assert.equal(calls[0].init?.body, undefined);
	assert.equal(calls[0].init?.redirect, 'manual');
	assert.equal(res.status, 200);
	for (const [k, v] of Object.entries(ISO)) assert.equal(res.headers.get(k), v, k);
	assert.equal(await res.text(), 'ok');
});

test('POST passes method and body', async () => {
	await worker.fetch(new Request('https://outside5sigma.com/applied-multiphysics/x', { method: 'POST', body: 'payload', headers: { 'content-type': 'text/plain' } }), env);
	assert.equal(calls[0].init?.method, 'POST');
	assert.equal(await new Response(calls[0].init?.body).text(), 'payload');
	assert.equal(new Headers(calls[0].init?.headers).get('content-type'), 'text/plain');
});

test('upstream status passes through (404, 304)', async () => {
	reply = () => new Response('nope', { status: 404, headers: ISO });
	assert.equal((await worker.fetch(new Request('https://outside5sigma.com/applied-multiphysics/missing'), env)).status, 404);
	reply = () => new Response(null, { status: 304 });
	assert.equal((await worker.fetch(new Request('https://outside5sigma.com/applied-multiphysics/'), env)).status, 304);
});

test('a Pages redirect to the pages.dev host is rewritten to this host; others untouched', async () => {
	reply = () => new Response(null, { status: 308, headers: { location: 'https://applied-multiphysics.pages.dev/applied-multiphysics/play/kirsch-plate', ...ISO } });
	let res = await worker.fetch(new Request('https://outside5sigma.com/applied-multiphysics/play/kirsch-plate.html'), env);
	assert.equal(res.status, 308);
	assert.equal(res.headers.get('location'), 'https://outside5sigma.com/applied-multiphysics/play/kirsch-plate');
	assert.equal(res.headers.get('cross-origin-embedder-policy'), 'require-corp');
	reply = () => new Response(null, { status: 308, headers: { location: '/applied-multiphysics/play/kirsch-plate' } });
	res = await worker.fetch(new Request('https://outside5sigma.com/applied-multiphysics/play/kirsch-plate.html'), env);
	assert.equal(res.headers.get('location'), 'https://outside5sigma.com/applied-multiphysics/play/kirsch-plate');
	reply = () => new Response(null, { status: 302, headers: { location: 'https://example.org/' } });
	res = await worker.fetch(new Request('https://outside5sigma.com/applied-multiphysics/x'), env);
	assert.equal(res.headers.get('location'), 'https://example.org/');
});

test('other paths matched by the route glob go to the zone origin unchanged, never to Pages', async () => {
	const req = new Request('https://outside5sigma.com/applied-multiphysics-notes/post?a=1');
	await worker.fetch(req, env);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].input, req);
	assert.equal(calls[0].url, 'https://outside5sigma.com/applied-multiphysics-notes/post?a=1');
});

test('dot segments are resolved before the base check', async () => {
	// WHATWG URL parsing turns /applied-multiphysics/../x and /applied-multiphysics/%2e%2e/x into /x: not under the base
	for (const p of ['/applied-multiphysics/../etc', '/applied-multiphysics/%2e%2e/etc']) await worker.fetch(new Request('https://outside5sigma.com' + p), env);
	assert.deepEqual(calls.map((c) => c.url), ['https://outside5sigma.com/etc', 'https://outside5sigma.com/etc']);
});

test('a bad PAGES_ORIGIN fails closed', async () => {
	for (const o of [undefined, 'http://applied-multiphysics.pages.dev', 'https://applied-multiphysics.pages.dev/sub']) {
		const res = await worker.fetch(new Request('https://outside5sigma.com/applied-multiphysics/'), { PAGES_ORIGIN: o });
		assert.equal(res.status, 500);
	}
	assert.equal(calls.length, 0);
});
