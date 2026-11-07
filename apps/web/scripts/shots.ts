// SPDX-License-Identifier: GPL-3.0-or-later
// Verification run (DevLog-011 s.1.9): serves build/ with the _headers COOP/COEP on a free uncommon port, then drives
// headless Chromium (playwright-core): screenshots of the workbench and every Play view at 1440x900 and 390x844,
// first paint (FCP), tab and mode switch times, a UI op-log round trip (20 form edits, 20 undos), Play slider and
// canvas-handle drags (coalesced ops, drag re-mesh time). Results to logs/L5-shots-<ts>.json, PNGs to <out>.
// Usage: node scripts/shots.ts <outDir> [port]
import { createServer } from 'node:http';
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { extname, join, normalize } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';

const out = process.argv[2] ?? 'shots';
const port = Number(process.argv[3] ?? 47391);
const root = new URL('../build/', import.meta.url).pathname;
const ts = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
const SHELL = `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell`;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

try { execSync(`lsof -iTCP:${port} -sTCP:LISTEN -n -P`, { stdio: 'pipe' }); console.error(`port ${port} busy`); process.exit(2); } catch { /* free */ }

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm' };
const HEAD = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cross-Origin-Resource-Policy': 'same-origin' };
const file = async (p: string) => { try { return (await stat(p)).isFile() ? p : null; } catch { return null; } };
const server = createServer(async (req, res) => {
	const url = new URL(req.url ?? '/', 'http://x');
	const base = join(root, normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, ''));
	const hit = (await file(base)) ?? (await file(base + '.html')) ?? (await file(join(base, 'index.html')));
	if (!hit) { res.writeHead(404, HEAD); res.end(); return; }
	res.writeHead(200, { ...HEAD, 'Content-Type': TYPES[extname(hit)] ?? 'application/octet-stream', 'Cache-Control': hit.includes('/_app/immutable/') ? 'public, max-age=31536000, immutable' : 'no-cache' });
	res.end(await readFile(hit));
});
await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
const origin = `http://127.0.0.1:${port}`;
await mkdir(out, { recursive: true });

const SIMS = ['kirsch-plate', 'heat-plate-fin', 'helmholtz-coil', 'si-rib-waveguide', 'cylinder-cavity', 'box-acoustics'];
const RT = ['lbm-d2q9', 'fdtd-tmz', 'gray-scott'];
const VIEWS = [{ w: 1440, h: 900, tag: '1440' }, { w: 390, h: 844, tag: '390' }];
const result: Record<string, unknown> = { ts, origin, browser: {} };
const errors: string[] = [];

const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] ?? NaN; };

async function newPage(b: Browser, w: number, h: number): Promise<Page> {
	const ctx = await b.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, serviceWorkers: 'block' });
	const p = await ctx.newPage();
	p.on('pageerror', (e) => errors.push(`${p.url()}: ${e.message}`));
	p.on('console', (m) => { if (m.type() === 'error') errors.push(`${p.url()}: console ${m.text()}`); });
	return p;
}
async function ready(p: Page, kind: 'wb' | 'play') {
	const hook = kind === 'wb' ? '__ampWorkbench' : '__ampPlay';
	await p.waitForFunction((h) => { const s = (window as unknown as Record<string, { session?: { meshInfo?: unknown; status?: string } }>)[h]?.session; return !!s?.meshInfo || s?.status === 'error'; }, hook, { timeout: 30000 });
	if (kind === 'play') await settled(p, hook);
	await p.waitForTimeout(400);
}
/** Wait until a run has finished (solved, unavailable, error or only meshed). */
async function settled(p: Page, hook: string) {
	await p.waitForFunction((h) => { const s = (window as unknown as Record<string, { session?: { status?: string } }>)[h]?.session; return !!s && ['solved', 'unavailable', 'error', 'meshed'].includes(s.status ?? ''); }, hook, { timeout: 60000 });
}
const status = (p: Page, hook: string) => p.evaluate((h) => { const s = (window as unknown as Record<string, { session: { status: string; reasons: string[]; error: string; lastOutcomeMs: number; solution: { stats: unknown } | null } }>)[h]!.session; return { status: s.status, reasons: s.reasons, error: s.error, ms: s.lastOutcomeMs, stats: s.solution?.stats ?? null }; }, hook);
const fcp = (p: Page) => p.evaluate(() => new Promise<number>((res) => {
	const hit = performance.getEntriesByType('paint').find((e) => e.name === 'first-contentful-paint');
	if (hit) return res(hit.startTime);
	new PerformanceObserver((l) => { const e = l.getEntries().find((x) => x.name === 'first-contentful-paint'); if (e) res(e.startTime); }).observe({ type: 'paint', buffered: true });
	setTimeout(() => res(NaN), 3000);
}));

