// SPDX-License-Identifier: GPL-3.0-or-later
// Base-path verification (DevLog-017): serves build/ (made with BASE_PATH, and VITE_AMP_HOOKS=1 for the solve check) with
// deploy/serve.mjs (Cloudflare Pages _headers / _redirects semantics) on a free uncommon port, then checks:
// redirects and headers over HTTP; the CSP <meta> hashes against every inline script; in headless Chromium the
// workbench and two Play views: no failed or >= 400 requests, crossOriginIsolated, service worker scope = base,
// SW cache keys under the base, internal links under the base, a solve (Play), and a reload served by the SW.
// Results to logs/D1-base-check-<ts>.json, one PNG per view to <outDir>.
// Usage: BASE_PATH=/applied-multiphysics node scripts/base-check.ts <outDir> [port]
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright-core';
import { createPagesServer } from '../../../deploy/serve.mjs';

const BASE = process.env.BASE_PATH ?? '/applied-multiphysics';
const out = process.argv[2] ?? 'shots';
const port = Number(process.argv[3] ?? 47417);
const build = new URL('../build/', import.meta.url).pathname;
const logs = new URL('../../../logs/', import.meta.url).pathname;
const ts = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
const SHELL = `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell`;

try { execSync(`lsof -iTCP:${port} -sTCP:LISTEN -n -P`, { stdio: 'pipe' }); console.error(`port ${port} busy`); process.exit(2); } catch { /* free */ }
const server = createPagesServer(build);
await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
const origin = `http://127.0.0.1:${port}`;
await mkdir(out, { recursive: true });

