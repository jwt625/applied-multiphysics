// SPDX-License-Identifier: GPL-3.0-or-later
// External Python reference adapter. Runs `uv run --project validation python <script> --case <case.yaml> --json`
// from the repo root (nice 10, BLAS threads 2), reading the same case file as the engine. Protocol (stdout, one JSON
// object, last non-empty line or the whole output):
//   {"targets": {"<target id>": {"value": x} | {"levels": [{"value": x, "dof": n, "h": h, "wall_ms": t}, ...]}
//                              | {"samples": [...]} | {"pending": "why"} | {"error": "why"}},
//    "run": {"engine": "<solver>@<version>", ...}}

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { LoadedCase } from '../loader.ts';
import { targetId } from '../loader.ts';
import type { LevelObservation, TargetObservation } from '../evaluate.ts';
import { REPO_ROOT } from '../node-io.ts';
import { dimOf, type CaseObservation, type ObserveOptions, type Source } from '../source.ts';

export interface PyOutput {
  targets?: Record<string, { value?: unknown; levels?: unknown[]; samples?: unknown; pending?: string; error?: string }>;
  run?: Record<string, unknown>;
}

export function parsePyOutput(stdout: string): PyOutput {
  const t = stdout.trim();
  try { return JSON.parse(t) as PyOutput; } catch { /* fall through to last line */ }
  const lines = t.split('\n').map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1];
  if (last === undefined) throw new Error('empty output');
  return JSON.parse(last) as PyOutput;
}

function toLevel(x: unknown): LevelObservation | null {
  if (!x || typeof x !== 'object') return null;
  const o = x as Record<string, unknown>;
  const v = o.value;
  const ok = typeof v === 'number' || (Array.isArray(v) && v.every((y) => typeof y === 'number'));
  if (!ok) return null;
  return {
    value: v as number | number[],
    ...(typeof o.dof === 'number' ? { dof: o.dof } : {}),
    ...(typeof o.h === 'number' ? { h: o.h } : {}),
    ...(typeof o.wall_ms === 'number' ? { wall_ms: o.wall_ms } : {}),
  };
}

export class PythonSource implements Source {
  name = 'python';
  root: string;
  timeoutMs: number;
  constructor(root = REPO_ROOT, timeoutMs = 600_000) { this.root = root; this.timeoutMs = timeoutMs; }
  describe(): string { return 'python: uv run --project validation python <adapter.python.script> --case <case> --json'; }

  private script(lc: LoadedCase): { script: string; args: string[] } | { reason: string } {
    const py = lc.data?.adapter?.python;
    if (!py) return { reason: 'case has no adapter.python.script' };
    if (!existsSync(join(this.root, py.script))) return { reason: `${py.script} not found` };
    if (!existsSync(join(this.root, 'validation', 'pyproject.toml'))) return { reason: 'validation/pyproject.toml not found' };
    return { script: py.script, args: py.args ?? [] };
  }

  async plan(lc: LoadedCase): Promise<{ runnable: boolean; reason: string }> {
    const s = this.script(lc);
    return 'reason' in s ? { runnable: false, reason: s.reason } : { runnable: true, reason: `uv run ${s.script}` };
  }

  async observe(lc: LoadedCase, opts: ObserveOptions): Promise<CaseObservation> {
    const s = this.script(lc);
    if ('reason' in s) return { kind: 'pending', reason: s.reason };
    const args = ['-n', '10', 'uv', 'run', '--project', 'validation', 'python', s.script, '--case', lc.file, '--json', ...s.args];
    opts.log?.(`${lc.data!.id}: nice ${args.join(' ')}`);
    const res = await new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
      const env = { ...process.env, OMP_NUM_THREADS: '2', OPENBLAS_NUM_THREADS: '2', MKL_NUM_THREADS: '2', VECLIB_MAXIMUM_THREADS: '2' };
      const ch = spawn('nice', args, { cwd: this.root, env, signal: opts.signal ?? AbortSignal.timeout(this.timeoutMs) });
      let out = '', err = '';
      ch.stdout.on('data', (d) => (out += d));
      ch.stderr.on('data', (d) => (err += d));
      ch.on('error', (e) => resolve({ code: -1, out, err: err + String(e) }));
      ch.on('close', (code) => resolve({ code, out, err }));
    });
    if (res.code !== 0) return { kind: 'error', reason: `${s.script} exit ${res.code}: ${res.err.trim().split('\n').slice(-3).join(' | ')}` };
    let po: PyOutput;
    try { po = parsePyOutput(res.out); } catch (e) { return { kind: 'error', reason: `${s.script}: bad JSON output (${(e as Error).message})` }; }
    const targets: Record<string, TargetObservation | { pending: string } | { error: string }> = {};
    for (const r of lc.data!.references) {
      const id = targetId(r);
      const t = po.targets?.[id];
      if (!t) { targets[id] = { pending: `${s.script} returned no value for '${id}'` }; continue; }
      if (t.pending) { targets[id] = { pending: t.pending }; continue; }
      if (t.error) { targets[id] = { error: t.error }; continue; }
      if (Array.isArray(t.samples)) { targets[id] = { levels: [{ value: { values: t.samples as number[] } }] }; continue; }
      const levels = Array.isArray(t.levels) ? t.levels.map(toLevel) : [toLevel({ value: t.value })];
      if (levels.some((l) => l === null)) { targets[id] = { error: `${s.script}: malformed value for '${id}'` }; continue; }
      targets[id] = { levels: levels as LevelObservation[] };
    }
    const dim = dimOf(lc.data!.dimension);
    return { kind: 'observed', targets, run: po.run ?? { engine: `python:${s.script}` }, ...(dim !== undefined ? { dim } : {}) };
  }
}
