#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// amp-eval CLI. Exit codes: 0 pass (pending allowed), 1 error (loader, run, usage), 2 a gated target missed.
//   node packages/eval/src/cli.ts [--class a|b|c] [--case ID] [--tag physics] [--dry-run] [--speed] [--json]
//                                 [--adapter engine|expected|python] [--fields python|ts] [--bench bp1|bp3 [--sizes 8,16,32]]
//                                 [--root DIR] [--out DIR] [--no-log]

import { writeFileSync } from 'node:fs';
import { cpus, totalmem, platform, arch, release } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { formatIssue } from './loader.ts';
import { REPO_ROOT, isoWithOffset, loadCases, logsDir, repoCommit, timestampStamp, writeUnique } from './node-io.ts';
import { EngineSource, loadDefaultRegistry } from './registry.ts';
import { ExpectedSource } from './adapters/expected.ts';
import { PythonSource } from './adapters/python.ts';
import { exitCode, runCases } from './runner.ts';
import { summarize, toJsonl, toMarkdown, type RunMeta } from './report.ts';
import type { Source } from './source.ts';
import { importWorkspace } from './workspace.ts';

const HARNESS_VERSION = '0.0.0';

const USAGE = `usage: node packages/eval/src/cli.ts [--class a|b|c] [--case ID] [--tag physics] [--dry-run] [--speed] [--json]
       [--adapter engine|expected|python] [--fields python|ts] [--bench bp1|bp3 [--sizes 8,16,32]] [--root DIR] [--out DIR] [--no-log]
exit: 0 pass (pending allowed unless --strict), 1 error / timeout / engine load failure, 2 target missed`;

export interface CliIO { out: (s: string) => void; err: (s: string) => void }
const STDIO: CliIO = { out: (s) => { process.stdout.write(s); }, err: (s) => { process.stderr.write(s); } };

