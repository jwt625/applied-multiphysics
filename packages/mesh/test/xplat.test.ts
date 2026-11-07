// SPDX-License-Identifier: GPL-3.0-or-later
// Cross-platform determinism (DevLog-004 s.9): the same meshes built in Node and in headless Chromium must have
// identical hashes. The browser runs the same TypeScript sources (types stripped by node:module, served through
// Playwright request interception with an import map), not a bundle. Browser: $AMP_BROWSER, else the cached
// Playwright headless shell, else system Google Chrome; the test is skipped (with the reason) when none exists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { homedir } from 'node:os';
import { parseYaml, resolveParams } from '@amp/spec';
import { makeResolver, featureFromSpec } from '@amp/geom/spec';
import { chromium } from 'playwright-core';
import { hashes, type XInput } from './xplat-entry.ts';

const root = new URL('../../../', import.meta.url);
const browserPath = [
  process.env.AMP_BROWSER,
  `${homedir()}/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell`,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find((p) => p && existsSync(p));

function inputs(): XInput {
  const twoD: XInput['twoD'] = [];
  for (const [name, order] of [['kirsch-plate', 2], ['heat-plate-fin', 2], ['helmholtz-coil', 2], ['si-rib-waveguide', 2]] as const) {
    const data = parseYaml(readFileSync(new URL(`sims/${name}.yaml`, root), 'utf8')).data as any;
    const R = makeResolver(resolveParams(data.params).scope);
    const opts: any = { hmax: R.q(data.mesh.size.hmax), order };
    if (data.mesh.refine) opts.refine = data.mesh.refine.map((r: any) => ({ select: r.select, h: R.q(r.h) }));
    twoD.push({ name, features: data.geometry.features.map((f: any) => featureFromSpec(f, R)), axisym: !!data.geometry.axisym, opts });
  }
  return {
    twoD, cyl: { id: 'cav', radius: 0.0274, height: 0.0548, base: [0, 0, 0], axis: 'z' }, cylH: 0.0274 / 2,
    boxes: [{ id: 'sub', x: [0, 1e-3], y: [0, 1e-3], z: [0, 2e-4] }, { id: 'die', x: [1e-4, 3.7e-4], y: [2e-4, 9e-4], z: [2e-4, 3e-4] }], boxH: 1e-4,
  };
}

test('cross-platform: Node and headless Chromium build bit-identical meshes', { skip: browserPath ? false : 'no Chromium binary found (set AMP_BROWSER)' }, async () => {
  const inp = inputs();
  const node = hashes(inp);
  const browser = await chromium.launch({ headless: true, executablePath: browserPath });
  try {
    const page = await browser.newPage();
    const imports = {
      '@amp/geom': '/packages/geom/src/index.ts',
      'robust-predicates': '/packages/mesh/node_modules/robust-predicates/index.js',
    };
    await page.route('http://amp.test/**', async (route) => {
      const p = new URL(route.request().url()).pathname;
      if (p === '/index.html') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><script type="importmap">${JSON.stringify({ imports })}</script>` });
      let body = readFileSync(new URL(`.${p}`, root), 'utf8');
      if (p.endsWith('.ts')) body = stripTypeScriptTypes(body, { mode: 'strip' });
      return route.fulfill({ contentType: 'text/javascript', body });
    });
    await page.goto('http://amp.test/index.html');
    const web = await page.evaluate(async (x) => {
      const mod = await import('/packages/mesh/test/xplat-entry.ts' as string);
      return mod.hashes(x) as Record<string, string>;
    }, inp as any);
    const version = await browser.version();
    for (const k of Object.keys(node)) assert.equal(web[k], node[k], `${k}: Node ${process.version} vs Chromium ${version}`);
    assert.equal(Object.keys(web).length, Object.keys(node).length);
  } finally {
    await browser.close();
  }
});