const checks: Array<{ name: string; ok: boolean; detail?: unknown }> = [];
const check = (name: string, ok: boolean, detail?: unknown) => { checks.push({ name, ok, detail }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : ' ' + JSON.stringify(detail)}`); };
const get = async (p: string) => { const r = await fetch(origin + p, { redirect: 'manual' }); return { status: r.status, h: r.headers, body: await r.text() }; };

// ---- HTTP: redirects and headers
{
	const root = await get('/');
	check('/ -> 302 base/', root.status === 302 && root.h.get('location') === `${BASE}/`, { status: root.status, location: root.h.get('location') });
	const bare = await get(BASE);
	check('base without slash -> redirect to base/ (Pages; the Worker answers 301 first)', [301, 308].includes(bare.status) && bare.h.get('location') === `${BASE}/`, { status: bare.status, location: bare.h.get('location') });
	const page = await get(`${BASE}/`);
	const iso = { coop: page.h.get('cross-origin-opener-policy'), coep: page.h.get('cross-origin-embedder-policy'), corp: page.h.get('cross-origin-resource-policy'), csp: page.h.get('content-security-policy') };
	check('base/ 200 with COOP/COEP/CORP and frame-ancestors', page.status === 200 && iso.coop === 'same-origin' && iso.coep === 'require-corp' && iso.corp === 'same-origin' && !!iso.csp?.includes("frame-ancestors 'none'"), iso);
	const js = /(\/[^"]*\/_app\/immutable\/[^"]+\.js)"/.exec(page.body)?.[1] ?? '';
	const a = await get(js);
	const cc = a.h.get('cache-control') ?? '';
	const csp = a.h.get('content-security-policy') ?? '';
	check('immutable JS under base: immutable cache, _app CSP (connect-src anthropic, wasm-unsafe-eval), COEP', js.startsWith(`${BASE}/_app/immutable/`) && a.status === 200 && cc.includes('immutable') && csp.includes("connect-src 'self' https://api.anthropic.com") && csp.includes("'wasm-unsafe-eval'") && a.h.get('cross-origin-embedder-policy') === 'require-corp', { js, cc, csp });
	const sw = await get(`${BASE}/service-worker.js`);
	check('service-worker.js no-cache', sw.status === 200 && sw.h.get('cache-control') === 'no-cache', sw.h.get('cache-control'));
	const old = await get('/_app/version.json');
	check('nothing served outside the base', old.status === 404 && (await get('/play/kirsch-plate')).status === 404);
}

// ---- CSP meta hash vs inline scripts, every prerendered page
{
	const site = join(build, BASE.slice(1));
	const pages: string[] = [];
	const walk = async (d: string) => { for (const e of await readdir(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory() && e.name !== '_app') await walk(p); else if (e.name.endsWith('.html')) pages.push(p); } };
	await walk(site);
	const bad: string[] = [];
	for (const f of pages) {
		const html = await readFile(f, 'utf8');
		const meta = /<meta http-equiv="content-security-policy" content="([^"]+)"/i.exec(html)?.[1] ?? '';
		const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
		const hashes = scripts.map((s) => `'sha256-${createHash('sha256').update(s).digest('base64')}'`);
		if (!meta || !scripts.length || hashes.some((h) => !meta.includes(h))) bad.push(f.slice(site.length));
	}
	check(`CSP meta hash matches the inline bootstrap (${pages.length} pages)`, pages.length >= 10 && bad.length === 0, bad);
}

// ---- browser
const shell = await chromium.launch({ executablePath: SHELL, headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const ctx = await shell.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, serviceWorkers: 'allow' });
const views: Array<{ path: string; hook: '__ampWorkbench' | '__ampPlay'; tag: string }> = [
	{ path: `${BASE}/workbench`, hook: '__ampWorkbench', tag: 'workbench' },
	{ path: `${BASE}/play/kirsch-plate`, hook: '__ampPlay', tag: 'kirsch-plate' },
	{ path: `${BASE}/play/heat-plate-fin`, hook: '__ampPlay', tag: 'heat-plate-fin' }
];
const result: Record<string, unknown> = { ts, origin, base: BASE, browser: shell.version(), views: {} };
const errors: string[] = [];

async function state(p: Page, hook: string) {
	return p.evaluate(async (h) => {
		const s = (window as unknown as Record<string, { session?: { status?: string; fresh?: boolean; error?: string; solution?: { stats?: { dof?: number; solver?: string } } | null; meshInfo?: { cells?: number } | null } }>)[h]?.session;
		const reg = await Promise.race([navigator.serviceWorker.ready, new Promise<null>((r) => setTimeout(() => r(null), 10000))]);
		const keys: string[] = [];
		for (const k of await caches.keys()) for (const r of await (await caches.open(k)).keys()) keys.push(r.url);
		const links = [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')!).filter((h) => !/^(https?:|#|\?|mailto:)/.test(h));
		return { coi: crossOriginIsolated, scope: reg?.scope ?? null, controller: navigator.serviceWorker.controller?.scriptURL ?? null, cacheNames: await caches.keys(), keys, links, status: s?.status ?? null, fresh: s?.fresh ?? null, error: s?.error ?? null, dof: s?.solution?.stats?.dof ?? null, solver: s?.solution?.stats?.solver ?? null, cells: s?.meshInfo?.cells ?? null };
	}, hook);
}

for (const v of views) {
	const p = await ctx.newPage();
	const bad: string[] = [];
	p.on('response', (r) => { if (r.status() >= 400) bad.push(`${r.status()} ${r.url()}`); });
	p.on('requestfailed', (r) => bad.push(`failed ${r.url()} ${r.failure()?.errorText ?? ''}`));
	p.on('pageerror', (e) => errors.push(`${v.tag}: ${e.message}`));
	p.on('console', (m) => { if (m.type() === 'error') errors.push(`${v.tag}: console ${m.text()}`); });
	await p.goto(origin + v.path, { waitUntil: 'load' });
	await p.waitForFunction((h) => { const s = (window as unknown as Record<string, { session?: { status?: string; fresh?: boolean; meshInfo?: unknown } }>)[h]?.session; return !!s && (h === '__ampWorkbench' ? !!s.meshInfo || s.status === 'error' : ['solved', 'unavailable', 'error'].includes(s.status ?? '') && (s.status !== 'solved' || !!s.fresh)); }, v.hook, { timeout: 90000 });
	await p.waitForTimeout(500);
	const first = await state(p, v.hook);
	await p.screenshot({ path: join(out, `D1-base-${v.tag}-${ts}.png`) });
	// second load: served by the service worker (controller set after clients.claim)
	await p.reload({ waitUntil: 'load' });
	await p.waitForFunction((h) => !!(window as unknown as Record<string, { session?: { meshInfo?: unknown } }>)[h]?.session?.meshInfo, v.hook, { timeout: 90000 });
	const second = await p.evaluate(() => ({ coi: crossOriginIsolated, controller: navigator.serviceWorker.controller?.scriptURL ?? null }));
	(result.views as Record<string, unknown>)[v.tag] = { first, second, bad };
	check(`${v.tag}: no failed or >= 400 requests`, bad.length === 0, bad.slice(0, 5));
	check(`${v.tag}: crossOriginIsolated (first load, SW reload)`, first.coi === true && second.coi === true, { first: first.coi, second: second.coi });
	check(`${v.tag}: SW scope ${BASE}/`, first.scope === `${origin}${BASE}/` && second.controller === `${origin}${BASE}/service-worker.js`, { scope: first.scope, controller: second.controller });
	check(`${v.tag}: SW cache keys under the base`, first.keys.length > 0 && first.keys.every((k) => k.startsWith(`${origin}${BASE}/`)), { n: first.keys.length, outside: first.keys.filter((k) => !k.startsWith(`${origin}${BASE}/`)).slice(0, 3) });
	check(`${v.tag}: internal links under the base`, first.links.every((h) => h.startsWith(`${BASE}/`)), first.links.filter((h) => !h.startsWith(`${BASE}/`)));
	if (v.hook === '__ampPlay') check(`${v.tag}: solve`, first.status === 'solved' && first.fresh === true && (first.dof ?? 0) > 0, { status: first.status, dof: first.dof, solver: first.solver, error: first.error });
	else check(`${v.tag}: mesh`, (first.cells ?? 0) > 0, { status: first.status, cells: first.cells });
	await p.close();
}
check('no page errors', errors.length === 0, errors.slice(0, 5));

await shell.close();
server.close();
result.checks = checks;
result.errors = errors;
const file = join(logs, `D1-base-check-${ts}.json`);
await writeFile(file, JSON.stringify(result, null, 1));
const failed = checks.filter((c) => !c.ok).length;
console.log(`${checks.length - failed}/${checks.length} checks ok; ${file}`);
process.exit(failed ? 1 : 0);
