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
import { createOpLog } from '@amp/spec';
import { prepareRun } from '@amp/physics';

const out = process.argv[2] ?? 'shots';
const port = Number(process.argv[3] ?? 47391);
const root = new URL('../build/', import.meta.url).pathname;
const ts = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
const SHELL = `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell`;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

try { execSync(`lsof -iTCP:${port} -sTCP:LISTEN -n -P`, { stdio: 'pipe' }); console.error(`port ${port} busy`); process.exit(2); } catch { /* free */ }

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm' };
// headers from build/_headers (Cloudflare Pages syntax: a path pattern line, then indented `Name: value` lines;
// `*` matches any suffix; every matching block applies, as on Pages)
const rules: Array<{ re: RegExp; h: Array<[string, string]> }> = [];
for (const line of (await readFile(join(root, '_headers'), 'utf8')).split('\n')) {
	if (!line.trim() || line.trim().startsWith('#')) continue;
	if (!/^\s/.test(line)) rules.push({ re: new RegExp('^' + line.trim().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'), h: [] });
	else { const i = line.indexOf(':'); rules.at(-1)?.h.push([line.slice(0, i).trim(), line.slice(i + 1).trim()]); }
}
const headersFor = (path: string) => {
	const out: Record<string, string> = {};
	for (const r of rules) if (r.re.test(path)) for (const [k, v] of r.h) out[k] = out[k] ? `${out[k]}, ${v}` : v;
	return out;
};
const HEAD = headersFor('/404');
const file = async (p: string) => { try { return (await stat(p)).isFile() ? p : null; } catch { return null; } };
const server = createServer(async (req, res) => {
	const url = new URL(req.url ?? '/', 'http://x');
	const base = join(root, normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, ''));
	const hit = (await file(base)) ?? (await file(base + '.html')) ?? (await file(join(base, 'index.html')));
	if (!hit) { res.writeHead(404, HEAD); res.end(); return; }
	res.writeHead(200, { ...headersFor(url.pathname), 'Content-Type': TYPES[extname(hit)] ?? 'application/octet-stream', 'Cache-Control': hit.includes('/_app/immutable/') ? 'public, max-age=31536000, immutable' : 'no-cache' });
	res.end(await readFile(hit));
});
await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
const origin = `http://127.0.0.1:${port}`;
await mkdir(out, { recursive: true });

const ONLY = process.env.ONLY ?? '';
const SIMS_ALL = ['kirsch-plate', 'heat-plate-fin', 'helmholtz-coil', 'si-rib-waveguide', 'cylinder-cavity', 'box-acoustics'];
const SIMS = ONLY ? SIMS_ALL.filter((x) => x === ONLY) : SIMS_ALL;
const RT = ['lbm-d2q9', 'fdtd-tmz', 'gray-scott'];
const VIEWS = [{ w: 1440, h: 900, tag: '1440' }, { w: 390, h: 844, tag: '390' }];
const result: Record<string, unknown> = { ts, origin, browser: {} };
const errors: string[] = [];

const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] ?? NaN; };

