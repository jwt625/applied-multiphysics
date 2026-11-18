// SPDX-License-Identifier: GPL-3.0-or-later
// End-to-end timing of hero workloads through @amp/physics prepareRun + runStudy (the eval worker's path), lane S4
// (DevLog-045). One workload per process, so the first run is cold (JIT, WASM compile, geometry and mesh caches empty);
// then --runs warm runs (median reported). Per run: wall, prepare, run, the solution's stage timing, dof, RSS, load
// average, and the time spent in the core factor / triangular-solve calls (prototype wrappers on SparseCholesky and
// SupernodalLDLT, bench only). The last run's scalars and fields are written to --dump DIR for a bitwise / relative
// comparison (--compare A B).
// Usage (repo root):
//   nice -n 10 node --max-old-space-size=1536 packages/core/bench/perf-core-1.mjs --only ac02 [--runs 5] [--dump DIR]
//     [--solve js|wasm] [--levels 1,0.5] [--em3d-h 0.5]
//   node packages/core/bench/perf-core-1.mjs --compare DIR_A DIR_B
// Workloads: ac02 h6 kirsch rib rf21 pzt4 hotarm em3d (see WORKLOADS). One JSONL record per level to
// logs/perf-core-1-<YYYYMMDDTHHMMSS>.jsonl (or --out FILE).
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import os from 'node:os';
import { SparseCholesky } from '../src/la/sparse.mjs';
import { SupernodalLDLT } from '../src/la/ldlt.mjs';
import { setDefaultRealSolve } from '../src/la/wasm/solve-real.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const r4 = (x) => (x == null ? null : +Number(x).toPrecision(4));
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length % 2 ? s[(s.length - 1) / 2] : 0.5 * (s[s.length / 2 - 1] + s[s.length / 2]); };

// ------------------------------------------------------------------------------------------------- compare mode
if (process.argv.includes('--compare')) {
  const i = process.argv.indexOf('--compare');
  const A = process.argv[i + 1], B = process.argv[i + 2];
  let worst = 0, nBit = 0, nTot = 0;
  for (const f of readdirSync(A).filter((x) => x.endsWith('.json')).sort()) {
    if (!existsSync(join(B, f))) { console.log(`${f}: missing in B`); continue; }
    const a = JSON.parse(readFileSync(join(A, f), 'utf8')), b = JSON.parse(readFileSync(join(B, f), 'utf8'));
    const ba = readFileSync(join(A, f.replace(/\.json$/, '.bin'))), bb = readFileSync(join(B, f.replace(/\.json$/, '.bin')));
    const fa = new Float64Array(ba.buffer, ba.byteOffset, ba.byteLength / 8), fb = new Float64Array(bb.buffer, bb.byteOffset, bb.byteLength / 8);
    const out = [];
    for (const [k, v] of Object.entries(a.scalars)) {
      const w = b.scalars[k];
      nTot++;
      if (w === v) { nBit++; continue; }
      const d = Math.abs(Number(w) - Number(v)) / Math.max(Math.abs(Number(v)), 1e-300);
      worst = Math.max(worst, d); out.push(`scalar ${k}: ${v} vs ${w} rel ${d.toExponential(2)}`);
    }
    for (const fl of a.fields) {
      const g = b.fields.find((x) => x.key === fl.key);
      nTot++;
      if (!g || g.length !== fl.length) { out.push(`field ${fl.key}: missing or length differs`); worst = Infinity; continue; }
      let dmax = 0, amax = 0, same = true;
      for (let q = 0; q < fl.length; q++) {
        const x = fa[fl.offset + q], y = fb[g.offset + q];
        if (!Object.is(x, y)) same = false;
        if (Number.isFinite(x)) amax = Math.max(amax, Math.abs(x));
        if (Number.isFinite(x) || Number.isFinite(y)) dmax = Math.max(dmax, Math.abs(x - y));
      }
      if (same) { nBit++; continue; }
      const d = dmax / Math.max(amax, 1e-300);
      worst = Math.max(worst, d); out.push(`field ${fl.key}: max |d| / max |a| ${d.toExponential(2)}`);
    }
    console.log(`${f}: ${out.length ? `${out.length} differ\n  ${out.slice(0, 12).join('\n  ')}` : 'bitwise identical'}`);
  }
  console.log(`total ${nTot} items, ${nBit} bitwise identical, worst relative difference ${worst === 0 ? 0 : worst.toExponential(3)}`);
  process.exit(worst <= 1e-12 ? 0 : 2);
}