const shell = await chromium.launch({ executablePath: SHELL, headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
result.browser = { shell: shell.version() };

// ---- first paint (fresh context each load, no service worker)
const paints: Record<string, number[]> = {};
for (const path of ['/', '/play/kirsch-plate', '/play/rt/lbm-d2q9']) {
	paints[path] = [];
	for (let i = 0; i < 5; i++) {
		const p = await newPage(shell, 1440, 900);
		await p.goto(origin + path, { waitUntil: 'load' });
		paints[path].push(await fcp(p));
		await p.context().close();
	}
}
result.fcp = Object.fromEntries(Object.entries(paints).map(([k, v]) => [k, { median: median(v), all: v }]));

// ---- workbench: screenshots, tab switch, op-log round trip
const wbShots: string[] = [];
for (const v of VIEWS) for (const sim of ['kirsch-plate', 'box-acoustics']) {
	const p = await newPage(shell, v.w, v.h);
	await p.goto(`${origin}/?sim=${sim}`);
	await ready(p, 'wb');
	const f = `${out}/L5-workbench-${sim}-${v.tag}-${ts}.png`;
	await p.screenshot({ path: f });
	wbShots.push(f);
	if (v.w === 1440) {
		// Compute (materials from the paired eval case), then the Results view
		await p.locator('.tb button', { hasText: 'Compute' }).click();
		await p.waitForTimeout(200);
		await settled(p, '__ampWorkbench');
		(result.compute ??= {} as Record<string, unknown>);
		(result.compute as Record<string, unknown>)[sim] = await status(p, '__ampWorkbench');
		await p.evaluate(() => (window as unknown as { __ampWorkbench: { setMode(m: string): void } }).__ampWorkbench.setMode('results'));
		await p.waitForTimeout(800);
		await p.screenshot({ path: `${out}/L5-workbench-${sim}-results-${v.tag}-${ts}.png` });
		if (sim === 'box-acoustics') {
			// 3D post: slice + isosurfaces of the selected eigenmode, then the phase animation
			const top = p.locator('.gfx .top');
			await top.locator('button', { hasText: 'Slice' }).click();
			await top.locator('button', { hasText: 'Iso' }).click();
			await p.waitForTimeout(800);
			await p.screenshot({ path: `${out}/L5-workbench-${sim}-slice-iso-${v.tag}-${ts}.png` });
			await top.locator('button', { hasText: 'Slice' }).click();
			await top.locator('button', { hasText: 'Iso' }).click();
			await top.locator('button', { hasText: 'Section' }).click();
			await top.locator('button', { hasText: 'Play' }).click();
			await p.waitForTimeout(700);
			await p.screenshot({ path: `${out}/L5-workbench-${sim}-section-anim-${v.tag}-${ts}.png` });
		}
	}
	if (v.w === 1440 && sim === 'kirsch-plate') {
		// tab switch: click -> two animation frames after the click handler
		const tabTimes: Record<string, number[]> = {};
		for (let k = 0; k < 3; k++) for (const t of ['Log', 'Progress', 'Timeline', 'Messages']) {
			const ms = await p.evaluate(async (label) => {
				const b = [...document.querySelectorAll('.tabs button')].find((x) => x.textContent?.startsWith(label)) as HTMLButtonElement;
				const t0 = performance.now();
				b.click();
				await new Promise((r) => requestAnimationFrame(r));
				return performance.now() - t0;
			}, t);
			(tabTimes[t] ??= []).push(ms);
		}
		const modeTimes: number[] = [];
		for (let k = 0; k < 3; k++) for (const key of ['g', 'm', 'r', 'm']) {
			modeTimes.push(await p.evaluate(async (kk) => { const t0 = performance.now(); window.dispatchEvent(new KeyboardEvent('keydown', { key: kk })); await new Promise((r) => requestAnimationFrame(r)); return performance.now() - t0; }, key));
		}
		result.tabSwitchMs = Object.fromEntries(Object.entries(tabTimes).map(([k, a]) => [k, { median: median(a), max: Math.max(...a) }]));
		result.modeSwitchMs = { median: median(modeTimes), max: Math.max(...modeTimes) };
		// op-log round trip through the Settings form: Parameters node, field D, 20 edits, then 20 Undo clicks
		const t0 = await p.evaluate(() => (window as unknown as { __ampWorkbench: { session: { model: { text: string } } } }).__ampWorkbench.session.model.text);
		await p.locator('.tree .row', { hasText: 'Parameters' }).click();
		const field = p.locator('.ps', { hasText: 'D' }).first().locator('input:not([type=range])');
		for (let i = 0; i < 20; i++) { await field.click(); await field.fill(String(2 + 0.3 * i)); await field.press('Enter'); await p.waitForTimeout(30); }
		const nOps = await p.evaluate(() => (window as unknown as { __ampWorkbench: { session: { model: { ops: unknown[] } } } }).__ampWorkbench.session.model.ops.length);
		const undo = p.locator('.tb button', { hasText: 'Undo' });
		for (let i = 0; i < 20; i++) { await undo.click(); await p.waitForTimeout(20); }
		const t1 = await p.evaluate(() => (window as unknown as { __ampWorkbench: { session: { model: { text: string; ops: unknown[] } } } }).__ampWorkbench.session.model.text);
		result.oplogRoundTrip = { edits: nOps, identical: t0 === t1, bytes: t0.length };
		await p.evaluate(() => (window as unknown as { __ampWorkbench: { setTab(t: string): void } }).__ampWorkbench.setTab('timeline'));
		await p.waitForTimeout(200);
		await p.screenshot({ path: `${out}/L5-workbench-timeline-1440-${ts}.png` });
		// YAML tab view
		await p.locator('.ph.tabs button', { hasText: 'YAML' }).click();
		await p.waitForTimeout(150);
		await p.screenshot({ path: `${out}/L5-workbench-yaml-1440-${ts}.png` });
	}
	await p.context().close();
}

// ---- Play views
const drags: Record<string, unknown> = {};
for (const v of VIEWS) for (const sim of SIMS) {
	const p = await newPage(shell, v.w, v.h);
	await p.goto(`${origin}/play/${sim}`);
	await ready(p, 'play');
	if (v.w === 1440) {
		const before = await p.evaluate(() => (window as unknown as { __ampPlay: { session: { model: { ops: unknown[] } } } }).__ampPlay.session.model.ops.length);
		const slider = p.locator('aside input[type=range]').nth(sim === 'si-rib-waveguide' ? 3 : 0);
		if (await slider.count()) {
			const [mn, mx] = await slider.evaluate((el: HTMLInputElement) => [Number(el.min), Number(el.max)]);
			const times: number[] = [];
			for (let i = 1; i <= 12; i++) {
				await slider.evaluate((el: HTMLInputElement, val) => { el.value = String(val); el.dispatchEvent(new Event('input', { bubbles: true })); }, mn + ((mx - mn) * i) / 14);
				await p.waitForTimeout(120);
				times.push(await p.evaluate(() => (window as unknown as { __ampPlay: { session: { dragMs: number } } }).__ampPlay.session.dragMs));
			}
			await slider.evaluate((el: HTMLInputElement) => el.dispatchEvent(new Event('change', { bubbles: true })));
			await p.waitForTimeout(600);
			const after = await p.evaluate(() => { const m = (window as unknown as { __ampPlay: { session: { model: { ops: Array<{ coalesced?: number }> } } } }).__ampPlay.session.model; return { n: m.ops.length, coalesced: m.ops.at(-1)?.coalesced ?? 1 }; });
			drags[sim] = { sliderSteps: 12, opsAdded: after.n - before, coalesced: after.coalesced, dragRemeshMs: { median: median(times.filter((x) => x > 0)), max: Math.max(...times) } };
		}
		const hd = p.locator('svg.ov rect.hd').first();
		if (await hd.count()) {
			const b = (await hd.boundingBox())!;
			const n0 = await p.evaluate(() => (window as unknown as { __ampPlay: { session: { model: { ops: unknown[] } } } }).__ampPlay.session.model.ops.length);
			await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
			await p.mouse.down();
			for (let i = 1; i <= 10; i++) { await p.mouse.move(b.x + b.width / 2 - 3 * i, b.y + b.height / 2 + 3 * i); await p.waitForTimeout(60); }
			await p.mouse.up();
			await p.waitForTimeout(600);
			const n1 = await p.evaluate(() => { const m = (window as unknown as { __ampPlay: { session: { model: { ops: Array<{ coalesced?: number; reason?: string }> } } } }).__ampPlay.session.model; return { n: m.ops.length, last: m.ops.at(-1) ?? null }; });
			(drags[sim] as Record<string, unknown> | undefined ?? (drags[sim] = {}));
			(drags[sim] as Record<string, unknown>).handle = { opsAdded: n1.n - n0, coalesced: n1.last?.coalesced ?? 1, reason: n1.last?.reason };
		}
	}
	if (v.w === 1440) { await settled(p, '__ampPlay'); (result.playStatus ??= {} as Record<string, unknown>); (result.playStatus as Record<string, unknown>)[sim] = await status(p, '__ampPlay'); }
	await p.waitForTimeout(300);
	await p.screenshot({ path: `${out}/L5-play-${sim}-${v.tag}-${ts}.png` });
	await p.context().close();
}
result.drags = drags;
await shell.close();

// ---- real-time GPU panels: installed Chrome with WebGPU (headless shell has no WebGPU adapter)
let chrome: Browser | null = null;
try {
	chrome = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=metal'] });
	(result.browser as Record<string, string>).chrome = chrome.version();
	for (const v of VIEWS) for (const k of RT) {
		const p = await newPage(chrome, v.w, v.h);
		await p.goto(`${origin}/play/rt/${k}`);
		await p.waitForTimeout(4000);
		await p.screenshot({ path: `${out}/L5-rt-${k}-${v.tag}-${ts}.png` });
		await p.context().close();
	}
} catch (e) {
	errors.push(`chrome: ${(e as Error).message}`);
} finally {
	await chrome?.close();
}

result.errors = errors;
server.close();
await writeFile(new URL(`../../../logs/L5-shots-${ts}.json`, import.meta.url), JSON.stringify(result, null, 1));
console.log(JSON.stringify(result, null, 1));
