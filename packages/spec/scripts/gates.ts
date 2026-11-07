// SPDX-License-Identifier: GPL-3.0-or-later
// DevLog-003 gates: per-example parse+validate time, JSON Schema size, gate 3a (N raw random sequences with reverts
// and branches, then undo-all byte-identical, chain, replay) and gate 3b (N valid-to-valid schema-aware sequences). Writes logs/L2-gates-<ts>.{log,json}.
// Usage: nice -n 10 node --max-old-space-size=1536 scripts/gates.ts [sequences=1000] [seed=20261106]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { parseSpecText } from '../src/yaml.ts';
import { specJsonSchema } from '../src/schema.ts';
import { wave1Registry } from '../src/provisional/wave1.ts';
import { createOpLog, replayJSONL, verifyChain } from '../src/oplog.ts';
import { stats } from '../src/yaml-edit.mjs';
import { isoNow, probePlatform } from '../src/run-record.ts';
import { mulberry32, randomPatch, validEdit } from '../test/random-ops.ts';

const N = Number(process.argv[2] ?? 1000);
const SEED = Number(process.argv[3] ?? 20261106);
const ROOT = new URL('../../../', import.meta.url);
const HEROES = ['kirsch-plate', 'heat-plate-fin', 'helmholtz-coil', 'si-rib-waveguide', 'cylinder-cavity', 'box-acoustics'];
const reg = wave1Registry();
const lines: string[] = [];
const say = (s: string) => { const l = `${isoNow()} ${s}`; lines.push(l); console.log(l); };
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] as number; };

say(`L2 gates: sequences ${N}, seed ${SEED}, platform ${JSON.stringify(probePlatform())}`);

// ---- JSON Schema size ------------------------------------------------------------------------------------------
const t0 = performance.now();
const js = specJsonSchema(wave1Registry());
const tSchema = performance.now() - t0;
const min = JSON.stringify(js), pretty = JSON.stringify(js, null, 2);
const defs = Object.keys((js as { $defs?: object }).$defs ?? {}).length;
const SCHEMA_BUDGET = 41053; // minified size audited 2026-11-06 (audit S6): the schema must not grow past it unnoticed
say(`JSON Schema size budget ${SCHEMA_BUDGET} B: ${min.length <= SCHEMA_BUDGET ? 'pass' : 'FAIL'}`);
say(`JSON Schema (wave-1 registry): ${min.length} B minified, ${pretty.length} B pretty, ${pretty.split('\n').length} lines, ${defs} $defs, built in ${tSchema.toFixed(1)} ms (cold)`);

// ---- parse + validate per example --------------------------------------------------------------------------------
const perExample: Record<string, { bytes: number; median_ms: number; min_ms: number; ok: boolean }> = {};
for (const id of HEROES) {
  const text = readFileSync(new URL(`sims/${id}.yaml`, ROOT), 'utf8');
  for (let w = 0; w < 5; w++) parseSpecText(text, reg);
  const ts: number[] = [];
  let ok = true;
  for (let k = 0; k < 50; k++) {
    const a = performance.now();
    ok = parseSpecText(text, reg).ok && ok;
    ts.push(performance.now() - a);
  }
  perExample[id] = { bytes: text.length, median_ms: median(ts), min_ms: Math.min(...ts), ok };
  say(`parse+validate ${id}: ok ${ok}, ${text.length} B, median ${median(ts).toFixed(3)} ms, min ${Math.min(...ts).toFixed(3)} ms (50 runs after 5 warm-up)`);
}

// ---- gate 3a: raw random patches, mixed with undo/redo (branches) and reverts ---------------------------------------
const r = mulberry32(SEED);
const kinds: Record<string, number> = {};
let ops = 0, patchOps = 0, failures = 0, invalid = 0, replays = 0, reverts = 0, conflicts = 0, branches = 0;
stats.splice = 0; stats.fallback = 0;
const user = { actor: 'user' as const };

/** Revert a random op; on conflict the text must be unchanged. */
async function tryRevert(log: Awaited<ReturnType<typeof createOpLog>>): Promise<void> {
  const seqs = log.ops.filter((o) => log.effectOf(o.seq) === 'applied' && o.kind !== 'redo').map((o) => o.seq);
  if (!seqs.length) return;
  const seq = seqs[Math.floor(r() * seqs.length)]!;
  const before = log.text, n = log.ops.length;
  try { await log.revert(seq, user); reverts++; } catch (e) {
    if (log.text !== before || log.ops.length !== n) throw new Error(`revert ${seq} failed but changed the log: ${(e as Error).message}`);
    conflicts++;
  }
}