// ------------------------------------------------------------------------------------------------- workloads
/** sim, levels (hFactor), optional eval case (class, id) for prepareRun, optional study id and physics id. */
const WORKLOADS = {
  ac02: { sim: 'box-acoustics.yaml', levels: [0.25], case: ['a', 'AC-02'] },
  h6: { sim: 'box-acoustics.yaml', levels: [1, 0.5, 0.25], case: ['a', 'AC-02'] },
  kirsch: { sim: 'kirsch-plate.yaml', levels: [1, 0.5, 0.25] },
  rib: { sim: 'hadley-rib-wo02.yaml', levels: [1, 0.5] },
  rf21: { sim: 'cylinder-cavity-axisym.yaml', levels: [1, 0.5, 0.25] },
  pzt4: { sim: 'pzt4-cube.yaml', levels: [1], study: 'std_sc' }, // h 0.5 exceeds the 2 GB RSS budget
  hotarm: { sim: 'hot-arm-actuator.yaml', levels: [1] },
  em3d: { sim: 'cylinder-cavity.yaml', levels: [Number(arg('em3d-h', 0.5))] },
};
const name = arg('only');
const W = WORKLOADS[name];
if (!W) { console.error(`--only one of ${Object.keys(WORKLOADS).join(', ')}`); process.exit(1); }
if (arg('levels')) W.levels = arg('levels').split(',').map(Number);
const RUNS = Number(arg('runs', 5));
// --solve js|wasm: real triangular solve kernel (DevLog-045); default: the engine default
if (arg('solve')) setDefaultRealSolve(arg('solve'));
const DUMP = arg('dump', null);
const p2 = (v) => String(v).padStart(2, '0');
const d0 = new Date();
const STAMP = `${d0.getFullYear()}${p2(d0.getMonth() + 1)}${p2(d0.getDate())}T${p2(d0.getHours())}${p2(d0.getMinutes())}${p2(d0.getSeconds())}`;
const LOG = arg('out', join(REPO, 'logs', `perf-core-1-${STAMP}.jsonl`));
mkdirSync(dirname(LOG), { recursive: true });
if (DUMP) mkdirSync(DUMP, { recursive: true });

// core time accounting (bench only; the wrappers call the originals unchanged)
const acc = { factor: 0, solve: 0, nSolve: 0 };
function wrap(proto, key, bucket, count) {
  const orig = proto[key];
  proto[key] = function (...a) {
    const t0 = performance.now();
    try { return orig.apply(this, a); } finally { acc[bucket] += performance.now() - t0; if (count) acc.nSolve += count(a); }
  };
}
wrap(SparseCholesky.prototype, 'factor', 'factor');
wrap(SparseCholesky.prototype, 'solve', 'solve', () => 1);
wrap(SparseCholesky.prototype, 'solveMany', 'solve', (a) => a[0].length);
wrap(SupernodalLDLT.prototype, 'factor', 'factor');
wrap(SupernodalLDLT.prototype, 'solve', 'solve', () => 1);
wrap(SupernodalLDLT.prototype, 'solveMany', 'solve', (a) => a[1]);

const { parseYaml } = await import(pathToFileURL(join(REPO, 'packages/spec/src/index.ts')).href);
const phys = await import(pathToFileURL(join(REPO, 'packages/physics/src/index.ts')).href);
const spec = parseYaml(readFileSync(join(REPO, 'sims', W.sim), 'utf8')).data;
let cs;
if (W.case) {
  const { readCase } = await import(pathToFileURL(join(REPO, 'packages/physics/gates/common.ts')).href);
  cs = readCase(W.case[0], W.case[1]);
}

