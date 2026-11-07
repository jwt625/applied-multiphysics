// SPDX-License-Identifier: GPL-3.0-or-later
// Exit codes 0 / 1 / 2 through the CLI, on throw-away repo roots with a mock @amp/physics.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from '../src/cli.ts';
import { caseYaml, makeRoot } from './helpers.ts';

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), '../src/cli.ts');

async function run(args: string[]): Promise<{ code: number; out: { exit: number; summary: { cases: Record<string, number> }; results: Array<{ case: string; status: string; targets: Array<Record<string, unknown>> }> } }> {
  let buf = '';
  const code = await main([...args, '--json'], { out: (s) => { buf += s; }, err: () => {} });
  return { code, out: JSON.parse(buf) };
}

test('exit 0: engine run passes via Richardson; JSONL + summary written with C8 fields', async () => {
  const fx = makeRoot();
  try {
    fx.write('eval/cases/a/XX-01.yaml', caseYaml());
    const { code, out } = await run(['--root', fx.root, '--out', fx.out]);
    assert.equal(code, 0);
    assert.equal(out.results[0]!.status, 'pass');
    const t = out.results[0]!.targets[0]!;
    assert.ok(Math.abs((t.value as number) - 1) < 1e-12);
    const files = readdirSync(fx.out).sort();
    assert.equal(files.length, 2);
    assert.match(files[0]!, /^eval-\d{8}T\d{6}-summary\.md$/);
    assert.match(files[1]!, /^eval-\d{8}T\d{6}\.jsonl$/);
    const lines = readFileSync(join(fx.out, files[1]!), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const tl = lines.find((l) => l.kind === 'target');
    for (const k of ['case', 'target', 'value', 'ref', 'tol', 'pass', 'time_ms', 'dof', 'run']) assert.ok(k in tl, `C8 field ${k}`);
    assert.equal(tl.run.engine, '@amp/physics@mock');
    assert.match(readFileSync(join(fx.out, files[0]!), 'utf8'), /\| a \| 1 \| 0 \| 0 \| 0 \| 0 \| 1 \|/);
  } finally { fx.cleanup(); }
});

test('exit 2: a gated target missed', async () => {
  const fx = makeRoot();
  try {
    fx.write('eval/cases/a/XX-01.yaml', caseYaml());
    fx.write('eval/cases/a/XX-02.yaml', caseYaml({ id: 'XX-02', ref: 1.5 }));
    const { code, out } = await run(['--root', fx.root, '--out', fx.out]);
    assert.equal(code, 2);
    assert.deepEqual(out.results.map((r) => r.status), ['pass', 'fail']);
  } finally { fx.cleanup(); }
});

test('exit 0: a missed target with gate: false is info only', async () => {
  const fx = makeRoot();
  try {
    fx.write('eval/cases/a/XX-01.yaml', caseYaml({ ref: 1.5, refExtra: '\n    gate: false' }));
    const { code, out } = await run(['--root', fx.root, '--no-log']);
    assert.equal(code, 0);
    assert.equal(out.results[0]!.targets[0]!.status, 'info');
  } finally { fx.cleanup(); }
});

test('exit 1: loader error beats a missed target; --dry-run reports it too', async () => {
  const fx = makeRoot();
  try {
    fx.write('eval/cases/a/XX-01.yaml', caseYaml({ ref: 1.5 }));
    fx.write('eval/cases/a/XX-02.yaml', caseYaml({ id: 'XX-02', extra: 'bogus: 1\n' }));
    assert.equal((await run(['--root', fx.root, '--no-log'])).code, 1);
    assert.equal((await run(['--root', fx.root, '--no-log', '--dry-run'])).code, 1);
    assert.equal((await run(['--root', fx.root, '--no-log', '--dry-run', '--case', 'XX-01'])).code, 0);
  } finally { fx.cleanup(); }
});

test('exit 0 with pending: no physics package, or spec pending', async () => {
  const fx = makeRoot({ physics: false });
  try {
    fx.write('eval/cases/a/XX-01.yaml', caseYaml());
    fx.write('eval/cases/b/XX-03.yaml', caseYaml({ id: 'XX-03', cls: 'b', spec: '{status: pending, reason: "no module"}' }));
    const { code, out } = await run(['--root', fx.root, '--no-log']);
    assert.equal(code, 0);
    assert.deepEqual(out.results.map((r) => r.status), ['pending', 'pending']);
    assert.match(String(out.results[1]!.targets[0]!.reason), /spec pending: no module/);
    const b = await run(['--root', fx.root, '--no-log', '--class', 'b']);
    assert.deepEqual(b.out.results.map((r) => r.case), ['XX-03']);
  } finally { fx.cleanup(); }
});

test('expected adapter: inline value vs generator value (pass and retyping error)', async () => {
  const fx = makeRoot({ physics: false });
  try {
    const meta = { generator: 'validation/a/x.py', versions: {}, generated_at: '2026-11-06T00:00:00-08:00' };
    fx.write('eval/cases/a/XX-01.yaml', caseYaml({ refExtra: '\n    id: q1' }));
    fx.write('eval/expected/XX-01.json', JSON.stringify({ case: 'XX-01', ...meta, targets: [{ metric_id: 'q1', value: 1.0000001 }] }));
    fx.write('eval/cases/a/XX-02.yaml', caseYaml({ id: 'XX-02', refExtra: '\n    id: q1' }));
    fx.write('eval/expected/XX-02.json', JSON.stringify({ case: 'XX-02', ...meta, targets: [{ metric_id: 'q1', value: 1.01 }] }));
    const { code, out } = await run(['--root', fx.root, '--no-log', '--adapter', 'expected']);
    assert.deepEqual(out.results.map((r) => r.status), ['pass', 'fail']);
    assert.equal(code, 2);
  } finally { fx.cleanup(); }
});

test('usage errors exit 1; real process exit codes', () => {
  const fx = makeRoot();
  try {
    fx.write('eval/cases/a/XX-01.yaml', caseYaml({ ref: 1.5 }));
    const node = (args: string[]) => spawnSync(process.execPath, ['--no-warnings', '--max-old-space-size=256', CLI, ...args], { encoding: 'utf8' }).status;
    assert.equal(node(['--bogus']), 1);
    assert.equal(node(['--class', 'z']), 1);
    assert.equal(node(['--root', fx.root, '--case', 'NOPE-01', '--no-log']), 1);
    assert.equal(node(['--root', fx.root, '--no-log']), 2);
    assert.equal(node(['--root', fx.root, '--no-log', '--dry-run']), 0);
  } finally { fx.cleanup(); }
});

test('--speed: warm-up + median of 5 at every level, T_tol against the native budget', async () => {
  const fx = makeRoot();
  try {
    fx.write('eval/cases/a/XX-01.yaml', caseYaml({ tol: '{rel: 1.0e-3}', extra: 'speed: {budget_s: {native: 1.0}}\n' }));
    const { code, out } = await run(['--root', fx.root, '--no-log', '--speed']);
    assert.equal(code, 0);
    type Sp = { protocol: string; levels: Array<{ samples_ms: number[]; warmup_ms: number[]; dof: number }>; meets_budget: boolean | null; t_tol_ms: number | null; time_to_accuracy: Record<string, { reached: boolean; level: number }> };
    const sp = (out.results[0] as unknown as { speed: Sp }).speed;
    assert.equal(sp.protocol, 'warmup1_median5_per_level');
    assert.equal(sp.levels.length, 3);
    for (const l of sp.levels) { assert.equal(l.samples_ms.length, 5); assert.equal(l.warmup_ms.length, 1); }
    assert.equal(sp.levels[2]!.dof, 1600); assert.equal(sp.meets_budget, true); assert.ok(typeof sp.t_tol_ms === 'number');
    // q(h) - 1 = 0.1 h^2 with h = 0.1, 0.05, 0.025: 1e-3, 2.5e-4, 6.25e-5 vs budget 1e-3 -> level 0 already meets it
    assert.equal(sp.time_to_accuracy.q!.reached, true); assert.equal(sp.time_to_accuracy.q!.level, 0);
    // no native budget: the speed check is pending, not a pass
    fx.write('eval/cases/a/XX-01.yaml', caseYaml({ tol: '{rel: 1.0e-3}', extra: 'speed: {budget_s: {browser: 1.0}}\n' }));
    const b = await run(['--root', fx.root, '--no-log', '--speed']);
    const sb = (b.out.results[0] as unknown as { speed: Sp & { budget_note: string } }).speed;
    assert.equal(sb.meets_budget, null); assert.match(sb.budget_note, /no budget_s.native/);
  } finally { fx.cleanup(); }
});

test('python adapter output parsing', async () => {
  const { parsePyOutput } = await import('../src/adapters/python.ts');
  assert.deepEqual(parsePyOutput('log line\n{"targets": {"q": {"value": 1}}}\n'), { targets: { q: { value: 1 } } });
  assert.deepEqual(parsePyOutput('{"targets": {}}'), { targets: {} });
  assert.throws(() => parsePyOutput(''));
});

test('unit conversion through the @amp/spec units API (affine degC, prefixes, dimension mismatch)', async () => {
  const { convertUnit, setUnitsApi } = await import('../src/registry.ts');
  setUnitsApi(null);
  assert.deepEqual(convertUnit(2, '1', 'dimensionless'), { value: 2 });
  assert.ok('error' in convertUnit(300, 'K', 'degC'));
  setUnitsApi({
    parseUnit: (u: string) => (u === 'degC' ? { dim: [0, 0, 0, 0, 1], factor: 1, offset: 273.15 } : u === 'K' ? { dim: [0, 0, 0, 0, 1], factor: 1, offset: 0 } : u === 'mm' ? { dim: [1, 0, 0, 0, 0], factor: 1e-3, offset: 0 } : { dim: [1, 0, 0, 0, 0], factor: 1, offset: 0 }),
    dimEq: (a: readonly number[], b: readonly number[]) => a.every((x, i) => x === b[i]),
  });
  const k = convertUnit(373.15, 'K', 'degC') as { value: number };
  assert.ok(Math.abs(k.value - 100) < 1e-12);
  assert.ok(Math.abs((convertUnit(0.0025, 'm', 'mm') as { value: number }).value - 2.5) < 1e-12);
  assert.ok('error' in convertUnit(1, 'K', 'm'));
  setUnitsApi(null);
});

