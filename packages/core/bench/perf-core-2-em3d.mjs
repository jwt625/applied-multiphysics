// SPDX-License-Identifier: GPL-3.0-or-later
// em3d (emw eigen, sims/cylinder-cavity.yaml) with the direct and the AMS linear solver (lane E8, DevLog-054): wall,
// stages, eigenfrequencies, PCG statistics, RSS. The study's solver setting is set on the prepared run context (the
// eigen study registration does not list it yet). Usage (repo root):
//   nice -n 10 node --max-old-space-size=1536 packages/core/bench/perf-core-2-em3d.mjs --h 1 --solver direct|ams|auto
//     [--rtol 1e-10] [--shift keep|none] [--modes 16] [--out FILE]
import { readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import os from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const h = Number(arg('h', 1)), solver = arg('solver', 'direct'), rtol = arg('rtol', null);
const { parseYaml } = await import(pathToFileURL(join(REPO, 'packages/spec/src/index.ts')).href);
const phys = await import(pathToFileURL(join(REPO, 'packages/physics/src/index.ts')).href);
const spec = parseYaml(readFileSync(join(REPO, 'sims', arg('sim', 'cylinder-cavity.yaml')), 'utf8')).data;
const t0 = performance.now();
const ctx = await phys.prepareRun({ spec, hFactor: h });
const st = ctx.study;
st.settings = { ...(st.settings ?? {}), solver, ...(rtol ? { rtol: Number(rtol) } : {}), ...(arg('modes') ? { nModes: Number(arg('modes')) } : {}) };
if (arg('shift') === 'none') delete st.settings.shift;
const t1 = performance.now();
const sol = await phys.runStudy(ctx, {});
const t2 = performance.now();
const f = Object.entries(sol.scalars).filter(([k]) => /^(rf\.)?f_\d+$/.test(k)).map(([k, v]) => [k, v.value]);
const row = {
  date: new Date().toISOString(), loadavg: os.loadavg().map((x) => +x.toFixed(2)), sim: arg('sim', 'cylinder-cavity.yaml'), hFactor: h, solver, rtol: rtol ? Number(rtol) : null,
  dof: sol.stats.dof, nnz: sol.stats.nnz, wall: +(t2 - t0).toFixed(0), prepare: +(t1 - t0).toFixed(0), timing: sol.timing, stats: sol.stats, notes: sol.notes ?? [],
  rssMiB: +(process.memoryUsage().rss / 2 ** 20).toFixed(0), f: Object.fromEntries(f.map(([k, v]) => [k, String(v)])),
};
const out = arg('out', null);
if (out) { mkdirSync(dirname(out), { recursive: true }); appendFileSync(out, `${JSON.stringify(row)}\n`); }
console.log(JSON.stringify(row));
