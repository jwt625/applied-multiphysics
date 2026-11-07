// SPDX-License-Identifier: GPL-3.0-or-later
// Landing previews (DevLog-030): per sims file, three 4:3 images from the REAL engine in headless Chromium: geometry,
// mesh and the solved default result, drawn by the workbench graphics pane, no axes, no colorbar, dark background.
// Needs a root build with hooks in build/ (`VITE_AMP_HOOKS=1 pnpm build`, no BASE_PATH). Serves build/ with the
// _headers rules on a free port in 47431-47439, opens /workbench?sim=<id> per sim in a fresh context (800 x 600 CSS px,
// deviceScaleFactor 2), hides everything but the graphics stage with an injected stylesheet (no app change), shoots
// geometry / mesh, runs Compute (retry with the paired case filling N/A properties when the first run is unavailable),
// shoots the result. The three shots of a sim are cropped to the union of their content boxes (4:3, margin) and
// encoded 480 x 360 WebP in the browser (PNG when the browser gives no WebP).
// Output: static/previews/<id>-{geom,mesh,result}.<webp|png>, manifest src/lib/landing/previews.json (sha256 of the
// sims file + generator version per sim: unchanged sims are skipped), log logs/previews-<ts>.json.
// Usage: nice -n 10 node --max-old-space-size=1536 scripts/previews.ts [--force] [--only id1,id2] [--port 47431]
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { readFile, readdir, stat, mkdir, writeFile, rm } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';

const GEN = 'previews/2';
const W = 480, H = 360;
const VW = 800, VH = 600, DPR = 2;
const SOLVE_MS = 240000;
const app = new URL('..', import.meta.url).pathname;
const repo = new URL('../../..', import.meta.url).pathname;
const root = join(app, 'build');
const outDir = join(app, 'static/previews');
const manifestFile = join(app, 'src/lib/landing/previews.json');
const ts = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
const logFile = join(repo, 'logs', `previews-${ts}.json`);
const SHELL = `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell`;

