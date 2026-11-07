// SPDX-License-Identifier: GPL-3.0-or-later
// C8 extract kind 'result' (lane R3, DevLog-028): an eval target names an evaluation item of the spec's results; the
// engine worker evaluates it with the web app's results adapter (@amp/post kernels) on each level. Real engine: a
// throw-away root that links the repo's packages/ and apps/ and holds one case on sims/kirsch-plate.yaml.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from '../src/cli.ts';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));

// kt of sims/kirsch-plate.yaml at its own mesh (10810 DOF): 3.021233775361685, logs/R0-kt-gate-20261106T231123.json
const CASE = (node: string, unit = '"1"') => `schema: amp-eval/0
id: XR-01
class: a
title: results node extract (test)
status: unvalidated
physics: [solid-linear]
dimension: 2D
units: SI
spec: sims/kirsch-plate.yaml
references:
  - quantity: K_t from the evaluation item kt
    metric_id: kt
    value: 3.021233775361685
    unit: ${unit}
    tolerance: {rel: 1.0e-15, after: finest}
    basis: D
    form: solver_ref
    provenance: {citation: "lane R0 kt gate", locator: logs/R0-kt-gate-20261106T231123.json, accessed: 2026-11-06}
    extract: {kind: result, node: ${node}}
convergence: {levels_min: 1, ratio_min: 1.5, method: none, h_factors: [1]}
rights: {source_license: synthetic, allowed: [cite_values], forbidden: []}
`;

async function runCase(text: string) {
  const root = mkdtempSync(join(tmpdir(), 'amp-r3-'));
  try {
    symlinkSync(join(REPO, 'packages'), join(root, 'packages'));
    symlinkSync(join(REPO, 'apps'), join(root, 'apps'));
    mkdirSync(join(root, 'sims')); mkdirSync(join(root, 'eval', 'cases', 'a'), { recursive: true });
    cpSync(join(REPO, 'sims', 'kirsch-plate.yaml'), join(root, 'sims', 'kirsch-plate.yaml'));
    cpSync(join(REPO, 'eval', 'schema'), join(root, 'eval', 'schema'), { recursive: true });
    cpSync(join(REPO, 'materials'), join(root, 'materials'), { recursive: true });
    writeFileSync(join(root, 'eval', 'cases', 'a', 'XR-01.yaml'), text);
    let buf = '', err = '';
    const code = await main(['--root', root, '--no-log', '--json', '--timeout', '120'], { out: (s) => { buf += s; }, err: (s) => { err += s; } });
    return { code, out: JSON.parse(buf) as { results: Array<{ status: string; reason?: string; targets: Array<{ status: string; value?: unknown; reason?: string }> }> }, err };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("extract kind 'result': kirsch kt through the results adapter equals the R0 value", async () => {
  const { out, err } = await runCase(CASE('kt'));
  const t = out.results[0]!.targets[0]!;
  assert.equal(t.status, 'pass', `${JSON.stringify(out.results[0])} ${err}`);
  assert.equal(t.value, 3.021233775361685);
});

test("extract kind 'result': an unknown node is an error, not a value", async () => {
  const { out } = await runCase(CASE('nope'));
  const t = out.results[0]!.targets[0]!;
  assert.notEqual(t.status, 'pass');
  assert.match(JSON.stringify(out.results[0]), /results node 'nope'/);
});
