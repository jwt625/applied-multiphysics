// SPDX-License-Identifier: GPL-3.0-or-later
// Engine path robustness (audit B1-B3, S4): worker isolation, timeouts, heap cap, broken imports, metric_id lookup,
// run-record validation. Each case uses a throw-away root with a mock @amp/physics.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { main } from '../src/cli.ts';
import { caseYaml, makeRoot, MOCK_PHYSICS } from './helpers.ts';

type Out = { exit: number; results: Array<{ case: string; status: string; reason?: string; targets: Array<{ status: string; reason?: string }> }> };
async function run(args: string[]): Promise<{ code: number; out: Out; err: string }> {
  let buf = '', err = '';
  const code = await main([...args, '--json'], { out: (s) => { buf += s; }, err: (s) => { err += s; } });
  return { code, out: JSON.parse(buf) as Out, err };
}
const withRun = (body: string) => MOCK_PHYSICS.replace(/async run\(ctx\) \{[\s\S]*?\n  \},\n\}\];/, `async run(ctx) {\n${body}\n  },\n}];`);

test('B1: a never-settling promise ends as error, exit 1', async () => {
  const fx = makeRoot({ physicsSrc: withRun('    return new Promise(() => {});') });
  try {
    fx.write('eval/cases/a/XX-01.yaml', caseYaml());
    const { code, out } = await run(['--root', fx.root, '--no-log', '--timeout', '20']);
    assert.equal(code, 1); assert.equal(out.results[0]!.status, 'error'); assert.match(out.results[0]!.reason!, /without a result/);
  } finally { fx.cleanup(); }
});

test('B1: a busy loop and a timer hang end as timeout, exit 1, with a log line', async () => {
  for (const body of ['    for (;;) {}', '    setInterval(() => {}, 1000); return new Promise(() => {});']) {
    const fx = makeRoot({ physicsSrc: withRun(body) });
    try {
      fx.write('eval/cases/a/XX-01.yaml', caseYaml());
      const t0 = Date.now();
      const { code, out, err } = await run(['--root', fx.root, '--out', fx.out, '--timeout', '1.5']);
      assert.equal(code, 1); assert.equal(out.results[0]!.status, 'timeout');
      assert.ok(Date.now() - t0 < 10_000);
      assert.equal(out.results[0]!.targets[0]!.status, 'timeout');
      assert.ok(readdirSync(fx.out).some((f) => f.endsWith('.jsonl')));
      void err;
    } finally { fx.cleanup(); }
  }
});

test('B1: the heap cap stops a runaway allocation (error, exit 1)', async () => {
  const fx = makeRoot({ physicsSrc: withRun('    const a = []; for (;;) a.push(new Array(1e5).fill(Math.random()));') });
  try {
    fx.write('eval/cases/a/XX-01.yaml', caseYaml());
    const { code, out } = await run(['--root', fx.root, '--no-log', '--max-mem', '64', '--timeout', '60']);
    assert.equal(code, 1); assert.equal(out.results[0]!.status, 'error'); assert.match(out.results[0]!.reason!, /out of memory|heap/i);
  } finally { fx.cleanup(); }
});

test('B2: a broken @amp/physics import is an error (exit 1), also in a dry run', async () => {
  const fx = makeRoot({ physicsSrc: 'export const modules = [ ;' });
  try {
    fx.write('eval/cases/a/XX-01.yaml', caseYaml());
    for (const extra of [[], ['--dry-run']]) {
      const { code, out } = await run(['--root', fx.root, '--no-log', ...extra]);
      assert.equal(code, 1); assert.equal(out.results[0]!.status, 'error'); assert.match(out.results[0]!.reason!, /engine load failed/);
    }
  } finally { fx.cleanup(); }
});

test('B3: lookup by metric_id only; a missing metric is pending; --strict turns gated pending into exit 1', async () => {
  const fx = makeRoot();
  try {
    fx.write('eval/cases/a/XX-01.yaml', caseYaml({ metricId: 'q_missing' }));
    const a = await run(['--root', fx.root, '--no-log']);
    assert.equal(a.code, 0); assert.equal(a.out.results[0]!.targets[0]!.status, 'pending');
    assert.match(a.out.results[0]!.targets[0]!.reason!, /produced no metric 'q_missing' \(has: q\)/);
    assert.equal((await run(['--root', fx.root, '--no-log', '--strict'])).code, 1);
  } finally { fx.cleanup(); }
});

test('S4: an empty run record makes the case an error', async () => {
  const fx = makeRoot({ physicsSrc: MOCK_PHYSICS.replace(/run: \{ engine:[^\n]*\n/, "run: {},\n") });
  try {
    fx.write('eval/cases/a/XX-01.yaml', caseYaml());
    const { code, out } = await run(['--root', fx.root, '--no-log']);
    assert.equal(code, 1); assert.match(out.results[0]!.reason!, /run record invalid/);
  } finally { fx.cleanup(); }
});

test('B5: prepareRun(spec, caseCtx) two-parameter form is supported', async () => {
  const fx = makeRoot({ physicsSrc: MOCK_PHYSICS.replace('export async function prepareRun({ spec, hFactor, signal }) {', 'export async function prepareRun(spec, { hFactor, signal }) {') });
  try {
    fx.write('eval/cases/a/XX-01.yaml', caseYaml());
    const { code, out } = await run(['--root', fx.root, '--no-log']);
    assert.equal(code, 0); assert.equal(out.results[0]!.status, 'pass');
  } finally { fx.cleanup(); }
});

test('M1: two runs in the same second keep both result files', async () => {
  const fx = makeRoot();
  try {
    fx.write('eval/cases/a/XX-01.yaml', caseYaml());
    await run(['--root', fx.root, '--out', fx.out, '--adapter', 'expected']);
    await run(['--root', fx.root, '--out', fx.out, '--adapter', 'expected']);
    const j = readdirSync(fx.out).filter((f) => f.endsWith('.jsonl'));
    assert.ok(j.length >= 2, j.join(','));
  } finally { fx.cleanup(); }
});

test('B5: field targets sample through @amp/post sample(solution, field, points, {mesh}) with the level mesh', async () => {
  const phys = MOCK_PHYSICS.replace("meshHash: 'm' + h, fields: [],", "meshHash: 'm' + h, fields: [{ name: 'u', unit: '1', space: 'H1P1', components: 1, data: new Float64Array(1) }],");
  const fx = makeRoot({ physicsSrc: phys });
  try {
    fx.write('packages/post/package.json', JSON.stringify({ name: '@amp/post', version: '0.0.0-mock', type: 'module', exports: { '.': './src/index.mjs' } }));
    fx.write('packages/post/src/index.mjs', 'export function sample(sol, field, points, o = {}) { if (!o.mesh) throw new Error("no mesh"); return Float64Array.from(points, () => 1 + 0.1 * o.mesh.h * o.mesh.h); }');
    fx.write('eval/expected/XX-01.json', JSON.stringify({ case: 'XX-01', generator: 'g', versions: {}, generated_at: '2026-11-06T00:00:00-08:00', targets: [], samples: { u: { points: [[0, 0], [1, 1]], values: [1, 1] } } }));
    fx.write('eval/cases/a/XX-01.yaml', caseYaml({ tol: '{rel: 1.0e-2, norm: max}', refExtra: '\n    extract: {kind: field, field: u, samples_key: samples.u}' }));
    const { code, out } = await run(['--root', fx.root, '--no-log']);
    assert.equal(code, 0, JSON.stringify(out.results[0])); assert.equal(out.results[0]!.status, 'pass');
  } finally { fx.cleanup(); }
});