const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const FORCE = process.argv.includes('--force');
const ONLY = (arg('--only') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const portFree = (p: number) => { try { execSync(`lsof -iTCP:${p} -sTCP:LISTEN -n -P`, { stdio: 'pipe' }); return false; } catch { return true; } };
const port = arg('--port') ? Number(arg('--port')) : [47431, 47432, 47433, 47434, 47435, 47436, 47437, 47438, 47439].find(portFree);
if (!port || !portFree(port)) { console.error('no free port in 47431-47439'); process.exit(2); }
for (const f of ['index.html', 'workbench.html', '_headers']) {
	try { await stat(join(root, f)); } catch { console.error(`build/${f} missing: run VITE_AMP_HOOKS=1 pnpm build (no BASE_PATH) first`); process.exit(2); }
}

// ---- static server with the build/_headers rules (as scripts/shots.ts)
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.webp': 'image/webp', '.png': 'image/png' };
const rules: Array<{ re: RegExp; h: Array<[string, string]> }> = [];
for (const line of (await readFile(join(root, '_headers'), 'utf8')).split('\n')) {
	if (!line.trim() || line.trim().startsWith('#')) continue;
	if (!/^\s/.test(line)) rules.push({ re: new RegExp('^' + line.trim().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'), h: [] });
	else { const i = line.indexOf(':'); rules.at(-1)?.h.push([line.slice(0, i).trim(), line.slice(i + 1).trim()]); }
}
const headersFor = (path: string) => {
	const o: Record<string, string> = {};
	for (const r of rules) if (r.re.test(path)) for (const [k, v] of r.h) o[k] = o[k] ? `${o[k]}, ${v}` : v;
	return o;
};
const isFile = async (p: string) => { try { return (await stat(p)).isFile() ? p : null; } catch { return null; } };
const server = createServer(async (req, res) => {
	const url = new URL(req.url ?? '/', 'http://x');
	const base = join(root, normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, ''));
	const hit = (await isFile(base)) ?? (await isFile(base + '.html')) ?? (await isFile(join(base, 'index.html')));
	if (!hit) { res.writeHead(404, headersFor('/404')); res.end(); return; }
	res.writeHead(200, { ...headersFor(url.pathname), 'Content-Type': TYPES[extname(hit)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
	res.end(await readFile(hit));
});
await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
const origin = `http://127.0.0.1:${port}`;

// ---- capture state: the graphics stage fills the window; toolbar, footer, colorbar, badges, notes, progress hidden;
// the overlay text of the canvases (probe / peak markers and labels, cut-line guides, drag handles; SVG in Canvas2D and
// Canvas3D) hidden. A shown 1D plot group (.g1, thin models) fills the window instead, without its header and legend bar,
// below a 50 px top inset (the landing card's G / M / R tabs sit there, not on the y-axis ticks).
const CSS = `
.gfx { position: fixed !important; inset: 0 !important; z-index: 2147483000 !important; }
.gfx .stage { inset: 0 !important; }
.gfx > :not(.stage) { display: none !important; }
.gfx .stage .mk, .gfx .stage .gd, .gfx .stage .hd, .gfx .stage .ring, .gfx .stage svg text { display: none !important; }
.g1 { position: fixed !important; inset: 0 !important; z-index: 2147483001 !important; display: block !important; }
.g1 .g1h, .g1 .lp .bar, .g1 .p1 .badge, .g1 .p1 .errs { display: none !important; }
.g1 .g1b { position: absolute !important; inset: 50px 0 0 0 !important; }
`;
/** a 2D model whose mesh box is longer than this (either way) shows its result as a 1D line plot */
const THIN = 4;
/** couplings that run one way (C11): the result view shows the last physics of their chain */
const SEQUENTIAL = ['joule-heating', 'thermal-expansion', 'thermo-optic', 'electro-optic'];
/** capture-only result views (applied to the page's model, never written to the sims file), chosen by looking at
 *  both candidates at card size (DevLog-030) */
// 2026-11-07: gaas-microdisk-om compared (breathing-mode |u| with deformation vs the spec's optical E_r plot): the
// optical WGM reads better at card size, so no override is set
const RESULT_VIEW: Record<string, { node: Record<string, unknown>; why: string }> = {};

type View = 'geom' | 'mesh' | 'result';
type O = Record<string, unknown>;
type Hook = {
	session: { status: string; fresh: boolean; reasons: string[]; error: string; useCase: boolean; caseInfo: { id: string } | null; meshInfo: { cells: number } | null; lastOutcomeMs: number; requestCompute(): void;
		mesh: { dim: number; axisym?: boolean; nodes: Float64Array } | null; solution: { fields: Array<{ name: string; physics?: string }> } | null;
		model: { data: O | null; apply(patch: unknown[], reason?: string): Promise<unknown> } };
	setMode(m: string): void; showPlot(id: string): { ok: boolean; message?: string };
};
interface Entry { hash: string; date: string; files: Record<View, string | null>; missing?: Partial<Record<View, string>>; status?: string; cells?: number; solveMs?: number; caseFilled?: string; resultView?: string }
interface Manifest { format: 'amp-previews/0'; size: [number, number]; sims: Record<string, Entry> }

const manifest: Manifest = await readFile(manifestFile, 'utf8').then((t) => JSON.parse(t) as Manifest, () => ({ format: 'amp-previews/0', size: [W, H], sims: {} }));
manifest.format = 'amp-previews/0';
manifest.size = [W, H];
const simIds = (await readdir(join(repo, 'sims'))).filter((f) => f.endsWith('.yaml')).map((f) => f.slice(0, -5)).sort();
const todo = ONLY.length ? simIds.filter((id) => ONLY.includes(id)) : simIds;
const unknown = ONLY.filter((id) => !simIds.includes(id));
if (unknown.length) console.error(`unknown sims: ${unknown.join(', ')}`);
await mkdir(outDir, { recursive: true });
await mkdir(join(repo, 'logs'), { recursive: true });

const browser: Browser = await chromium.launch({ executablePath: SHELL, headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
// encoder page: crop, downscale, WebP (no CSP, nothing loaded)
const enc = await (await browser.newContext()).newPage();
const log: Record<string, unknown> = { ts, origin, gen: GEN, browser: browser.version(), force: FORCE, only: ONLY, sims: {} as Record<string, unknown> };
const today = new Date().toLocaleDateString('en-CA');

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function settle(p: Page) {
	await p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
	await wait(700);
}
const hook = (p: Page) => p.evaluate(() => { const h = (window as unknown as { __ampWorkbench?: Hook }).__ampWorkbench; const s = h?.session; return s ? { status: s.status, fresh: s.fresh, reasons: [...s.reasons], error: s.error, cells: s.meshInfo?.cells ?? null, ms: s.lastOutcomeMs, caseId: s.caseInfo?.id ?? null } : null; });

/** union content box (device px) of the shots, expanded to 4:3 with a margin; then each shot cropped and encoded */
async function encode(shots: Partial<Record<View, Buffer>>, crop = true): Promise<{ ext: string; data: Partial<Record<View, Buffer>>; box: number[] }> {
	const input = Object.fromEntries(Object.entries(shots).map(([k, b]) => [k, b!.toString('base64')]));
	if (!Object.keys(input).length) return { ext: 'webp', data: {}, box: [] };
	const r = await enc.evaluate(async ({ input, W, H, crop }) => {
		const load = (b64: string) => new Promise<HTMLImageElement>((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = `data:image/png;base64,${b64}`; });
		const imgs: Record<string, HTMLImageElement> = {};
		for (const [k, v] of Object.entries(input)) imgs[k] = await load(v);
		let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, iw = 0, ih = 0;
		for (const img of Object.values(imgs)) {
			iw = img.width; ih = img.height;
			const c = new OffscreenCanvas(iw, ih), g = c.getContext('2d')!;
			g.drawImage(img, 0, 0);
			const d = g.getImageData(0, 0, iw, ih).data;
			// background: #0d0d0d (2D) or the 3D radial gradient (up to #1d1e20): content differs by more than 28 per channel
			for (let y = 0; y < ih; y += 2) for (let x = 0; x < iw; x += 2) {
				const o = 4 * (y * iw + x);
				if (Math.max(d[o]!, d[o + 1]!, d[o + 2]!) - 13 > 28) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
			}
		}
		if (!Number.isFinite(x0) || !crop) { x0 = 0; y0 = 0; x1 = iw; y1 = ih; }
		const m = crop ? 0.06 : 0;
		let w = (x1 - x0) * (1 + 2 * m), h = (y1 - y0) * (1 + 2 * m);
		const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
		if (w / h > W / H) h = (w * H) / W; else w = (h * W) / H;
		w = Math.max(w, 64); h = (w * H) / W;
		const box = [cx - w / 2, cy - h / 2, w, h];
		const out: Record<string, string> = {};
		let ext = 'webp';
		for (const [k, img] of Object.entries(imgs)) {
			const c = document.createElement('canvas');
			c.width = W; c.height = H;
			const g = c.getContext('2d')!;
			g.fillStyle = '#0d0d0d';
			g.fillRect(0, 0, W, H);
			g.imageSmoothingEnabled = true;
			g.imageSmoothingQuality = 'high';
			// two-step downscale (at most 2x per step) keeps thin mesh lines
			let src: CanvasImageSource = img, sx = box[0]!, sy = box[1]!, sw = box[2]!, sh = box[3]!;
			while (sw > 2 * W) {
				const t = document.createElement('canvas');
				t.width = Math.round(sw / 2); t.height = Math.round(sh / 2);
				const tg = t.getContext('2d')!;
				tg.fillStyle = '#0d0d0d'; tg.fillRect(0, 0, t.width, t.height);
				tg.imageSmoothingQuality = 'high';
				tg.drawImage(src, sx, sy, sw, sh, 0, 0, t.width, t.height);
				src = t; sx = 0; sy = 0; sw = t.width; sh = t.height;
			}
			g.drawImage(src, sx, sy, sw, sh, 0, 0, W, H);
			let url = c.toDataURL('image/webp', 0.86);
			if (!url.startsWith('data:image/webp')) { url = c.toDataURL('image/png'); ext = 'png'; }
			out[k] = url.slice(url.indexOf(',') + 1);
		}
		return { ext, out, box };
	}, { input, W, H, crop });
	return { ext: r.ext, data: Object.fromEntries(Object.entries(r.out).map(([k, v]) => [k, Buffer.from(v, 'base64')])), box: r.box };
}

interface Plan { last: string | null; pick: string | null; thin: boolean; aspect: number; plot1d: string | null; cutline: string | null; expr: string | null; unit: string | null; lo: number[]; hi: number[]; axisym: boolean }
/** what the result view shows: the last physics of a one-way coupling chain (its first 2D plot group); thin 2D models a line plot */
function resultPlan(p: Page): Promise<Plan> {
	return p.evaluate((a) => {
		const s = (window as unknown as { __ampWorkbench: Hook }).__ampWorkbench.session;
		const d = (s.model.data ?? {}) as { couplings?: O[]; physics?: O[]; results?: { plots?: O[]; datasets?: O[] } };
		const plots = d.results?.plots ?? [];
		const seq = (d.couplings ?? []).filter((c) => a.seqTypes.includes(String(c.type)));
		const froms = new Set(seq.map((c) => String(c.from)));
		const last = seq.length ? (seq.map((c) => String(c.to)).find((t) => !froms.has(t)) ?? String(seq.at(-1)!.to)) : null;
		const surf = (g: O) => ((g.items as O[] | undefined) ?? []).find((i) => i.type === 'surface') ?? null;
		const p2 = plots.filter((g) => g.type === 'plot2d' && g.enabled !== false && surf(g));
		const pick = last ? (p2.find((g) => String(surf(g)!.expr).includes(`${last}.`)) ?? null) : null;
		const m = s.mesh;
		const lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
		if (m && m.dim === 2) for (let i = 0; i < m.nodes.length; i += 2) for (let k = 0; k < 2; k++) { const v = m.nodes[i + k]!; if (v < lo[k]!) lo[k] = v; if (v > hi[k]!) hi[k] = v; }
		const w = hi[0]! - lo[0]!, h = hi[1]! - lo[1]!;
		const aspect = m && m.dim === 2 && w > 0 && h > 0 ? Math.max(w / h, h / w) : 1;
		const shown = pick ?? p2[0] ?? null;
		// no 2D plot group: a magnitude field when the module has one (modes: normE; a TM mode's first component is ~0), else the first field
		const f0 = s.solution?.fields?.find((f) => f.name === 'normE') ?? s.solution?.fields?.[0];
		const ph = f0?.physics ?? String((d.physics ?? [])[0]?.id ?? '');
		const expr = shown ? String(surf(shown)!.expr) : f0 && ph ? `${ph}.${f0.name}` : null;
		const unit = shown && surf(shown)!.unit ? String(surf(shown)!.unit) : null;
		return {
			last, pick: pick ? String(pick.id) : null, thin: aspect > a.thin, aspect,
			plot1d: String(plots.find((g) => g.type === 'plot1d' && g.enabled !== false)?.id ?? '') || null,
			cutline: String((d.results?.datasets ?? []).find((x) => x.type === 'cutline')?.id ?? '') || null,
			expr, unit, lo, hi, axisym: !!m?.axisym,
		};
	}, { seqTypes: SEQUENTIAL, thin: THIN });
}
/** 1D line plot of a thin model: the spec's plot1d group, else a group over its cut line, else (capture only, never
 *  written to the sims file) a cut line along the long axis (axisymmetric: the radius) at mid-height of the mesh box */
async function linePlot(p: Page, plan: Plan): Promise<{ png: Buffer; view: string } | { error: string }> {
	let gid = plan.plot1d, view = `1D plot ${plan.plot1d} (spec)`;
	if (!gid) {
		if (!plan.expr) return { error: 'no expression for a line plot' };
		const r = await p.evaluate(async ({ plan }) => {
			const s = (window as unknown as { __ampWorkbench: Hook }).__ampWorkbench.session;
			const d = (s.model.data ?? {}) as { results?: { plots?: O[]; datasets?: O[] } };
			const patch: O[] = [];
			const res = d.results;
			let ds = plan.cutline;
			const dsets = res?.datasets ?? [];
			const sol = String(dsets.find((x) => x.type === 'solution')?.id ?? '');
			if (!ds) {
				if (!sol) return { error: 'no solution dataset' };
				const [x0, y0] = plan.lo, [x1, y1] = plan.hi;
				const wide = plan.axisym || x1! - x0! >= y1! - y0!;
				const e = 1e-6 * Math.max(x1! - x0!, y1! - y0!);
				const q = (v: number) => `${Number(v.toPrecision(12))} m`;
				const ym = (y0! + y1!) / 2, xm = (x0! + x1!) / 2;
				ds = 'preview_cln';
				const node = { id: ds, type: 'cutline', data: sol, from: wide ? [q(x0! + e), q(ym)] : [q(xm), q(y0! + e)], to: wide ? [q(x1! - e), q(ym)] : [q(xm), q(y1! - e)], n: 200 };
				patch.push(res?.datasets ? { op: 'add', path: '/results/datasets/-', value: node } : { op: 'add', path: '/results/datasets', value: [node] });
			}
			const g = { id: 'preview_1d', type: 'plot1d', items: [{ id: 'preview_lg', type: 'linegraph', data: ds, x: 'arc', expr: plan.expr, ...(plan.unit ? { unit: plan.unit } : {}) }] };
			patch.push(res?.plots ? { op: 'add', path: '/results/plots/-', value: g } : { op: 'add', path: '/results/plots', value: [g] });
			if (!res) return { error: 'spec has no results section' };
			await s.model.apply(patch, 'preview capture: 1D line plot (not saved)');
			return { gid: g.id, made: !plan.cutline };
		}, { plan });
		if ('error' in r) return { error: String(r.error) };
		gid = r.gid;
		view = `1D plot of ${plan.expr} over ${r.made ? `a capture-only cut line along the ${plan.axisym ? 'radius' : 'long axis'} (mid-height)` : `cut line ${plan.cutline} (spec)`}`;
	}
	const ok = await p.evaluate((id) => (window as unknown as { __ampWorkbench: Hook }).__ampWorkbench.showPlot(id), gid);
	if (!ok.ok) return { error: ok.message ?? 'showPlot failed' };
	// larger type at the card size: the 1D view is shot at the output size
	await p.setViewportSize({ width: W, height: H });
	try {
		await p.waitForFunction(() => !!document.querySelector('.g1 .p1 canvas') || /^(?!evaluating)./.test(document.querySelector('.g1 .p1 .msg')?.textContent?.trim() ?? ''), null, { timeout: 30000 });
	} catch { return { error: '1D plot did not render' }; }
	await settle(p);
	const msg = await p.evaluate(() => document.querySelector('.g1 .p1 .msg')?.textContent?.trim() ?? '');
	if (msg) return { error: `1D plot: ${msg.slice(0, 160)}` };
	return { png: await p.screenshot(), view };
}

let done = 0, skipped = 0, failed = 0;
for (const id of todo) {
	const text = await readFile(join(repo, 'sims', `${id}.yaml`), 'utf8');
	const hash = sha(`${GEN}\n${text}`);
	const prev = manifest.sims[id];
	const have = prev && (await Promise.all(Object.values(prev.files).filter(Boolean).map((f) => isFile(join(outDir, f!))))).every(Boolean);
	if (!FORCE && prev?.hash === hash && have) { skipped++; (log.sims as Record<string, unknown>)[id] = { skipped: true }; continue; }
	const t0 = Date.now();
	const rec: Record<string, unknown> = { id, hash };
	const errors: string[] = [];
	const ctx = await browser.newContext({ viewport: { width: VW, height: VH }, deviceScaleFactor: DPR, serviceWorkers: 'block' });
	await ctx.addInitScript((css) => { addEventListener('DOMContentLoaded', () => { const s = document.createElement('style'); s.textContent = css; document.head.append(s); }); }, CSS);
	const p = await ctx.newPage();
	p.on('pageerror', (e) => errors.push(e.message));
	p.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
	const shots: Partial<Record<View, Buffer>> = {};
	const missing: Partial<Record<View, string>> = {};
	let caseFilled: string | undefined;
	let line1d: Buffer | null = null;
	let resultView: string | undefined;
	try {
		await p.goto(`${origin}/workbench?sim=${encodeURIComponent(id)}`, { waitUntil: 'load' });
		await p.waitForFunction(() => { const s = (window as unknown as { __ampWorkbench?: Hook }).__ampWorkbench?.session; return !!s?.meshInfo || s?.status === 'error'; }, null, { timeout: 60000 });
		const st0 = await hook(p);
		if (!st0?.cells) throw new Error(`no mesh: ${st0?.error ?? 'unknown'}`);
		rec.cells = st0.cells;
		for (const [v, mode] of [['geom', 'geometry'], ['mesh', 'mesh']] as const) {
			await p.evaluate((m) => (window as unknown as { __ampWorkbench: Hook }).__ampWorkbench.setMode(m), mode);
			await settle(p);
			shots[v] = await p.screenshot();
		}
		const solve = async () => {
			const t = Date.now();
			await p.evaluate(() => (window as unknown as { __ampWorkbench: Hook }).__ampWorkbench.session.requestCompute());
			await wait(200);
			await p.waitForFunction(() => { const s = (window as unknown as { __ampWorkbench: Hook }).__ampWorkbench.session; return ['solved', 'unavailable', 'error'].includes(s.status) && (s.status !== 'solved' || s.fresh); }, null, { timeout: SOLVE_MS, polling: 250 });
			return { ...(await hook(p))!, wall: Date.now() - t };
		};
		let st = await solve();
		if (st.status === 'unavailable' && st.caseId) {
			// the workbench offers "N/A from <case>": fill N/A properties from the paired eval case and run again
			rec.firstRun = { status: st.status, reasons: st.reasons };
			await p.evaluate(() => { (window as unknown as { __ampWorkbench: Hook }).__ampWorkbench.session.useCase = true; });
			st = await solve();
			if (st.status === 'solved' && st.caseId) caseFilled = st.caseId;
		}
		rec.status = st.status; rec.solveMs = st.ms; rec.wallMs = st.wall;
		if (st.status === 'solved') {
			const plan = await resultPlan(p);
			const ov = RESULT_VIEW[id];
			if (ov) {
				await p.evaluate(async (node) => { const s = (window as unknown as { __ampWorkbench: Hook }).__ampWorkbench.session; await s.model.apply([{ op: 'add', path: '/results/plots/-', value: node }], 'preview capture: result view (not saved)'); }, ov.node);
				plan.pick = String(ov.node.id);
				plan.thin = false;
			}
			rec.plan = plan;
			if (plan.pick) await p.evaluate((id) => (window as unknown as { __ampWorkbench: Hook }).__ampWorkbench.showPlot(id), plan.pick);
			await p.evaluate(() => (window as unknown as { __ampWorkbench: Hook }).__ampWorkbench.setMode('results'));
			await settle(p);
			await wait(500);
			// a field the viewer cannot draw shows a notice instead of a plot (hidden by the capture CSS): no result image
			const notice = await p.evaluate(() => document.querySelector('.gfx .unav')?.textContent?.trim().replace(/\s+/g, ' ') ?? '');
			const line = plan.thin ? await linePlot(p, plan) : null;
			if (line && 'png' in line) { line1d = line.png; resultView = line.view; }
			else {
				if (line) rec.line1d = line.error;
				if (notice) missing.result = `not drawable: ${notice.slice(0, 160)}`;
				else { shots.result = await p.screenshot(); resultView = ov ? `capture-only plot: ${ov.why}` : plan.pick ? `plot ${plan.pick} (last physics of the coupling chain: ${plan.last})` : 'default plot'; }
			}
		} else missing.result = st.status === 'unavailable' ? `unavailable: ${st.reasons.join('; ').slice(0, 300)}` : `error: ${(st.error || '').slice(0, 300)}`;
	} catch (e) {
		const msg = (e as Error).message.split('\n')[0]!.slice(0, 300);
		rec.error = msg;
		for (const v of ['geom', 'mesh', 'result'] as const) if (!shots[v]) missing[v] ??= `capture failed: ${msg}`;
	}
	await ctx.close();
	const files: Record<View, string | null> = { geom: null, mesh: null, result: null };
	if (Object.keys(shots).length || line1d) {
		const { ext, data, box } = await encode(shots);
		// the 1D plot is a full 4:3 window shot: scaled, not cropped to the geometry
		if (line1d) data.result = (await encode({ result: line1d }, false)).data.result;
		rec.cropBox = box.map((x) => Math.round(x));
		for (const v of ['geom', 'mesh', 'result'] as const) {
			// remove only this generator's own earlier image of the view (other format or a view that is now missing)
			for (const e of ['webp', 'png']) if (e !== ext || !data[v]) await rm(join(outDir, `${id}-${v}.${e}`), { force: true });
			if (!data[v]) continue;
			files[v] = `${id}-${v}.${ext}`;
			await writeFile(join(outDir, files[v]!), data[v]!);
		}
	}
	for (const v of ['geom', 'mesh', 'result'] as const) if (!files[v] && !missing[v]) missing[v] = 'not captured';
	const entry: Entry = { hash, date: today, files, status: String(rec.status ?? 'error') };
	if (Object.keys(missing).length) entry.missing = missing;
	if (typeof rec.cells === 'number') entry.cells = rec.cells;
	if (typeof rec.solveMs === 'number') entry.solveMs = Math.round(rec.solveMs);
	if (caseFilled) entry.caseFilled = caseFilled;
	if (resultView && files.result) entry.resultView = resultView;
	manifest.sims[id] = entry;
	rec.files = files; rec.missing = missing; rec.caseFilled = caseFilled ?? null; rec.ms = Date.now() - t0; rec.pageErrors = errors.slice(0, 8);
	(log.sims as Record<string, unknown>)[id] = rec;
	if (files.geom || files.mesh) done++; else failed++;
	console.log(`${id}: ${Object.entries(files).filter(([, f]) => f).map(([k]) => k).join(' ') || 'none'}${missing.result ? ` (result missing: ${missing.result.slice(0, 100)})` : ''} ${rec.ms} ms`);
	// manifest after every sim: an interrupted run keeps what it made (resumable)
	manifest.sims = Object.fromEntries(Object.entries(manifest.sims).sort(([a], [b]) => a.localeCompare(b)));
	await writeFile(manifestFile, JSON.stringify(manifest, null, 1) + '\n');
}

await browser.close();
server.close();
log.summary = { captured: done, skipped, failed, total: todo.length };
await writeFile(logFile, JSON.stringify(log, null, 1));
console.log(`captured ${done}, skipped ${skipped}, failed ${failed} of ${todo.length}; log ${logFile.slice(repo.length)}`);
