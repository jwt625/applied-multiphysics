// SPDX-License-Identifier: GPL-3.0-or-later
// E2E assertion smoke (lane T1, DevLog-038; DevLog-037 C1). Starts `vite dev` (scripts/e2e-vite.ts, HMR off) on a free
// port and drives headless Chromium (playwright-core) through the dev hooks (window.__ampWorkbench / __ampPlay,
// src/lib/shell/hooks.ts):
//   landing   card count = the library count of the app's own catalog.ts and sims.ts modules (hidden analogs left out);
//             a search narrows the cards to the catalog matches; no console errors.
//   play      every HEROES route loads and settles; the graphics canvas is not blank; no console errors.
//   sims      every sims file (SIM_IDS, sorted; hidden analogs through /workbench?sim=<id>): page loads, no console
//             errors or uncaught exceptions, the mesh builds, Compute ends `solved` within the per-sim timeout, the
//             graphics canvas is not blank, headlines evaluated in the page (post/headline.ts), and the numeric
//             references of the paired eval cases (scalar, eigen, result and 2D probe extracts) compared with the
//             browser solution when the case's spec names this sims file.
// Verdicts: fail = a hard check failed (load, errors, mesh, compute, canvas) or a gated reference is outside a tolerance
// that is not `after: richardson` or `after: finest`; warn = a gated reference outside such a tolerance (one browser
// level: no extrapolation, not necessarily the finest level) or of a case whose spec is still pending. A reference the solution does not provide (no
// such scalar, item or field) is recorded as `pending`, as the harness does, without a warning. Canvas "not blank": at
// least 0.05 % of the canvas pixels differ from its dominant colour (5-bit bins); strip models (aspect 200:1) draw on
// under 1 % of the canvas. A test threshold, not a physical number.
// Output: logs/<tag>-e2e-<ts>.jsonl (one line per check), logs/<tag>-e2e-<ts>-summary.md, logs/<tag>-e2e-<ts>-vite.log.
// Usage: node --max-old-space-size=1536 scripts/e2e-smoke.ts [--port 41731] [--only id,id] [--skip-landing]
//        [--skip-play] [--skip-sims] [--skip-3d] [--timeout-scale 1] [--rss-limit-mb 2048] [--reuse] [--tag T1]
// --skip-3d leaves out the sims files and Play routes whose catalog dimension is 3D (CI e2e job).
// Browser: AMP_CHROME, else the newest chromium_headless_shell-* under PLAYWRIGHT_BROWSERS_PATH or the ms-playwright
// cache in HOME, else playwright-core's own default. Exit code: 0 no fail, 1 at least one fail, 2 setup error.
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, createWriteStream } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { chromium, type Browser, type Page } from 'playwright-core';
import { parseYaml, units } from '@amp/spec';
import { selectEigen } from '../../../packages/eval/src/metrics.ts';

const WEB = new URL('..', import.meta.url).pathname;
const REPO = new URL('../../..', import.meta.url).pathname;
const { values: A } = parseArgs({
	options: {
		port: { type: 'string', default: '41731' }, only: { type: 'string' }, 'skip-landing': { type: 'boolean' }, 'skip-play': { type: 'boolean' }, 'skip-sims': { type: 'boolean' }, 'skip-3d': { type: 'boolean' },
		'timeout-scale': { type: 'string', default: '1' }, 'rss-limit-mb': { type: 'string', default: '2048' }, reuse: { type: 'boolean' }, tag: { type: 'string', default: 'T1' }
	}
});
const PORT = Number(A.port), TS = Number(A['timeout-scale']), RSS_LIMIT = Number(A['rss-limit-mb']);
const ONLY = A.only ? A.only.split(',').map((x) => x.trim()).filter(Boolean) : null;
const origin = `http://127.0.0.1:${PORT}`;
const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
const LOGS = join(REPO, 'logs');
mkdirSync(LOGS, { recursive: true });
const base = join(LOGS, `${A.tag}-e2e-${stamp}`);
const JSONL = `${base}.jsonl`;
const rel = (p: string) => p.slice(REPO.length);
const say = (m: string) => console.log(`${new Date().toISOString()} ${m}`);
const emit = (o: Record<string, unknown>) => appendFileSync(JSONL, JSON.stringify({ ts: new Date().toISOString(), ...o }) + '\n');

// ---------------------------------------------------------------------------------------------------- browser path
function findShell(): string | undefined {
	if (process.env.AMP_CHROME) return process.env.AMP_CHROME;
	const h = homedir();
	const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, platform() === 'darwin' ? join(h, 'Library/Caches/ms-playwright') : platform() === 'win32' ? join(process.env.LOCALAPPDATA ?? h, 'ms-playwright') : join(h, '.cache/ms-playwright')].filter((x): x is string => !!x && x !== '0');
	for (const r of roots) {
		if (!existsSync(r)) continue;
		const revs = readdirSync(r).map((d) => /^chromium_headless_shell-(\d+)$/.exec(d)).filter((m): m is RegExpExecArray => !!m).sort((a, b) => Number(b[1]) - Number(a[1]));
		for (const m of revs) {
			const dir = join(r, m[0]);
			for (const sub of readdirSync(dir).filter((d) => d.startsWith('chrome-headless-shell-'))) {
				const exe = join(dir, sub, platform() === 'win32' ? 'chrome-headless-shell.exe' : 'chrome-headless-shell');
				if (existsSync(exe)) return exe;
			}
		}
	}
	return undefined;
}