async function once(h) {
  acc.factor = 0; acc.solve = 0; acc.nSolve = 0;
  const t0 = performance.now();
  const ctx = await phys.prepareRun({ spec, hFactor: h, ...(cs ? { case: cs } : {}), ...(W.study ? { studyId: W.study } : {}) });
  const t1 = performance.now();
  const sol = await phys.runStudy(ctx, W.study ? { studyId: W.study } : {});
  const t2 = performance.now();
  return { sol, wall: t2 - t0, prepare: t1 - t0, run: t2 - t1, core: { ...acc }, rss: process.memoryUsage().rss };
}

function dump(h, sol) {
  const fields = [];
  let off = 0;
  for (const f of sol.fields) {
    const key = `${f.physics ?? ''}:${f.name}${f.step !== undefined ? `@${f.step}` : ''}${f.component !== undefined ? `#${f.component}` : ''}`;
    const data = f.data instanceof Float64Array ? f.data : Float64Array.from(f.data ?? []);
    fields.push({ key, offset: off, length: data.length, data });
    off += data.length;
  }
  const bin = new Float64Array(off);
  for (const f of fields) bin.set(f.data, f.offset);
  const base = join(DUMP, `${name}-h${h}`);
  writeFileSync(`${base}.bin`, new Uint8Array(bin.buffer));
  const scalars = Object.fromEntries(Object.entries(sol.scalars).map(([k, v]) => [k, String(v.value)]));
  writeFileSync(`${base}.json`, JSON.stringify({ scalars, fields: fields.map(({ key, offset, length }) => ({ key, offset, length })), dof: sol.stats.dof, stats: sol.stats }));
}

const platform = { node: process.version, cpu: os.cpus()[0]?.model, cores: os.cpus().length };
for (const h of W.levels) {
  const runs = [];
  for (let k = 0; k <= RUNS; k++) {
    const r = await once(h);
    runs.push(r);
    if (k === RUNS && DUMP) dump(h, r.sol);
    process.stderr.write(`${name} h ${h} run ${k}${k === 0 ? ' (cold)' : ''}: wall ${r.wall.toFixed(0)} ms run ${r.run.toFixed(0)} factor ${r.core.factor.toFixed(0)} solve ${r.core.solve.toFixed(0)} (${r.core.nSolve}) rss ${(r.rss / 2 ** 20).toFixed(0)} MiB load ${os.loadavg()[0].toFixed(2)}\n`);
  }
  const cold = runs[0], warm = runs.slice(1);
  const stageNames = [...new Set(warm.flatMap((r) => Object.keys(r.sol.timing)))];
  const row = {
    date: new Date().toISOString(), ...platform, loadavg: os.loadavg().map(r4), workload: name, sim: W.sim, hFactor: h, dof: cold.sol.stats.dof, nnz: cold.sol.stats.nnz ?? null,
    solver: cold.sol.stats.solver, runs: RUNS, solve: arg('solve') ?? 'default',
    cold: { wall: r4(cold.wall), prepare: r4(cold.prepare), run: r4(cold.run), coreFactor: r4(cold.core.factor), coreSolve: r4(cold.core.solve), nSolve: cold.core.nSolve },
    warm_median: {
      wall: r4(median(warm.map((r) => r.wall))), prepare: r4(median(warm.map((r) => r.prepare))), run: r4(median(warm.map((r) => r.run))),
      coreFactor: r4(median(warm.map((r) => r.core.factor))), coreSolve: r4(median(warm.map((r) => r.core.solve))), nSolve: warm[0]?.core.nSolve ?? null,
      stages: Object.fromEntries(stageNames.map((s) => [s, r4(median(warm.map((r) => r.sol.timing[s] ?? 0)))])),
    },
    warm_wall: warm.map((r) => r4(r.wall)),
    rssMaxMiB: r4(Math.max(...runs.map((r) => r.rss)) / 2 ** 20),
  };
  appendFileSync(LOG, `${JSON.stringify(row)}\n`);
  console.log(JSON.stringify(row));
}
