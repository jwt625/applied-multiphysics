// SPDX-License-Identifier: GPL-3.0-or-later
// Generator of test/fixtures/detmath-xplat.json: SHA-256 of the output bits of detmath, @amp/core/expr and Math on the
// fixed inputs of test/helpers/detmath-xplat.mjs, computed in headless Chromium (the same source files, types stripped
// by node:module and served through Playwright request interception, as packages/mesh/test/xplat.test.ts) and in Node.
// The test checks that Node reproduces the Chromium digests of detmath and expr. The Math digests are recorded to show
// that the fixture bites (they differ between the two engines).
// Usage (from packages/core): node test/fixtures/gen-detmath-xplat.mjs [--browser <chromium executable>]
//   playwright-core is taken from packages/mesh (its devDependency); browser: --browser, $AMP_BROWSER, the cached
//   Playwright headless shell 1234, or system Google Chrome.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import * as D from '../../src/detmath.ts';
import { compileExpression } from '../../src/expr.mjs';
import { DIMLESS } from '../../src/units.mjs';
import { evaluate, inputs } from '../helpers/detmath-xplat.mjs';

const root = new URL('../../', import.meta.url); // packages/core/
const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
const browserPaths = [...new Set([arg('browser'), process.env.AMP_BROWSER,
  `${homedir()}/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell`,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter((p) => p && existsSync(p)))];
if (!browserPaths.length) throw new Error('no Chromium binary (give --browser or AMP_BROWSER)');
const { chromium } = createRequire(fileURLToPath(new URL('../mesh/package.json', root)))('playwright-core');

const sha = (s) => createHash('sha256').update(s).digest('hex');
const digests = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, sha(v)]));
const node = digests(evaluate(D, compileExpression, DIMLESS));

const runs = [];
for (const browserPath of browserPaths) {
const browser = await chromium.launch({ headless: true, executablePath: browserPath });
let web, version;
try {
  const page = await browser.newPage();
  await page.route('http://amp.test/**', async (route) => {
    const p = new URL(route.request().url()).pathname;
    if (p === '/index.html') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>detmath</title>' });
    let body = readFileSync(new URL(`.${p}`, root), 'utf8');
    if (p.endsWith('.ts')) body = stripTypeScriptTypes(body, { mode: 'strip' });
    return route.fulfill({ contentType: 'text/javascript', body });
  });
  await page.goto('http://amp.test/index.html');
  const raw = await page.evaluate(async () => {
    const [D, E, U, H] = await Promise.all(['/src/detmath.ts', '/src/expr.mjs', '/src/units.mjs', '/test/helpers/detmath-xplat.mjs'].map((u) => import(u)));
    return H.evaluate(D, E.compileExpression, U.DIMLESS);
  });
  web = digests(raw);
  version = await browser.version();
} finally {
  await browser.close();
}
runs.push({ version, digests: web });
}
const I = inputs();
const differ = (a, b) => Object.keys(a).filter((k) => a[k] !== b[k]);
const out = {
  generator: 'packages/core/test/fixtures/gen-detmath-xplat.mjs', generated: new Date().toISOString(),
  inputs: Object.fromEntries(Object.entries(I).map(([k, v]) => [k, v.length])),
  // the test compares Node with chromium[0]; every browser listed agreed on det.* and expr.* at generation
  chromium: runs, node: { version: process.version, digests: node },
  differFromNode: runs.map((r) => ({ version: r.version, keys: differ(r.digests, node) })),
};
writeFileSync(fileURLToPath(new URL('test/fixtures/detmath-xplat.json', root)), JSON.stringify(out, null, 1) + '\n');
for (const d of out.differFromNode) console.log(`Chromium ${d.version} vs Node ${process.version}: differing digests ${d.keys.join(', ') || 'none'}`);