// ---------------------------------------------------------------------------------------------------- dev server
const portFree = (p: number) => new Promise<boolean>((res) => { const s = createServer(); s.once('error', () => res(false)); s.listen(p, '127.0.0.1', () => s.close(() => res(true))); });
async function waitHttp(url: string, ms: number): Promise<boolean> {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		try { const r = await fetch(url); if (r.ok) return true; } catch { /* not up yet */ }
		await new Promise((r) => setTimeout(r, 500));
	}
	return false;
}
let vite: ChildProcess | null = null;
async function startServer(): Promise<void> {
	if (A.reuse) { if (!(await waitHttp(origin + '/', 5000))) throw new Error(`--reuse: nothing answers at ${origin}`); return; }
	if (!(await portFree(PORT))) throw new Error(`port ${PORT} is busy (use --port, or --reuse to attach to a running dev server)`);
	const out = createWriteStream(`${base}-vite.log`);
	vite = spawn(process.execPath, ['--max-old-space-size=1536', 'scripts/e2e-vite.ts', 'dev', '--port', String(PORT)], { cwd: WEB, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_NO_WARNINGS: '1' } });
	vite.stdout!.pipe(out);
	vite.stderr!.pipe(out);
	if (!(await waitHttp(origin + '/', 120000))) throw new Error(`dev server did not answer within 120 s (see ${rel(base)}-vite.log)`);
}
function stopServer() { if (vite && vite.exitCode === null) vite.kill('SIGTERM'); }

// ---------------------------------------------------------------------------------------------------- RSS sampling
const pexec = promisify(execFile);
async function rssTrees(): Promise<{ browserMb: number; viteMb: number }> {
	const { stdout } = await pexec('ps', ['-A', '-o', 'pid=,ppid=,rss=']);
	const kids = new Map<number, number[]>(), rss = new Map<number, number>();
	for (const l of stdout.split('\n')) {
		const [pid, ppid, kb] = l.trim().split(/\s+/).map(Number);
		if (!pid) continue;
		rss.set(pid, kb ?? 0);
		(kids.get(ppid!) ?? kids.set(ppid!, []).get(ppid!)!).push(pid);
	}
	const sum = (root: number, skip: number | undefined): number => { let s = 0; const st = [root]; while (st.length) { const p = st.pop()!; if (p === skip) continue; if (p !== root) s += rss.get(p) ?? 0; st.push(...(kids.get(p) ?? [])); } return s; };
	const vp = vite?.pid;
	const viteKb = vp ? (rss.get(vp) ?? 0) + sum(vp, undefined) : 0;
	return { browserMb: sum(process.pid, vp) / 1024, viteMb: viteKb / 1024 };
}
class Sampler {
	max = { browserMb: 0, viteMb: 0 };
	over: number | null = null;
	private t: ReturnType<typeof setInterval> | null = null;
	start(onOver: () => void) {
		this.max = { browserMb: 0, viteMb: 0 };
		this.over = null;
		this.t = setInterval(() => {
			void rssTrees().then((r) => {
				this.max.browserMb = Math.max(this.max.browserMb, r.browserMb);
				this.max.viteMb = Math.max(this.max.viteMb, r.viteMb);
				if (r.browserMb > RSS_LIMIT && this.over === null) { this.over = r.browserMb; onOver(); }
			}).catch(() => { /* ps unavailable */ });
		}, 1000);
	}
	stop() { if (this.t) clearInterval(this.t); this.t = null; return { browserMb: Math.round(this.max.browserMb), viteMb: Math.round(this.max.viteMb) }; }
}

// ---------------------------------------------------------------------------------------------------- page helpers
type Errors = { console: string[]; page: string[] };
async function newPage(b: Browser): Promise<{ page: Page; errs: Errors }> {
	const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, serviceWorkers: 'block' });
	// the per-process RSS rule (2 GB) applies to the browser here: report 2 GB device memory so the sweep worker pool
	// (engine/pool.ts, floor(deviceMemory / 2) workers) runs one worker; the pool itself is checked outside this smoke
	await ctx.addInitScript(() => { Object.defineProperty(Navigator.prototype, 'deviceMemory', { get: () => 2, configurable: true }); });
	const page = await ctx.newPage();
	const errs: Errors = { console: [], page: [] };
	page.on('pageerror', (e) => errs.page.push(e.message.slice(0, 500)));
	page.on('console', (m) => { if (m.type() === 'error') { const at = m.location().url; errs.console.push(`${m.text().slice(0, 400)}${at ? ` [${at.replace(origin, '')}]` : ''}`); } });
	return { page, errs };
}
/** Text of the app's open-failure banner, without waiting for it (a missing locator would wait for the default timeout). */
const failText = async (p: Page) => ((await p.locator('.fail').count()) ? await p.locator('.fail').first().textContent({ timeout: 2000 }) : null);
const closePage = async (p: Page) => { try { await p.context().close(); } catch { /* already closed */ } };

/** Pixel statistics of the largest visible graphics canvas, everything else hidden (overlays do not count). */
async function canvasStats(page: Page): Promise<{ w: number; h: number; fracNonBg: number; lumStd: number; colours: number } | { error: string }> {
	const box = await page.evaluate(() => {
		let best: HTMLCanvasElement | null = null, area = 0;
		for (const c of document.querySelectorAll<HTMLCanvasElement>('.host canvas')) { const r = c.getBoundingClientRect(); if (r.width * r.height > area && getComputedStyle(c).visibility !== 'hidden') { area = r.width * r.height; best = c; } }
		if (!best) return null;
		best.setAttribute('data-e2e', '1');
		const st = document.createElement('style');
		st.id = 'e2e-hide';
		st.textContent = 'body * { visibility: hidden !important; } canvas[data-e2e] { visibility: visible !important; }';
		document.head.appendChild(st);
		const r = best.getBoundingClientRect();
		return { x: r.x, y: r.y, width: r.width, height: r.height };
	});
	if (!box || box.width < 2 || box.height < 2) return { error: 'no graphics canvas' };
	let png: Buffer;
	try { png = await page.screenshot({ clip: box, timeout: 15000 }); }
	finally { await page.evaluate(() => { document.getElementById('e2e-hide')?.remove(); document.querySelector('canvas[data-e2e]')?.removeAttribute('data-e2e'); }).catch(() => undefined); }
	return page.evaluate(async (b64) => {
		const img = new Image();
		img.src = `data:image/png;base64,${b64}`;
		await img.decode();
		const c = new OffscreenCanvas(img.width, img.height), g = c.getContext('2d')!;
		g.drawImage(img, 0, 0);
		const d = g.getImageData(0, 0, img.width, img.height).data, n = img.width * img.height;
		const bins = new Map<number, number>();
		let s = 0, s2 = 0;
		for (let i = 0; i < d.length; i += 4) {
			const k = ((d[i]! >> 3) << 10) | ((d[i + 1]! >> 3) << 5) | (d[i + 2]! >> 3);
			bins.set(k, (bins.get(k) ?? 0) + 1);
			const L = 0.2126 * d[i]! + 0.7152 * d[i + 1]! + 0.0722 * d[i + 2]!;
			s += L; s2 += L * L;
		}
		const top = Math.max(...bins.values());
		return { w: img.width, h: img.height, fracNonBg: 1 - top / n, lumStd: Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2)), colours: bins.size };
	}, png.toString('base64'));
}
const NOT_BLANK = 0.0005;

