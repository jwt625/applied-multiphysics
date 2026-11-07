// SPDX-License-Identifier: GPL-3.0-or-later
// Screenshot review driver of the visual design pass (DevLog-015 s.1.3): opens Play views, RT panels or the workbench
// on a running server (dev or static build), waits for the fresh result (and the full-accuracy sequence when asked),
// optionally touches the canvas once (calm-start animation), and writes PNGs at 1440x900 and 390x844. The agent panel
// stays closed. Also records the full-accuracy sequence per view (levels, DOF, times, estimate) as JSON.
// Usage: node scripts/v1-shots.ts <origin> <outDir> <view,...> [--acc] [--touch] [--only-1440|--only-390]
//   view: play/<sim>, rt/<kernel>, wb/<sim>
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, type Page } from 'playwright-core';

const [origin, out, list] = process.argv.slice(2);
if (!origin || !out || !list) { console.error('usage: v1-shots.ts <origin> <outDir> <view,...> [--acc] [--touch]'); process.exit(2); }
const flags = new Set(process.argv.slice(5));
const SHELL = `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell`;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ts = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
const VIEWS = [{ w: 1440, h: 900, tag: '1440' }, { w: 390, h: 844, tag: '390' }].filter((v) => !(flags.has('--only-1440') && v.w !== 1440) && !(flags.has('--only-390') && v.w !== 390));
await mkdir(out, { recursive: true });

type S = { status?: string; fresh?: boolean; acc?: { status: string; doneAt: number; startedAt: number; levels: Array<{ h: number; dof: number; ms: number; values: number[]; cells: number }>; rich: Array<{ available: boolean; reason?: string; p_obs: number | null; f_ext: number | null; gci_fine: number | null; u_abs: number | null }>; reason: string; conv: unknown } | null };
const sess = (p: Page, hook: string) => p.evaluate((h) => { const s = (window as unknown as Record<string, { session?: S }>)[h]?.session; return s ? { status: s.status, fresh: s.fresh, acc: s.acc ? JSON.parse(JSON.stringify(s.acc)) : null } : null; }, hook);

async function settle(p: Page, hook: string, acc: boolean) {
	await p.waitForFunction((h) => { const s = (window as unknown as Record<string, { session?: S }>)[h]?.session; return !!s && ['solved', 'unavailable', 'error', 'meshed'].includes(s.status ?? '') && (s.status !== 'solved' || !!s.fresh); }, hook, { timeout: 120000 });
	if (acc) await p.waitForFunction((h) => { const a = (window as unknown as Record<string, { session?: S }>)[h]?.session?.acc; return !!a && a.status !== 'running'; }, hook, { timeout: 600000, polling: 250 });
}

const errors: string[] = [];
const record: Record<string, unknown> = { ts, origin };
const gpu = list.split(',').some((v) => v.startsWith('rt/'));
const browser = await chromium.launch(gpu ? { executablePath: CHROME, headless: true, args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan'] } : { executablePath: SHELL, headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
for (const view of list.split(',')) {
	const [kind, id] = view.split('/') as [string, string];
	for (const v of VIEWS) {
		const ctx = await browser.newContext({ viewport: { width: v.w, height: v.h }, deviceScaleFactor: 1, serviceWorkers: 'block' });
		const p = await ctx.newPage();
		p.on('pageerror', (e) => errors.push(`${view} ${v.tag}: ${e.message}`));
		p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`${view} ${v.tag}: console ${m.text()}`); });
		p.on('response', (r) => { if (r.status() >= 400) errors.push(`${view} ${v.tag}: HTTP ${r.status()} ${r.url().replace(origin, '')}`); });
		const url = kind === 'play' ? `${origin}/play/${id}` : kind === 'rt' ? `${origin}/play/rt/${id}` : `${origin}/?sim=${id}`;
		await p.goto(url, { waitUntil: 'load' });
		if (kind === 'play' || kind === 'wb') {
			const hook = kind === 'play' ? '__ampPlay' : '__ampWorkbench';
			await p.waitForFunction((h) => !!(window as unknown as Record<string, { session?: unknown }>)[h]?.session, hook, { timeout: 60000 });
			await settle(p, hook, flags.has('--acc') && kind === 'play');
			if (kind === 'wb') {
				await p.locator('.tb button', { hasText: 'Compute' }).click();
				await p.waitForTimeout(300);
				await settle(p, hook, false);
				await p.evaluate(() => (window as unknown as { __ampWorkbench: { setMode(m: string): void } }).__ampWorkbench.setMode('results'));
			}
			const st = await sess(p, hook);
			if (st?.acc) record[`${view}-${v.tag}`] = st.acc;
		} else await p.waitForTimeout(3000);
		if (flags.has('--touch')) {
			const box = await p.locator('.gfx, .cv canvas').first().boundingBox();
			if (box) await p.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.55);
			await p.waitForTimeout(700);
		}
		await p.waitForTimeout(700);
		const f = `${out}/V1-${kind}-${id}-${v.tag}-${ts}.png`;
		await p.screenshot({ path: f });
		console.log(f);
		await ctx.close();
	}
}
await browser.close();
record.errors = errors;
await writeFile(`${out}/V1-shots-${ts}.json`, JSON.stringify(record, null, 1));
if (errors.length) console.log('errors:\n' + errors.join('\n'));