export async function main(argv: string[], io: CliIO = STDIO): Promise<number> {
  let a;
  try {
    a = parseArgs({
      args: argv, allowPositionals: false, strict: true,
      options: {
        class: { type: 'string' }, case: { type: 'string' }, tag: { type: 'string' },
        'dry-run': { type: 'boolean' }, speed: { type: 'boolean' }, json: { type: 'boolean' },
        adapter: { type: 'string' }, fields: { type: 'string' }, timeout: { type: 'string' }, 'timeout-cap': { type: 'string' }, 'max-mem': { type: 'string' }, strict: { type: 'boolean' }, bench: { type: 'string' }, sizes: { type: 'string' },
        root: { type: 'string' }, out: { type: 'string' }, 'no-log': { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
      },
    }).values;
  } catch (e) {
    io.err(`${(e as Error).message}\n${USAGE}\n`);
    return 1;
  }
  if (a.help) { io.out(`${USAGE}\n`); return 0; }
  if (a.class !== undefined && !['a', 'b', 'c'].includes(a.class)) { io.err(`--class must be a, b or c\n${USAGE}\n`); return 1; }
  const adapter = a.adapter ?? 'engine';
  if (!['engine', 'expected', 'python'].includes(adapter)) { io.err(`--adapter must be engine, expected or python\n`); return 1; }
  const root = a.root ? resolve(a.root) : REPO_ROOT;
  const outDir = a.out ? resolve(a.out) : null;
  const log = (m: string) => { if (!a.json) io.err(`${isoWithOffset()} ${m}\n`); };

  if (a.bench) {
    const { runBench } = await import('../bench/poisson.ts');
    return runBench({ io, kind: a.bench, sizes: a.sizes, root, outDir: outDir ?? logsDir(root), json: !!a.json, noLog: !!a['no-log'], log });
  }

  const started = new Date();
  const filter = { ...(a.class ? { class: a.class } : {}), ...(a.case ? { caseId: a.case } : {}), ...(a.tag ? { tag: a.tag } : {}) };
  let cases;
  try { cases = loadCases(filter, root); } catch (e) { io.err(`load failed: ${(e as Error).message}\n`); return 1; }
  if (a.case && cases.length === 0) { io.err(`no case '${a.case}' under ${relative(process.cwd(), join(root, 'eval/cases')) || '.'}\n`); return 1; }

  const numOpt = (k: 'timeout' | 'timeout-cap' | 'max-mem') => { const v = a[k]; if (v === undefined) return undefined; const x = Number(v); if (!(x > 0)) throw new Error(`--${k} must be a positive number`); return x; };
  let eo;
  try { eo = { ...(numOpt('timeout') !== undefined ? { timeoutS: numOpt('timeout')! } : {}), ...(numOpt('timeout-cap') !== undefined ? { timeoutCapS: numOpt('timeout-cap')! } : {}), ...(numOpt('max-mem') !== undefined ? { maxOldMb: numOpt('max-mem')! } : {}) }; }
  catch (e) { io.err(`${(e as Error).message}\n`); return 1; }
  let source: Source;
  if (adapter === 'expected') source = new ExpectedSource();
  else if (adapter === 'python') source = new PythonSource(root);
  else {
    const { registry, reason } = await loadDefaultRegistry(root);
    if (registry.loadError) log(`ERROR engine load failed: ${registry.loadError}`);
    source = new EngineSource(registry, reason, root, eo);
  }
  log(`${cases.length} case(s); ${source.describe()}`);
  for (const lc of cases) for (const i of lc.issues) log(formatIssue(i));

  if (a.fields !== undefined && a.fields !== 'python' && a.fields !== 'ts') { io.err('--fields must be python or ts\n'); return 1; }
  const exactField = a.fields === 'ts' ? (await import('./fields/index.ts')).evaluateExactFieldTs : undefined;
  const results = await runCases(cases, source, { dryRun: !!a['dry-run'], speed: !!a.speed, log, ...(exactField ? { exactField } : {}) });
  // C5 platform probe from @amp/spec (run-record.ts) when loadable; Node details added here
  const sp = await importWorkspace<{ probePlatform?: () => Record<string, unknown> }>('@amp/spec', root);
  const specPlatform = sp.mod?.probePlatform?.() ?? {};
  const meta: RunMeta = {
    schema: 'amp-eval-run/0', started_at: isoWithOffset(started), finished_at: isoWithOffset(),
    harness: `@amp/eval@${HARNESS_VERSION}+${repoCommit(root)}`, source: source.name, source_detail: source.describe(),
    filter, dry_run: !!a['dry-run'], speed: !!a.speed,
    platform: { ...specPlatform, runtime: 'node', node: process.version, os: `${platform()} ${release()}`, arch: arch(), cores: cpus().length, cpu: cpus()[0]?.model ?? 'unknown', mem_gb: Math.round(totalmem() / 2 ** 30) },
  };
  const code = exitCode(results, { strict: !!a.strict });
  const stamp = timestampStamp(started);
  let jsonlPath: string | null = null;
  if (!a['no-log']) {
    const dir = outDir ?? logsDir(root);
    const [jp, mp] = writeUnique(dir, `eval-${stamp}`, [{ suffix: '.jsonl', text: '' }, { suffix: '-summary.md', text: '' }]);
    jsonlPath = jp!;
    const name = jp!.split(/[\\/]/).pop()!;
    writeFileSync(jp!, toJsonl(meta, results));
    writeFileSync(mp!, toMarkdown(meta, results, name));
  }
  const s = summarize(results);
  if (a.json) {
    io.out(JSON.stringify({ meta, exit: code, summary: s, jsonl: jsonlPath, results }, (_k, v) => (ArrayBuffer.isView(v) ? Array.from(v as unknown as ArrayLike<number>) : v)) + '\n');
  } else {
    for (const r of results) {
      const tline = r.targets.map((t) => `${t.target}=${t.status}`).join(' ');
      io.out(`${r.status.padEnd(7)} ${r.case.padEnd(10)} ${tline}${r.reason ? `  | ${r.reason}` : ''}\n`);
    }
    io.out(`cases: ${s.cases.pass} pass, ${s.cases.fail} fail, ${s.cases.pending} pending, ${s.cases.error} error, ${s.cases.timeout} timeout; targets: ${s.targets.pass} pass, ${s.targets.fail} fail, ${s.targets.pending} pending, ${s.targets.error} error, ${s.targets.info} info, ${s.targets.timeout} timeout; loader: ${s.loader_errors} errors, ${s.loader_warnings} warnings\n`);
    if (jsonlPath) io.out(`records: ${relative(process.cwd(), jsonlPath)}\n`);
    io.out(`exit ${code}\n`);
  }
  return code;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // audit B1: exit 1 unless main() completes (a drained event loop must not look like a pass)
  process.exitCode = 1;
  main(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (e) => { process.stderr.write(`${(e as Error).stack ?? e}\n`); process.exitCode = 1; });
}