// ---------------------------------------------------------------------------------------------------- references
type Tol = { rel?: number; abs?: number; after?: string };
type Extract = { kind: string; name?: string; index?: number; floor?: number; offset?: number; node?: string; step?: unknown; field?: string; component?: number; point?: number[] };
type Ref = { metric_id?: string; value?: unknown; unit?: string; tolerance?: Tol; gate?: boolean; extract?: Extract; spec?: unknown };
type Case = { id: string; spec?: unknown; status?: string; references?: Ref[]; targets?: Ref[] };
const caseFiles = new Map<string, string>();
for (const cls of ['a', 'b', 'c']) {
	const d = join(REPO, 'eval/cases', cls);
	if (existsSync(d)) for (const f of readdirSync(d)) if (f.endsWith('.yaml')) caseFiles.set(f.slice(0, -5), join(d, f));
}
function loadCase(id: string): Case | null {
	const f = caseFiles.get(id);
	if (!f) return null;
	try { const y = parseYaml(readFileSync(f, 'utf8')) as { data?: unknown }; return y.data && typeof y.data === 'object' ? (y.data as Case) : null; } catch { return null; }
}
/** Does a case (or reference) spec name this sims file as its model, unchanged? */
function specNames(spec: unknown, simPath: string): { match: boolean; pending: boolean; why: string } {
	if (typeof spec === 'string') return spec === simPath ? { match: true, pending: false, why: 'case spec' } : { match: false, pending: false, why: `case spec is ${spec}` };
	if (spec && typeof spec === 'object') {
		const o = spec as Record<string, unknown>;
		if (typeof o.sim === 'string') {
			if (o.sim !== simPath) return { match: false, pending: false, why: `case spec is ${o.sim}` };
			return o.params || o.study ? { match: false, pending: false, why: 'case spec overrides params or study of this sims file' } : { match: true, pending: false, why: 'case spec (sim)' };
		}
		if (o.status === 'pending') return o.ref === simPath ? { match: true, pending: true, why: 'case spec pending, ref names this sims file' } : { match: false, pending: true, why: `case spec pending${typeof o.ref === 'string' ? `, ref ${o.ref}` : ''}` };
		if (o.schema) return { match: false, pending: false, why: 'case carries an inline spec' };
	}
	return { match: false, pending: false, why: 'case has no spec' };
}
const DIMLESS = new Set(['', '1', '-', 'dimensionless']);
const unitCore = (u: string | undefined) => { const s = (u ?? '').trim(); const m = /^(\S*)\s+\([^()]*\)$/.exec(s); return m && DIMLESS.has(m[1]!) ? m[1]! : s; };
/** Same rule as the harness (packages/eval/src/registry.ts convertUnit): equal strings, dimensionless aliases, @amp/spec units. */
function convert(v: number, from: string | undefined, to: string | undefined): number | string {
	const a = unitCore(from), b = unitCore(to);
	if (a === b || (DIMLESS.has(a) && DIMLESS.has(b))) return v;
	try {
		const ua = units.parseUnit(DIMLESS.has(a) ? '1' : a), ub = units.parseUnit(DIMLESS.has(b) ? '1' : b);
		if (ua.dim.length !== ub.dim.length || ua.dim.some((x, i) => Math.abs(x - ub.dim[i]!) > 1e-12)) return `unit mismatch '${a}' vs '${b}'`;
		return (v * ua.factor + ua.offset - ub.offset) / ub.factor;
	} catch (e) { return `unit '${a}' -> '${b}': ${(e as Error).message}`; }
}
type ProbeQ = { key: string; field: string; component?: number; point: number[] };
type Planned = { case: string; metric: string; ref: number; unit: string; tol: Tol | null; gate: boolean; pending: boolean; extract: Extract; probe?: string; skip?: string };
/** Numeric references of the sim's paired cases, with the reason a reference is not compared. */
function planRefs(simId: string, evalCases: string[]): Planned[] {
	const simPath = `sims/${simId}.yaml`, out: Planned[] = [];
	for (const cid of evalCases) {
		const c = loadCase(cid);
		if (!c) { out.push({ case: cid, metric: '', ref: NaN, unit: '', tol: null, gate: false, pending: false, extract: { kind: '' }, skip: 'case file not found' }); continue; }
		for (const r of [...(c.references ?? []), ...(c.targets ?? [])]) {
			if (typeof r.value !== 'number') continue;
			const sp = specNames(r.spec ?? c.spec, simPath);
			const ex = r.extract ?? { kind: 'scalar' };
			const p: Planned = { case: cid, metric: r.metric_id ?? '', ref: r.value, unit: r.unit ?? '1', tol: r.tolerance ?? null, gate: r.gate !== false, pending: sp.pending, extract: ex };
			if (!sp.match) p.skip = sp.why;
			else if (ex.kind === 'probe') {
				if (!ex.point || !(ex.field ?? ex.name)) p.skip = 'probe extract without point or field';
				else p.probe = `${ex.field ?? ex.name}|${ex.component ?? ''}|${ex.point.join(',')}`;
			} else if (ex.kind === 'eigen' && typeof ex.index !== 'number') p.skip = 'eigen extract without index (array target)';
			else if (ex.kind === 'result' && ex.step !== undefined && ex.step !== 'last') p.skip = `result extract at step ${String(ex.step)} (headlines show the last step)`;
			else if (!['scalar', 'eigen', 'result', 'probe'].includes(ex.kind)) p.skip = `extract kind '${ex.kind}' not evaluated by the e2e smoke`;
			out.push(p);
		}
	}
	return out;
}
type BrowserSol = { scalars: Record<string, { value: number; unit?: string }>; steps: { kind: string; unit: string; values: number[] } | null; results: Record<string, { value: number; unit: string } | { error: string }>; probes: Record<string, { value: number | null; unit: string } | { error: string }> };
function compare(p: Planned, b: BrowserSol) {
	const base = { case: p.case, metric: p.metric, extract: p.extract.kind, ref: p.ref, unit: p.unit, tol: p.tol, gate: p.gate, casePending: p.pending };
	if (p.skip) return { ...base, status: 'skipped', reason: p.skip };
	let v: number | string;
	const ex = p.extract;
	if (ex.kind === 'scalar') {
		const s = b.scalars[ex.name ?? p.metric];
		v = s ? convert(s.value, s.unit, p.unit) : `no scalar '${ex.name ?? p.metric}' (has ${Object.keys(b.scalars).join(', ') || 'none'})`;
	} else if (ex.kind === 'eigen') {
		if (!b.steps || b.steps.kind !== 'eigen') v = `solution has no eigen steps (${b.steps?.kind ?? 'none'})`;
		else {
			const conv = b.steps.values.map((x) => convert(x, b.steps!.unit, p.unit));
			const bad = conv.find((x) => typeof x === 'string');
			if (bad !== undefined) v = bad as string;
			else { const sel = selectEigen(conv as number[], ex.index!, { ...(ex.floor !== undefined ? { floor: ex.floor } : {}), ...(ex.offset !== undefined ? { offset: ex.offset } : {}) }); v = sel.reason ?? sel.value; }
		}
	} else if (ex.kind === 'result') {
		const r = b.results[ex.node ?? ''];
		v = !r ? `result '${ex.node}' not evaluated` : 'error' in r ? r.error : convert(r.value, r.unit, p.unit);
	} else {
		const r = b.probes[p.probe!];
		v = !r ? 'probe not evaluated' : 'error' in r ? r.error : r.value === null ? 'probe point outside the mesh' : convert(r.value, r.unit, p.unit);
	}
	if (typeof v === 'string' || !Number.isFinite(v)) return { ...base, status: 'pending', reason: String(v) };
	const absErr = Math.abs(v - p.ref), relErr = p.ref !== 0 ? absErr / Math.abs(p.ref) : Infinity;
	const within = !p.tol || (p.tol.rel === undefined && p.tol.abs === undefined) ? null : (p.tol.rel !== undefined && relErr <= p.tol.rel) || (p.tol.abs !== undefined && absErr <= p.tol.abs);
	return { ...base, value: v, absErr, relErr, status: within === null ? 'no-tolerance' : within ? 'within' : 'outside' };
}

