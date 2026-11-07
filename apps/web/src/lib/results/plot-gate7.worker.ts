// SPDX-License-Identifier: GPL-3.0-or-later
// Gate 7 of DevLog-026 / DevLog-027 (browser side): runs the R1 determinism fixture `gate7Fixture()` of
// packages/post/gates/fixture-r1.ts in a module Web Worker bundled by Vite like the post worker, and posts its SHA-256
// over the little-endian Float64 bytes of the kernel results. The expected Node hash is in fixture-r1.expected.json.
// Started on demand only (`__ampWorkbench.gate7()` in dev / hooks builds); nothing in the app imports it otherwise.
/// <reference lib="webworker" />
type Fixture = { gate7Fixture: () => Promise<{ sha256: string; count: number }> };
const found = import.meta.glob<Fixture>('../../../../../packages/post/gates/fixture-r1.ts');
const expected = import.meta.glob<{ sha256: string; count: number }>('../../../../../packages/post/gates/fixture-r1.expected.json', { import: 'default' });
const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = async () => {
	const t0 = performance.now();
	try {
		const load = Object.values(found)[0], exp = Object.values(expected)[0];
		if (!load || !exp) throw new Error('fixture-r1.ts or fixture-r1.expected.json not found');
		const [mod, want] = await Promise.all([load(), exp()]);
		const r = await mod.gate7Fixture();
		ctx.postMessage({ ok: r.sha256 === want.sha256 && r.count === want.count, sha256: r.sha256, count: r.count, expected: want.sha256, expectedCount: want.count, ms: performance.now() - t0, userAgent: navigator.userAgent });
	} catch (e) {
		ctx.postMessage({ ok: false, error: e instanceof Error ? e.message : String(e) });
	}
};
