// SPDX-License-Identifier: GPL-3.0-or-later
// Provider choice of the agent panel (lib/agent/providers.ts, DevLog-053): stored choice, custom base URL rules,
// CSP connect-src parsing and source matching, and the build CSP kept in step in vite.config.ts, static/_headers and
// BUILD_CONNECT_SRC. Expected values written out by hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BUILD_CONNECT_SRC, PROVIDER_STORAGE, choiceProblem, connectAllowed, connectSrcOf, endpointOf, loadChoice, normalizeBaseURL, pageConnectSrc, saveChoice } from '../src/lib/agent/providers.ts';

const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m }; };

test('choice: default anthropic, round trip, bad values ignored, blocked storage tolerated', () => {
	const s = mem();
	assert.deepEqual(loadChoice(s), { id: 'anthropic' });
	saveChoice(s, { id: 'deepseek', model: 'deepseek-v4-pro' });
	assert.equal(s.m.get(PROVIDER_STORAGE), '{"id":"deepseek","model":"deepseek-v4-pro"}');
	assert.deepEqual(loadChoice(s), { id: 'deepseek', model: 'deepseek-v4-pro' });
	s.setItem(PROVIDER_STORAGE, '{"id":"evil","baseURL":"x"}');
	assert.deepEqual(loadChoice(s), { id: 'anthropic' });
	s.setItem(PROVIDER_STORAGE, 'not json');
	assert.deepEqual(loadChoice(s), { id: 'anthropic' });
	const blocked = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
	assert.deepEqual(loadChoice(blocked), { id: 'anthropic' });
	saveChoice(blocked, { id: 'custom' });
	assert.deepEqual(loadChoice(null), { id: 'anthropic' });
});

test('custom base URL: https only, no credentials, query or fragment; trailing slash removed', () => {
	assert.deepEqual(normalizeBaseURL(' https://api.example.com/v1/ '), { ok: true, url: 'https://api.example.com/v1', origin: 'https://api.example.com' });
	assert.deepEqual(normalizeBaseURL('https://h.example:8443'), { ok: true, url: 'https://h.example:8443', origin: 'https://h.example:8443' });
	assert.equal(normalizeBaseURL('http://api.example.com/v1').ok, false);
	assert.equal(normalizeBaseURL('https://u:p@api.example.com').ok, false);
	assert.equal(normalizeBaseURL('https://api.example.com/v1?x=1').ok, false);
	assert.equal(normalizeBaseURL('https://api.example.com/#a').ok, false);
	assert.equal(normalizeBaseURL('api.example.com').ok, false);
	assert.equal(endpointOf({ id: 'deepseek' }), 'https://api.deepseek.com/chat/completions');
	assert.equal(endpointOf({ id: 'anthropic' }), 'https://api.anthropic.com/v1/messages');
	assert.equal(endpointOf({ id: 'custom', baseURL: 'https://api.example.com/v1/' }), 'https://api.example.com/v1/chat/completions');
	assert.equal(endpointOf({ id: 'custom' }), null);
});

test('connect-src parsing and source matching', () => {
	assert.deepEqual(connectSrcOf("default-src 'self'; connect-src 'self' https://api.anthropic.com https://api.deepseek.com; worker-src 'self'"), ["'self'", 'https://api.anthropic.com', 'https://api.deepseek.com']);
	assert.equal(connectSrcOf("default-src 'self'"), null);
	const self = 'https://app.example.org';
	const src = [...BUILD_CONNECT_SRC];
	assert.equal(connectAllowed('https://api.deepseek.com/chat/completions', src, self), true);
	assert.equal(connectAllowed('https://api.anthropic.com/v1/messages', src, self), true);
	assert.equal(connectAllowed('https://app.example.org/x', src, self), true);
	assert.equal(connectAllowed('https://api.openai.com/v1/chat/completions', src, self), false);
	assert.equal(connectAllowed('https://api.deepseek.com.evil.example/chat/completions', src, self), false);
	assert.equal(connectAllowed('http://api.deepseek.com/chat/completions', src, self), false);
	assert.equal(connectAllowed('https://api.deepseek.com:8443/chat/completions', src, self), false);
	assert.equal(connectAllowed('https://a.b.example.com/v1', ['https://*.example.com'], self), true);
	assert.equal(connectAllowed('https://example.com/v1', ['https://*.example.com'], self), false);
	assert.equal(connectAllowed('https://h.example.com/v1/chat/completions', ['https://h.example.com/v1/'], self), true);
	assert.equal(connectAllowed('https://h.example.com/v2/chat/completions', ['https://h.example.com/v1/'], self), false);
	assert.equal(connectAllowed('https://h.example.com/x', ['https:'], self), true);
	assert.equal(connectAllowed('https://h.example.com/x', ["'none'"], self), false);
	assert.equal(connectAllowed('https://h.example.com/x', ['h.example.com'], self), true);
});

test('choiceProblem: presets always mountable; custom needs URL, model and a CSP-allowed origin', () => {
	const self = 'https://app.example.org';
	const src = [...BUILD_CONNECT_SRC];
	assert.equal(choiceProblem({ id: 'anthropic' }, src, self), null);
	assert.equal(choiceProblem({ id: 'deepseek' }, src, self), null);
	assert.equal(choiceProblem({ id: 'custom' }, src, self), 'set a base URL');
	assert.equal(choiceProblem({ id: 'custom', baseURL: 'http://x.example' }, src, self), 'base URL: https only (the key travels in a header)');
	assert.equal(choiceProblem({ id: 'custom', baseURL: 'https://x.example' }, src, self), 'set a model id');
	assert.match(choiceProblem({ id: 'custom', baseURL: 'https://x.example/v1', model: 'm' }, src, self) ?? '', /^https:\/\/x\.example is not allowed by this page's Content-Security-Policy/);
	assert.equal(choiceProblem({ id: 'custom', baseURL: 'https://x.example/v1', model: 'm' }, [...src, 'https://x.example'], self), null);
});

test('page CSP: meta tag first, build list as fallback', () => {
	const doc = (content: string | null) => ({ querySelector: () => (content === null ? null : { getAttribute: () => content }) }) as unknown as Pick<Document, 'querySelector'>;
	assert.deepEqual(pageConnectSrc(doc("connect-src 'self' https://x.example")), { sources: ["'self'", 'https://x.example'], from: 'meta' });
	assert.deepEqual(pageConnectSrc(doc(null)), { sources: [...BUILD_CONNECT_SRC], from: 'build' });
	assert.deepEqual(pageConnectSrc(null), { sources: [...BUILD_CONNECT_SRC], from: 'build' });
});

test('build CSP connect-src is the same in vite.config.ts, static/_headers and BUILD_CONNECT_SRC (preset hosts only)', () => {
	assert.deepEqual([...BUILD_CONNECT_SRC], ["'self'", 'https://api.anthropic.com', 'https://api.deepseek.com']);
	const vite = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8');
	const m = /'connect-src': \[([^\]]*)\]/.exec(vite);
	assert.ok(m);
	assert.deepEqual(m[1]!.split(',').map((x) => x.trim().replace(/^'|'$/g, '')), ['self', 'https://api.anthropic.com', 'https://api.deepseek.com']);
	const headers = readFileSync(new URL('../static/_headers', import.meta.url), 'utf8');
	const lines = headers.split('\n').filter((l) => l.includes('connect-src'));
	assert.equal(lines.length, 1);
	assert.deepEqual(connectSrcOf(lines[0]!.replace(/^\s*Content-Security-Policy:\s*/, '')), [...BUILD_CONNECT_SRC]);
});