// ---------------------------------------------------------------------------------------------------- checks
type W = Window & Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Verdict = 'pass' | 'warn' | 'fail';
const results: Array<{ kind: string; id: string; verdict: Verdict; failures: string[]; warns: string[]; info: Record<string, unknown> }> = [];
function record(kind: string, id: string, failures: string[], warns: string[], info: Record<string, unknown>) {
	const verdict: Verdict = failures.length ? 'fail' : warns.length ? 'warn' : 'pass';
	results.push({ kind, id, verdict, failures, warns, info });
	emit({ kind, id, verdict, failures, warns, ...info });
	say(`${kind} ${id}: ${verdict}${failures.length ? ` (${failures.join('; ').slice(0, 300)})` : ''}`);
}
/** Known app issues (DevLog-038 s.5): console errors they cause are counted in `known`, not failed; remove once fixed. */
// B1: preload.server.ts names build-manifest chunks whenever .svelte-kit/output exists, also under vite dev -> 404s.
// Checked: a 404 counts as B1 only when its path is one of the page's own <link rel=modulepreload> hrefs.
const KNOWN: Array<{ re: RegExp; id: string; check?: (m: string, preloads: readonly string[]) => boolean }> = [
	{ re: /status of 404 \(Not Found\) \[\/_app\/immutable\//, id: 'B1 dev modulepreload of stale build chunks', check: (m, pl) => pl.includes(/\[([^\]]+)\]$/.exec(m)?.[1] ?? '') }
];
/** Paths of the page's modulepreload links (B1 check); collected before the page closes. */
const preloadsOf = (p: Page) => p.evaluate(() => [...document.querySelectorAll<HTMLLinkElement>('link[rel=modulepreload]')].map((l) => new URL(l.href).pathname)).catch(() => [] as string[]);
function errorFailures(e: Errors, info: Record<string, unknown>, preloads: readonly string[] = []): string[] {
	const known: Record<string, number> = {};
	const con = e.console.filter((m) => { const k = KNOWN.find((x) => x.re.test(m) && (!x.check || x.check(m, preloads))); if (k) known[k.id] = (known[k.id] ?? 0) + 1; return !k; });
	if (Object.keys(known).length) info.known = known;
	return [...e.page.map((m) => `uncaught: ${m}`), ...con.map((m) => `console error: ${m}`)];
}
const TRANSIENT = /Outdated Optimize Dep|Failed to fetch dynamically imported module|Execution context was destroyed|net::ERR_ABORTED/;

type AppMods = { simIds: string[]; heroes: string[]; catalog: Array<{ id: string; title: string; dimension: string; physics: string[]; evalCases: string[]; analog?: string; category: string; ref: { status: string } }>; hidden: string[]; listed: string[]; hiddenSource: string };
async function appModules(b: Browser): Promise<AppMods> {
	const { page } = await newPage(b);
	try {
		await page.goto(origin + '/', { waitUntil: 'load', timeout: 120000 * TS });
		return await page.evaluate(async () => {
			const c = (await import(/* @vite-ignore */ '/src/lib/library/catalog.ts' as string)) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
			const s = (await import(/* @vite-ignore */ '/src/lib/sims.ts' as string)) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
			const cat = c.CATALOG as Array<{ id: string; title: string; dimension: string; physics: string[]; evalCases: string[]; analog?: string; category: string; ref: { status: string } }>;
			// the app's listing rule (catalog.ts HIDDEN_ANALOGS / listedIds / LISTED_ENTRIES / libraryFor, DevLog-040): the
			// landing shows libraryFor(listedIds(SIM_IDS), LISTED_ENTRIES), i.e. every listed sims file once
			const hidden: string[] = [...(c.HIDDEN_ANALOGS as Set<string>)];
			const lib = c.libraryFor(c.listedIds(s.SIM_IDS), c.LISTED_ENTRIES) as { entries: Array<{ id: string }>; uncatalogued: string[] };
			const listed = [...lib.entries.map((e) => e.id), ...lib.uncatalogued].sort();
			return { simIds: s.SIM_IDS as string[], heroes: s.HEROES as string[], catalog: cat.map((e) => ({ id: e.id, title: e.title, dimension: e.dimension, physics: e.physics, evalCases: e.evalCases, ...(e.analog ? { analog: e.analog } : {}), category: e.category, ref: { status: e.ref.status } })), hidden, listed, hiddenSource: 'catalog.ts HIDDEN_ANALOGS, listedIds, LISTED_ENTRIES, libraryFor' };
		});
	} finally { await closePage(page); }
}

async function checkLanding(b: Browser, mods: AppMods) {
	const { page, errs } = await newPage(b);
	const fails: string[] = [], info: Record<string, unknown> = {};
	try {
		await page.goto(origin + '/', { waitUntil: 'load', timeout: 60000 * TS });
		await page.waitForSelector('.card', { timeout: 60000 * TS });
		await page.waitForTimeout(300);
		const listed = mods.listed;
		const n = await page.locator('.card').count();
		const cnt = ((await page.locator('.cnt').count()) ? await page.locator('.cnt').first().textContent({ timeout: 2000 }) : null)?.trim() ?? null;
		info.cards = n; info.expected = listed.length; info.counter = cnt; info.hidden = mods.hidden; info.hiddenSource = mods.hiddenSource;
		if (n !== listed.length) fails.push(`landing shows ${n} cards, library has ${listed.length} (libraryFor(listedIds(SIM_IDS), LISTED_ENTRIES))`);
		const ids = (await page.locator('.card a.hit').evaluateAll((as) => as.map((a) => new URL((a as HTMLAnchorElement).href).searchParams.get('sim') ?? ''))).sort();
		if (JSON.stringify(ids) !== JSON.stringify(listed)) fails.push(`landing cards [${ids.filter((x) => !listed.includes(x)).join(', ')}] not listed / [${listed.filter((x) => !ids.includes(x)).join(', ')}] missing`);
		if (cnt && cnt !== `${n} / ${n}`) fails.push(`counter reads '${cnt}', expected '${n} / ${n}'`);
		// search: expected hits from the app's own matches() over the listed catalog entries, plus uncatalogued ids containing every word
		const q = 'acoustics';
		const expect = await page.evaluate(async ({ q, ids }) => {
			const c = (await import(/* @vite-ignore */ '/src/lib/library/catalog.ts' as string)) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
			const lib = c.libraryFor(c.listedIds(ids), c.LISTED_ENTRIES) as { entries: Array<{ id: string }>; uncatalogued: string[] };
			const hits = lib.entries.filter((e) => c.matches(e, q)).map((e) => e.id);
			const others = lib.uncatalogued.filter((id) => q.split(/\s+/).every((w) => id.toLowerCase().includes(w)));
			return [...hits, ...others].sort();
		}, { q, ids: mods.simIds });
		await page.locator('input[type=search]').fill(q);
		await page.waitForTimeout(400);
		const shown = (await page.locator('.card a.hit').evaluateAll((as) => as.map((a) => new URL((a as HTMLAnchorElement).href).searchParams.get('sim') ?? ''))).sort();
		info.search = { q, shown: shown.length, expected: expect.length };
		if (JSON.stringify(shown) !== JSON.stringify(expect)) fails.push(`search '${q}' shows [${shown.join(', ')}], expected [${expect.join(', ')}]`);
		if (!(expect.length > 0 && expect.length < n)) fails.push(`search '${q}' does not narrow the list (${expect.length} of ${n})`);
		await page.locator('input[type=search]').fill('');
		await page.waitForTimeout(300);
		const back = await page.locator('.card').count();
		if (back !== n) fails.push(`clearing the search shows ${back} cards, expected ${n}`);
	} catch (e) { fails.push(`landing: ${(e as Error).message.split('\n')[0]}`); }
	fails.push(...errorFailures(errs, info, await preloadsOf(page)));
	await closePage(page);
	record('landing', '/', fails, [], info);
}

const statusOf = (page: Page, hook: string) => page.evaluate((h) => { const s = (window as unknown as W)[h]?.session; return s ? { status: s.status as string, fresh: !!s.fresh, error: String(s.error ?? '').slice(0, 500), reasons: (s.reasons ?? []) as string[], ms: s.lastOutcomeMs as number, stats: s.solution?.stats ?? null, mesh: s.meshInfo ? { cells: s.meshInfo.cells, nodes: s.meshInfo.nodes, type: s.meshInfo.type, qmin: s.meshInfo.qmin } : null, sweep: s.sweep ? { points: s.sweep.points.length, done: s.sweep.points.filter((p: { status: string }) => p.status === 'solved').length } : null } : null; }, hook);

async function checkPlay(b: Browser, id: string, sampler: Sampler) {
	let attempt = 0, retried = '';
	for (;;) {
		attempt++;
		const { page, errs } = await newPage(b);
		const fails: string[] = [], info: Record<string, unknown> = { route: `/play/${id}` };
		sampler.start(() => void closePage(page));
		const t0 = Date.now();
		try {
			await page.goto(`${origin}/play/${id}`, { waitUntil: 'load', timeout: 60000 * TS });
			await page.waitForFunction(() => {
				if (document.querySelector('.fail')) return true;
				const s = (window as unknown as W).__ampPlay?.session;
				return !!s && ['solved', 'unavailable', 'error'].includes(s.status) && (s.status !== 'solved' || s.fresh);
			}, null, { timeout: 300000 * TS, polling: 250 });
			info.ms = Date.now() - t0;
			const fail = await failText(page);
			if (fail) fails.push(fail.trim());
			const st = await statusOf(page, '__ampPlay');
			info.status = st;
			if (st?.status !== 'solved') fails.push(`status ${st?.status}: ${st?.error || st?.reasons.join('; ')}`);
			await page.waitForTimeout(1000);
			const cv = await canvasStats(page);
			info.canvas = cv;
			if ('error' in cv) fails.push(cv.error);
			else if (cv.fracNonBg < NOT_BLANK) fails.push(`canvas blank (${(100 * cv.fracNonBg).toFixed(2)} % non-background pixels)`);
		} catch (e) { fails.push(sampler.over !== null ? `browser RSS ${Math.round(sampler.over)} MB over the ${RSS_LIMIT} MB limit` : (e as Error).message.split('\n')[0]!); }
		fails.push(...errorFailures(errs, info, await preloadsOf(page)));
		info.rss = sampler.stop();
		await closePage(page);
		if (fails.length && attempt === 1 && sampler.over === null && fails.some((f) => TRANSIENT.test(f))) { retried = fails.find((f) => TRANSIENT.test(f))!; say(`play ${id}: retry after: ${retried}`); continue; }
		if (retried) info.retriedAfter = retried;
		record('play', id, fails, [], info);
		return;
	}
}

function timeouts(dim: string | undefined) {
	const big = dim === '3D';
	return { load: 60000 * TS, mesh: (big ? 180000 : 90000) * TS, compute: (big ? 600000 : 180000) * TS };
}

async function checkSim(b: Browser, id: string, mods: AppMods, sampler: Sampler) {
	const e = mods.catalog.find((x) => x.id === id) ?? null;
	const hidden = mods.hidden.includes(id);
	const T = timeouts(e?.dimension);
	const plan = planRefs(id, e?.evalCases ?? []);
	const resultNodes = [...new Set(plan.filter((p) => p.extract.kind === 'result' && !p.skip && p.extract.node).map((p) => p.extract.node!))];
	const probes: ProbeQ[] = [...new Map(plan.filter((p) => p.probe && !p.skip).map((p) => [p.probe!, { key: p.probe!, field: (p.extract.field ?? p.extract.name)!, ...(p.extract.component !== undefined ? { component: p.extract.component } : {}), point: p.extract.point! }])).values()];
	let attempt = 0, retried = '';
	for (;;) {
		attempt++;
		const { page, errs } = await newPage(b);
		const fails: string[] = [], warns: string[] = [];
		const info: Record<string, unknown> = { route: `/workbench?sim=${id}`, hidden, catalog: e ? { dimension: e.dimension, physics: e.physics, evalCases: e.evalCases, refStatus: e.ref.status } : null };
		sampler.start(() => void closePage(page));
		const t0 = Date.now();
		try {
			await page.goto(`${origin}/workbench?sim=${encodeURIComponent(id)}`, { waitUntil: 'load', timeout: T.load });
			info.loadMs = Date.now() - t0;
			await page.waitForFunction(() => {
				if (document.querySelector('.fail')) return true;
				const s = (window as unknown as W).__ampWorkbench?.session;
				return !!s && ['meshed', 'error', 'unavailable'].includes(s.status);
			}, null, { timeout: T.mesh, polling: 100 });
			const fail = await failText(page);
			if (fail) throw new Error(fail.trim());
			const m = await statusOf(page, '__ampWorkbench');
			info.mesh = { ms: Date.now() - t0, status: m?.status, ...(m?.mesh ?? {}) };
			if (m?.status !== 'meshed' || !m.mesh) throw new Error(`mesh: status ${m?.status}: ${m?.error}`);
			// studies of the model (study picker, DevLog-040): the smoke computes the default study only and records the others
			info.studies = await page.evaluate(() => { const d = (window as unknown as W).__ampWorkbench.session.model.data; return ((d?.studies ?? []) as Array<{ id?: string; type?: string }>).map((x) => `${x.id}:${x.type}`); });
			const seq = await page.evaluate(() => (window as unknown as W).__ampWorkbench.session.solvedSeq as number);
			const t1 = Date.now();
			await page.locator('.tb button').filter({ hasText: /^\s*Compute\s*$/ }).click({ timeout: 10000 });
			await page.waitForFunction((q) => {
				const s = (window as unknown as W).__ampWorkbench.session;
				return ['unavailable', 'error'].includes(s.status) || (s.status === 'solved' && s.fresh && s.solvedSeq > q);
			}, seq, { timeout: T.compute, polling: 250 });
			const c = await statusOf(page, '__ampWorkbench');
			info.compute = { ms: Date.now() - t1, engineMs: c?.ms, solvedStudy: await page.evaluate(() => (window as unknown as W).__ampWorkbench.session.solvedStudy ?? null), status: c?.status, stats: c?.stats, sweep: c?.sweep, ...(c?.status !== 'solved' ? { error: c?.error, reasons: c?.reasons } : {}) };
			if (c?.status !== 'solved') throw new Error(`compute: status ${c?.status}: ${c?.error || c?.reasons.join('; ')}`);
			// results view drawn: give the post worker time for the field, then the canvas check (one retry after 3 s)
			await page.waitForTimeout(1500);
			let cv = await canvasStats(page);
			if (!('error' in cv) && cv.fracNonBg < NOT_BLANK) { await page.waitForTimeout(3000); cv = await canvasStats(page); }
			info.canvas = { ...cv, mode: await page.evaluate(() => (window as unknown as W).__ampWorkbench.mode as string) };
			if ('error' in cv) fails.push(cv.error);
			else if (cv.fracNonBg < NOT_BLANK) fails.push(`canvas blank (${(100 * cv.fracNonBg).toFixed(2)} % non-background pixels)`);
			// browser values: scalars, eigen steps, headlines (post/headline.ts in the page), 2D probes (post/probe.ts)
			const bs = await page.evaluate(async ({ pq, rn }) => {
				const s = (window as unknown as W).__ampWorkbench.session;
				const sol = s.solution;
				const scalars: Record<string, { value: number; unit?: string }> = {};
				for (const [k, v] of Object.entries((sol.scalars ?? {}) as Record<string, { value: number; unit?: string }>)) if (typeof v?.value === 'number') scalars[k] = { value: v.value, ...(v.unit ? { unit: v.unit } : {}) };
				const steps = sol.steps ? { kind: String(sol.steps.kind), unit: String(sol.steps.unit ?? ''), values: Array.from(sol.steps.values as ArrayLike<number>) } : null;
				let headlines: Array<{ id: string; value: number | null; unit: string }> = [];
				let hlError = '';
				try {
					const H = (await import(/* @vite-ignore */ '/src/lib/post/headline.ts' as string)) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
					const data = s.model.data;
					headlines = ((await H.headlines(data?.results, sol, s.mesh, s.activeParams, s.post, { spec: data, label: s.activeLabel })) as Array<{ id: string; value: number | null; unit: string; tip: string }>).map((h) => ({ id: h.id, value: h.value, unit: h.unit, ...(h.value === null ? { why: h.tip.slice(0, 200) } : {}) }));
				} catch (e) { hlError = (e as Error).message; }
				const probes: Record<string, { value: number | null; unit: string } | { error: string }> = {};
				if (pq.length) {
					const P = (await import(/* @vite-ignore */ '/src/lib/post/probe.ts' as string)) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
					for (const q of pq) {
						const f = (sol.fields ?? []).find((x: { name: string }) => x.name === q.field);
						if (!f) { probes[q.key] = { error: `no field '${q.field}' (has ${(sol.fields ?? []).map((x: { name: string }) => x.name).join(', ')})` }; continue; }
						if (s.mesh.dim !== 2) { probes[q.key] = { error: '3D probe extracts are not evaluated by the e2e smoke' }; continue; }
						const comp = q.component ?? (f.components === 1 ? 0 : null);
						if (comp === null) { probes[q.key] = { error: `field '${q.field}' has ${f.components} components and the extract names none` }; continue; }
						try { probes[q.key] = { value: await P.probe2d(s.post, f, comp, q.point[0], q.point[1]), unit: String(f.unit ?? '') }; } catch (e) { probes[q.key] = { error: (e as Error).message }; }
					}
				}
				// result extracts: the evaluation item's value from its group's table (results/api.ts, as the Table tab)
				const results: Record<string, { value: number; unit: string } | { error: string }> = {};
				if (rn.length) {
					const R = (await import(/* @vite-ignore */ '/src/lib/results/api.ts' as string)) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
					const data = s.model.data, run = await R.runOf(s), rc = R.resultsClient(s.post);
					const groups = ((data?.results?.evaluations ?? []) as Array<{ id: string; items?: Array<{ id: string }> }>);
					for (const node of rn) {
						const g = groups.find((x) => (x.items ?? []).some((i) => i.id === node));
						if (!g || !run) { results[node] = { error: g ? 'no run for the displayed solution' : `no evaluation item '${node}' in the sims file` }; continue; }
						try {
							const t = await rc.table(data, g.id, [run]);
							const cols = (t.columns as Array<{ item?: string; unit: string }>).map((c, i) => [c, i] as const).filter(([c]) => c.item === node);
							if (cols.length !== 1) { results[node] = { error: `${cols.length} table columns for '${node}'` }; continue; }
							const [col, ci] = cols[0]!;
							const row = (t.rows as Array<{ cells: unknown[]; errors: Array<string | null> }>).filter((r) => r.errors[ci] !== R.NOT_SELECTED).at(-1);
							const v = row?.cells[ci];
							results[node] = typeof v === 'number' && !row?.errors[ci] ? { value: v, unit: col.unit } : { error: `'${node}': ${row?.errors[ci] || t.errors.join('; ') || 'not evaluated'}` };
						} catch (e) { results[node] = { error: (e as Error).message }; }
					}
				}
				return { scalars, steps, headlines, hlError, probes, results };
			}, { pq: probes, rn: resultNodes });
			info.headlines = bs.headlines;
			if (bs.hlError) fails.push(`headlines: ${bs.hlError}`);
			const refs = plan.map((p) => compare(p, bs));
			info.refs = refs;
			for (const r of refs) {
				if (!r.gate) continue;
				const tag = `${r.case} ${r.metric}`;
				if (r.status === 'outside') {
					const msg = `${tag}: ${'value' in r ? r.value : ''} vs ${r.ref} ${r.unit} (rel ${'relErr' in r ? r.relErr.toExponential(2) : ''}, tol ${JSON.stringify(r.tol)})`;
					if (r.tol?.after === 'richardson' || r.tol?.after === 'finest' || r.casePending) warns.push(`${msg}; single browser level${r.casePending ? ', case spec pending' : ''}`);
					else fails.push(msg);
				}
			}
		} catch (err) {
			fails.push(sampler.over !== null ? `browser RSS ${Math.round(sampler.over)} MB over the ${RSS_LIMIT} MB limit` : (err as Error).message.split('\n')[0]!);
		}
		fails.push(...errorFailures(errs, info, await preloadsOf(page)));
		info.ms = Date.now() - t0;
		info.rss = sampler.stop();
		await closePage(page);
		if (fails.length && attempt === 1 && sampler.over === null && fails.some((f) => TRANSIENT.test(f))) { retried = fails.find((f) => TRANSIENT.test(f))!; say(`sim ${id}: retry after: ${retried}`); continue; }
		if (retried) info.retriedAfter = retried;
		record('sim', id, fails, warns, info);
		return;
	}
}

// ---------------------------------------------------------------------------------------------------- main
function summary(meta: Record<string, unknown>) {
	const n = (v: Verdict) => results.filter((r) => r.verdict === v).length;
	const L: string[] = [`# e2e smoke ${stamp}`, '', `- origin ${origin}; browser ${meta.browser}; ${meta.ms} ms total`, `- checks ${results.length}: pass ${n('pass')}, warn ${n('warn')}, fail ${n('fail')}`, `- JSONL: ${rel(JSONL)}`, ''];
	L.push('| kind | id | verdict | mesh cells | compute | canvas non-bg | refs (within / outside / skipped / pending) | RSS MB | notes |', '|---|---|---|---|---|---|---|---|---|');
	for (const r of results) {
		const i = r.info as { mesh?: { cells?: number }; compute?: { status?: string; ms?: number; stats?: { dof?: number }; solvedStudy?: string | null }; canvas?: { fracNonBg?: number }; refs?: Array<{ status: string }>; rss?: { browserMb: number }; hidden?: boolean; retriedAfter?: string; studies?: string[]; known?: Record<string, number>; cards?: number; expected?: number };
		const rc = (s: string) => (i.refs ?? []).filter((x) => x.status === s).length;
		const notes = [...r.failures, ...r.warns.map((w) => `warn: ${w}`), ...(i.hidden === true ? ['hidden analog'] : []), ...(i.known ? [`known: ${Object.entries(i.known).map(([k, v]) => `${k.split(' ')[0]} x${v}`).join(', ')}`] : []), ...(i.retriedAfter ? [`retried after: ${i.retriedAfter}`] : []), ...(i.studies && i.studies.length > 1 ? [`${i.studies.length} studies (${i.studies.join(', ')}); default computed${i.compute?.solvedStudy ? `: ${i.compute.solvedStudy}` : ''}`] : []), ...(r.kind === 'landing' ? [`${i.cards} cards / ${i.expected} expected`] : [])].join('; ').replace(/\|/g, '/').slice(0, 400);
		L.push(`| ${r.kind} | ${r.id} | ${r.verdict} | ${i.mesh?.cells ?? ''} | ${i.compute ? `${i.compute.status} ${i.compute.ms} ms${i.compute.stats?.dof ? `, ${i.compute.stats.dof} DOF` : ''}` : ''} | ${i.canvas?.fracNonBg !== undefined ? `${(100 * i.canvas.fracNonBg).toFixed(1)} %` : ''} | ${i.refs ? `${rc('within')} / ${rc('outside')} / ${rc('skipped')} / ${rc('pending')}` : ''} | ${i.rss?.browserMb ?? ''} | ${notes} |`);
	}
	writeFileSync(`${base}-summary.md`, L.join('\n') + '\n');
}

let code = 0;
const T0 = Date.now();
let browser: Browser | null = null;
try {
	await startServer();
	const exe = findShell();
	browser = await chromium.launch({ ...(exe ? { executablePath: exe } : {}), headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
	const meta = { origin, browser: `${exe ? 'headless shell' : 'playwright default'} ${browser.version()}`, node: process.version, only: ONLY, skip3d: !!A['skip-3d'], timeoutScale: TS, rssLimitMb: RSS_LIMIT };
	emit({ kind: 'meta', ...meta });
	say(`e2e: ${meta.browser} at ${origin}; log ${rel(JSONL)}`);
	const mods = await appModules(browser);
	emit({ kind: 'library', sims: mods.simIds.length, heroes: mods.heroes, hidden: mods.hidden, hiddenSource: mods.hiddenSource, uncatalogued: mods.simIds.filter((id) => !mods.catalog.some((e) => e.id === id)) });
	const sampler = new Sampler();
	if (!A['skip-landing'] && !ONLY) await checkLanding(browser, mods);
	const is3d = (id: string) => mods.catalog.find((e) => e.id === id)?.dimension === '3D';
	const keep = (id: string) => (!ONLY || ONLY.includes(id)) && !(A['skip-3d'] && is3d(id));
	if (!A['skip-play']) for (const id of [...mods.heroes].sort()) if (keep(id)) await checkPlay(browser, id, sampler);
	if (!A['skip-sims']) {
		const ids = [...mods.simIds].sort().filter(keep);
		for (const x of ONLY ?? []) if (!mods.simIds.includes(x)) record('sim', x, [`--only names '${x}', which is not a sims file`], [], {});
		for (const id of ids) await checkSim(browser, id, mods, sampler);
	}
	summary({ ...meta, ms: Date.now() - T0 });
	code = results.some((r) => r.verdict === 'fail') ? 1 : 0;
	const n = (v: Verdict) => results.filter((r) => r.verdict === v).length;
	say(`e2e done: ${results.length} checks, pass ${n('pass')}, warn ${n('warn')}, fail ${n('fail')}; ${rel(base)}-summary.md`);
} catch (e) {
	console.error(`e2e setup error: ${(e as Error).message}`);
	emit({ kind: 'setup-error', message: (e as Error).message });
	code = 2;
} finally {
	await browser?.close().catch(() => undefined);
	stopServer();
}
process.exit(code);