const tR = performance.now();
for (let s = 0; s < N; s++) {
  const src = readFileSync(new URL(`sims/${HEROES[s % HEROES.length]}.yaml`, ROOT), 'utf8');
  const log = await createOpLog(src, { registry: reg });
  const n = 1 + Math.floor(r() * 8);
  try {
    for (let i = 0; i < n; i++) {
      const u = r();
      if (u < 0.1) { await tryRevert(log); continue; }
      if (u < 0.15 && log.canUndo) { await log.undo(user); if (r() < 0.5) branches++; else await log.redo(user); continue; }
      const p = randomPatch(r, log.data, 3);
      for (const op of p) kinds[op.op] = (kinds[op.op] ?? 0) + 1;
      patchOps += p.length;
      const o = await log.apply(p, { actor: 'agent:gate', reason: `random sequence ${s} op ${i}` });
      if (!o.validation.ok) invalid++;
      ops++;
    }
    const top = log.text;
    const redoable = log.canRedo;
    while (log.canUndo) await log.undo(user);
    if (log.text !== src) throw new Error('undo-all text differs from the original');
    while (log.canRedo) await log.redo(user);
    if (log.text !== top && !redoable) throw new Error('redo-all text differs from the pre-undo text');
    const v = await verifyChain(log.genesis, log.ops);
    if (!v.ok) throw new Error(`chain: ${v.errors.join('; ')}`);
    if (s % 10 === 0) {
      const re = await replayJSONL(log.toJSONL(), { expectHead: log.head });
      if (!re.ok || re.log!.text !== log.text) throw new Error(`replay: ${re.errors.join('; ')}`);
      replays++;
    }
  } catch (e) {
    failures++;
    say(`FAIL 3a sequence ${s}: ${(e as Error).message}`);
  }
}
const tRand = performance.now() - tR;
const totalSteps = stats.splice + stats.fallback;
say(`3a raw random: ${N} sequences, edits ${ops} (${patchOps} patch ops: ${JSON.stringify(kinds)}), results not validating ${invalid}; reverts ${reverts} applied, ${conflicts} refused (text unchanged); undo-without-redo branches ${branches}; failures ${failures}`);
say(`3a undo-all byte-identical + redo-all + chain valid: ${N - failures}/${N}; JSONL replays (with expectHead) ${replays}`);
say(`3a splice steps: ${stats.splice} verified splices, ${stats.fallback} printer fallbacks (${totalSteps ? ((100 * stats.fallback) / totalSteps).toFixed(2) : 0} %); wall ${(tRand / 1000).toFixed(1)} s`);

// ---- gate 3b: valid-to-valid schema-aware edits, reverts, branches; replay recomputes validation ------------------
let vEdits = 0, vInvalid = 0, vFail = 0, vReplays = 0;
const reverts0 = reverts, conflicts0 = conflicts, branches0 = branches;
stats.splice = 0; stats.fallback = 0;
const tV = performance.now();
for (let s = 0; s < N; s++) {
  const src = readFileSync(new URL(`sims/${HEROES[s % HEROES.length]}.yaml`, ROOT), 'utf8');
  const log = await createOpLog(src, { registry: reg });
  const n = 1 + Math.floor(r() * 10);
  try {
    for (let i = 0; i < n; i++) {
      const u = r();
      if (u < 0.12) { await tryRevert(log); continue; }
      if (u < 0.2 && log.canUndo) { await log.undo(user); if (r() < 0.5) branches++; else await log.redo(user); continue; }
      const p = validEdit(r, log.data as Record<string, unknown>, s * 100 + i);
      const o = await log.apply(p, { actor: 'agent:gate', reason: `valid edit ${s}.${i}` });
      vEdits++;
      if (!o.validation.ok) { vInvalid++; say(`3b invalid result ${s}.${i}: ${JSON.stringify(p)} -> ${o.validation.errors[0]}`); }
    }
    while (log.canUndo) await log.undo(user);
    if (log.text !== src) throw new Error('undo-all text differs from the original');
    const v = await verifyChain(log.genesis, log.ops);
    if (!v.ok) throw new Error(`chain: ${v.errors.join('; ')}`);
    if (s % 10 === 0) {
      const re = await replayJSONL(log.toJSONL(), { registry: reg, expectHead: log.head });
      if (!re.ok) throw new Error(`replay: ${re.errors.join('; ')}`);
      vReplays++;
    }
  } catch (e) {
    vFail++;
    say(`FAIL 3b sequence ${s}: ${(e as Error).message}`);
  }
}
const tValid = performance.now() - tV;
say(`3b valid-to-valid: ${N} sequences, edits ${vEdits}, results not validating ${vInvalid}; reverts ${reverts - reverts0} applied, ${conflicts - conflicts0} refused (text unchanged); branches ${branches - branches0}; failures ${vFail}`);
say(`3b undo-all byte-identical + chain valid: ${N - vFail}/${N}; replays with recomputed validation ${vReplays}; splices ${stats.splice}, fallbacks ${stats.fallback}; wall ${(tValid / 1000).toFixed(1)} s`);
failures += vFail + vInvalid + (min.length <= SCHEMA_BUDGET ? 0 : 1);

const stamp = isoNow().replace(/[-:]/g, '').replace(/\.\d+.*$/, '');
const dir = new URL('logs/', ROOT);
mkdirSync(dir, { recursive: true });
writeFileSync(new URL(`L2-gates-${stamp}.log`, dir), lines.join('\n') + '\n');
writeFileSync(new URL(`L2-gates-${stamp}.json`, dir), JSON.stringify({ seed: SEED, sequences: N, schema: { minified_bytes: min.length, pretty_bytes: pretty.length, defs, build_ms: tSchema }, perExample, random: { edits: ops, patchOps, kinds, invalid, failures, replays, wall_s: tRand / 1000 }, valid: { edits: vEdits, invalid: vInvalid, failures: vFail, replays: vReplays, wall_s: tValid / 1000 }, reverts, conflicts, branches }, null, 2));
say(`wrote logs/L2-gates-${stamp}.log and .json`);
process.exit(failures ? 1 : 0);