async function newPage(b: Browser, w: number, h: number): Promise<Page> {
	const ctx = await b.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, serviceWorkers: 'block' });
	const p = await ctx.newPage();
	await p.addInitScript(() => {
		const w = window as unknown as { __lt: number[] };
		w.__lt = [];
		try { new PerformanceObserver((l) => { for (const e of l.getEntries()) w.__lt.push(e.duration); }).observe({ type: 'longtask', buffered: true }); } catch { /* not supported */ }
	});
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
	await p.waitForTimeout(150);
	await p.waitForFunction((h) => { const s = (window as unknown as Record<string, { session?: { status?: string; fresh?: boolean; solution?: unknown } }>)[h]?.session; return !!s && ['solved', 'unavailable', 'error', 'meshed'].includes(s.status ?? '') && (s.status !== 'solved' || !!s.fresh); }, hook, { timeout: 90000 });
}
const longTasks = (p: Page) => p.evaluate(() => { const a = (window as unknown as { __lt: number[] }).__lt.splice(0); return { n: a.length, max: a.length ? Math.max(...a) : 0, over100: a.filter((x) => x > 100).length }; });
const scalar = (p: Page, k: string) => p.evaluate((kk) => (window as unknown as { __ampPlay: { session: { solution: { scalars: Record<string, { value: number }> } | null } } }).__ampPlay.session.solution?.scalars[kk]?.value ?? null, k);
const status = (p: Page, hook: string) => p.evaluate((h) => { const s = (window as unknown as Record<string, { session: { status: string; reasons: string[]; error: string; lastOutcomeMs: number; fresh: boolean; meshInfo: { hash: string; cells: number } | null; solution: { stats: unknown } | null } }>)[h]!.session; return { status: s.status, fresh: s.fresh, reasons: s.reasons, error: s.error, ms: s.lastOutcomeMs, stats: s.solution?.stats ?? null, meshHash: s.meshInfo?.hash ?? null, cells: s.meshInfo?.cells ?? null }; }, hook);
/** Mesh hash of the solve mesh in Node (@amp/physics prepareRun) for the exact spec text the browser holds, audit S3. */
async function nodeMeshHash(text: string, hFactor = 1): Promise<string | null> {
	try {
		const data = (await createOpLog(text)).data as Record<string, unknown>;
		return (await prepareRun({ spec: data, hFactor })).mesh.hash;
	} catch (e) { return `error: ${(e as Error).message.slice(0, 120)}`; }
}
/** Wait for the full-accuracy sequence (DevLog-015) to end; returns its record (null when the view has none). */
type Acc = { status: string; reason: string; doneAt: number; startedAt: number; levels: Array<{ h: number; dof: number; ms: number; values: number[]; meshHash: string }>; rich: Array<{ available: boolean; reason?: string; p_obs: number | null; f_ext: number | null; gci_fine: number | null; u_abs: number | null; rel_change_last: number | null }>; conv: { tol: unknown; caseId: string; order?: number } };
async function accDone(p: Page): Promise<Acc | null> {
	await p.waitForFunction(() => { const a = (window as unknown as { __ampPlay: { session: { acc: { status: string } | null; accuracy: unknown } } }).__ampPlay.session; return !a.accuracy || (!!a.acc && a.acc.status !== 'running'); }, null, { timeout: 600000, polling: 250 });
	return p.evaluate(() => { const a = (window as unknown as { __ampPlay: { session: { acc: unknown } } }).__ampPlay.session.acc; return a ? JSON.parse(JSON.stringify(a)) : null; });
}
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
for (const path of ONLY ? [] : ['/', '/play/kirsch-plate', '/play/rt/lbm-d2q9']) {
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
for (const v of VIEWS) for (const sim of ONLY ? [] : ['kirsch-plate', 'box-acoustics']) {
	const p = await newPage(shell, v.w, v.h);
	await p.goto(`${origin}/?sim=${sim}`);
	await ready(p, 'wb');
	const f = `${out}/L5-workbench-${sim}-${v.tag}-${ts}.png`;
	await p.screenshot({ path: f });
	wbShots.push(f);
	if (v.w === 390 && sim === 'kirsch-plate') {
		// B2: after opening the log pane every pane-switcher button is still the element under its own centre
		await p.locator('.mob button', { hasText: 'log' }).click();
		await p.waitForTimeout(200);
		result.mobileSwitcher = await p.evaluate(() => [...document.querySelectorAll('.mob button')].map((b) => { const r = b.getBoundingClientRect(); return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === b; }));
		await p.screenshot({ path: `${out}/L5-workbench-${sim}-log-${v.tag}-${ts}.png` });
	}
	if (v.w === 1440) {
		// Compute (materials from the paired eval case), then the Results view
		await p.locator('.tb button', { hasText: 'Compute' }).click();
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
			await top.locator('button', { hasText: 'Animate' }).click();
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
		// Pass 2: the workbench agent column mounts (no key entered; nothing captured: no screenshot while it is open)
		await p.locator('.tb button', { hasText: 'Agent' }).click();
		await p.locator('[data-agent-panel] input[type=password]').waitFor({ timeout: 20000 });
		result.agentWorkbench = await p.evaluate(() => ({ keyFieldIsPassword: !!document.querySelector('[data-agent-panel] input[type=password]'), storageKeys: Object.keys(localStorage) }));
		await p.locator('.tb button', { hasText: 'Agent' }).click();
		// one agent operation through the bound agent path (S11 rendering)
		await p.evaluate(() => (window as unknown as { __ampWorkbench: { session: { model: { applyAgent(sess: string, patch: unknown[], reason: string): Promise<unknown> } } } }).__ampWorkbench.session.model.applyAgent('demo', [{ op: 'replace', path: '/params/D/value', value: 8 }], 'verification: agent row rendering (shots.ts)'));
		await p.evaluate(() => (window as unknown as { __ampWorkbench: { setTab(t: string): void } }).__ampWorkbench.setTab('timeline'));
		await p.waitForTimeout(200);
		await p.screenshot({ path: `${out}/L5-workbench-timeline-1440-${ts}.png` });
	}
	await p.context().close();
}

// ---- Play views
const drags: Record<string, unknown> = {};
for (const v of VIEWS) for (const sim of SIMS) {
	const p = await newPage(shell, v.w, v.h);
	await p.goto(`${origin}/play/${sim}`);
	await ready(p, 'play');
	await p.waitForTimeout(500);
	await p.screenshot({ path: `${out}/L5-play-${sim}-${v.tag}-${ts}.png` });
	if (v.w === 1440) {
		(result.playStatus ??= {} as Record<string, unknown>);
		const st = await status(p, '__ampPlay');
		const lt = await longTasks(p);
		// full-accuracy sequence (DevLog-015): cold page load to gated accuracy; every level's browser mesh hash vs Node
		const acc = await accDone(p);
		const ltAcc = await longTasks(p);
		const original = await p.evaluate(() => (window as unknown as { __ampPlay: { session: { model: { original: string } } } }).__ampPlay.session.model.original);
		const levelHashes = acc ? await Promise.all(acc.levels.map(async (l) => { const nh = await nodeMeshHash(original, l.h); return { h: l.h, browser: l.meshHash.slice(0, 12), node: nh?.slice(0, 12) ?? null, match: l.meshHash === nh }; })) : [];
		const level1 = acc?.levels[0]?.meshHash ?? st.meshHash;
		const nh = await nodeMeshHash(original);
		(result.accuracy ??= {} as Record<string, unknown>);
		(result.accuracy as Record<string, unknown>)[sim] = acc ? { status: acc.status, reason: acc.reason, loadToGatedMs: acc.doneAt || null, sequenceMs: acc.doneAt ? acc.doneAt - acc.startedAt : null, levels: acc.levels.map((l) => ({ h: l.h, dof: l.dof, ms: Math.round(l.ms), values: l.values.slice(0, 3) })), estimate: acc.rich.slice(0, 3), case: acc.conv } : null;
		(result.playStatus as Record<string, unknown>)[sim] = { ...st, meshHash: level1, nodeMeshHash: nh, hashMatch: level1 === nh, levelHashes, longTasksLoad: lt, longTasksDuringRefinement: ltAcc };
		if (sim === 'kirsch-plate') {
			// Pass 2 item 4: agent on the scripted mock provider (no network, no key): "make the hole 2x larger and rerun"
			type W = { __ampPlay: { session: { model: { text: string; ops: Array<{ actor: string; reason?: string; seq: number }>; data: { params: { D: { value: number } } }; specHash: string }; fresh: boolean; solutionSpec: string; solution: { run: { startedAt: string } } | null }; openAgentMock(steps: unknown[]): Promise<void>; mock: { remaining: number; wireViolations: unknown[] } | null } };
			const before = await p.evaluate(() => { const s = (window as unknown as W).__ampPlay.session; return { text: s.model.text, D: s.model.data.params.D.value, run: s.solution?.run.startedAt ?? '' }; });
			const steps = [
				{ content: [{ type: 'tool_use', id: 'toolu_t1', name: 'apply_ops', input: { ops: [{ op: 'replace', path: '/params/D/value', value: 2 * before.D }, { op: 'replace', path: '/params/D/range', value: [1, 2 * before.D] }], reason: `User: hole diameter 2x (${before.D} mm -> ${2 * before.D} mm); D range widened to include it` } }] },
				{ content: [{ type: 'tool_use', id: 'toolu_t2', name: 'run_study', input: { study: 'std1', reason: 'User asked to rerun after the hole change' } }] },
				{ content: [{ type: 'text', text: 'Hole diameter doubled and the study rerun.' }] }
			];
			await p.evaluate((st) => (window as unknown as W).__ampPlay.openAgentMock(st), steps);
			const box = p.locator('[data-agent-panel] textarea');
			await box.waitFor({ timeout: 20000 });
			await box.fill('make the hole 2x larger and rerun');
			await p.locator('[data-agent-panel] button', { hasText: 'Send' }).click();
			await p.waitForFunction(() => (window as unknown as W).__ampPlay.mock?.remaining === 0 && /last stop/.test(document.querySelector('[data-agent-panel] .btns')?.textContent ?? ''), null, { timeout: 60000 });
			await settled(p, '__ampPlay');
			const after = await p.evaluate(() => { const w = (window as unknown as W).__ampPlay, s = w.session; const op = s.model.ops.at(-1)!; const agentOps = s.model.ops.filter((o) => o.actor.startsWith('agent:')); return { D: s.model.data.params.D.value, fresh: s.fresh, run: s.solution?.run.startedAt ?? '', solvedFor: s.solutionSpec === s.model.specHash, agentOps: agentOps.map((o) => ({ actor: o.actor, reason: o.reason })), lastActor: op.actor, wire: w.mock?.wireViolations.length ?? -1 }; });
			await p.locator('header button', { hasText: 'Undo' }).click();
			await settled(p, '__ampPlay');
			const undone = await p.evaluate(() => (window as unknown as W).__ampPlay.session.model.text);
			result.agentPlay = { D0: before.D, D1: after.D, doubled: after.D === 2 * before.D, reran: after.run !== before.run && after.fresh && after.solvedFor, agentOps: after.agentOps, wireViolations: after.wire, undoRestoresBytes: undone === before.text };
		}
		if (sim === 'helmholtz-coil') {
			// B1: exact-field edit of a solution-only parameter re-solves; W_m scales with I^2 (compared on the hFactor-1
			// level: the full-accuracy sequence is switched off for this check so both values come from the same mesh)
			await p.evaluate(() => { const s = (window as unknown as { __ampPlay: { session: { accuracy: unknown; stopRefine(): void; requestCompute(): void } } }).__ampPlay.session; s.accuracy = null; s.stopRefine(); s.requestCompute(); });
			await settled(p, '__ampPlay');
			const w1 = await scalar(p, 'W_m');
			const field = p.locator('.ps', { hasText: 'I' }).first().locator('input:not([type=range])');
			await field.click(); await field.fill('2'); await field.press('Enter');
			await settled(p, '__ampPlay');
			const w2 = await scalar(p, 'W_m');
			await p.locator('header button', { hasText: 'Undo' }).click();
			await settled(p, '__ampPlay');
			const w3 = await scalar(p, 'W_m');
			result.b1 = { W_m_1A: w1, W_m_2A: w2, ratio: w1 && w2 ? w2 / w1 : null, pass: !!(w1 && w2 && Math.abs(w2 / w1 - 4) < 1e-9), afterUndo: w3, undoRestores: w3 === w1 };
		}
		await accDone(p);
		await longTasks(p);
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
			await settled(p, '__ampPlay');
			const after = await p.evaluate(() => { const m = (window as unknown as { __ampPlay: { session: { model: { ops: Array<{ coalesced?: number }> } } } }).__ampPlay.session.model; return { n: m.ops.length, coalesced: m.ops.at(-1)?.coalesced ?? 1 }; });
			drags[sim] = { sliderSteps: 12, opsAdded: after.n - before, coalesced: after.coalesced, dragMs: { median: median(times.filter((x) => x > 0)), max: Math.max(...times) }, longTasks: await longTasks(p), afterRelease: await status(p, '__ampPlay') };
		}
		// the camera re-frames the region of interest with an eased move (about 0.4 s) after a parameter change
		await p.waitForTimeout(600);
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
	await p.context().close();
}
result.drags = drags;
await shell.close();

// ---- real-time GPU panels: installed Chrome with WebGPU (headless shell has no WebGPU adapter)
let chrome: Browser | null = null;
try {
	chrome = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=metal'] });
	(result.browser as Record<string, string>).chrome = chrome.version();
	for (const v of VIEWS) for (const k of ONLY ? [] : RT) {
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
await writeFile(new URL(`../../../logs/${process.env.TAG ?? 'L5'}-shots-${ts}.json`, import.meta.url), JSON.stringify(result, null, 1));
console.log(JSON.stringify(result, null, 1));
