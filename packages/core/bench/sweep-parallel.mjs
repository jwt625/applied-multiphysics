// SPDX-License-Identifier: GPL-3.0-or-later
// Parallel parametric sweep check (lane E8, DevLog-054): the points of a sim's parametric study solved serially in this
// thread and on N worker threads (one prepareRun + runStudy per point, as the web pool's runner workers do); every
// scalar and field must be bitwise identical, and the wall times are reported. Usage (repo root):
//   nice -n 10 node --max-old-space-size=1536 packages/core/bench/sweep-parallel.mjs [--sim si-rib-waveguide.yaml]
//     [--workers 4] [--out FILE]
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { readFileSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import os from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');

async function loader() {
  const { parseYaml } = await import(pathToFileURL(join(REPO, 'packages/spec/src/index.ts')).href);
  const phys = await import(pathToFileURL(join(REPO, 'packages/physics/src/index.ts')).href);
  return { parseYaml, phys };
}

/** Spec of one sweep point: swept params set (value in the param's unit), inner study solved. */
function pointSpec(parseYaml, sim, values) {
  const spec = parseYaml(readFileSync(join(REPO, 'sims', sim), 'utf8')).data;
  for (const [k, v] of Object.entries(values)) {
    const p = spec.params[k];
    if (p && typeof p === 'object') p.value = v;
    else spec.params[k] = v;
  }
  return spec;
}

async function solvePoint(L, sim, values, studyId) {
  const spec = pointSpec(L.parseYaml, sim, values);
  const ctx = await L.phys.prepareRun({ spec, studyId });
  const sol = await L.phys.runStudy(ctx, { studyId });
  const scalars = Object.fromEntries(Object.entries(sol.scalars).map(([k, v]) => [k, String(v.value)]));
  const fields = sol.fields.map((f) => ({ key: `${f.physics ?? ''}:${f.name}@${f.step ?? ''}`, data: Float64Array.from(f.data) }));
  return { scalars, fields, dof: sol.stats.dof };
}

if (!isMainThread) {
  const L = await loader();
  parentPort.on('message', async (m) => {
    if (m === 'exit') return process.exit(0);
    const r = await solvePoint(L, workerData.sim, m.values, workerData.studyId);
    parentPort.postMessage({ i: m.i, r }, r.fields.map((f) => f.data.buffer));
  });
} else {
  const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
  const sim = arg('sim', 'si-rib-waveguide.yaml'), N = Number(arg('workers', 4));
  const L = await loader();
  const base = L.parseYaml(readFileSync(join(REPO, 'sims', sim), 'utf8')).data;
  const par = base.studies.find((s) => s.type === 'parametric');
  const ax = par.settings.sweep[0];
  // values written as "<number> <unit>" in the param's own unit (the sims' convention)
  const pts = ax.values.map((q) => ({ [ax.param]: Number(String(q).trim().split(/\s+/)[0]) }));
  const studyId = par.settings.study;
  // serial
  const t0 = performance.now();
  const ser = [];
  for (const v of pts) ser.push(await solvePoint(L, sim, v, studyId));
  const tSer = performance.now() - t0;
  // parallel
  const t1 = performance.now();
  const par2 = new Array(pts.length);
  await new Promise((resolve, reject) => {
    let next = 0, done = 0;
    const ws = Array.from({ length: Math.min(N, pts.length) }, () => new Worker(fileURLToPath(import.meta.url), { workerData: { sim, studyId }, resourceLimits: { maxOldGenerationSizeMb: 1536 } }));
    const feed = (w) => { if (next < pts.length) { const i = next++; w.postMessage({ i, values: pts[i] }); } else w.postMessage('exit'); };
    for (const w of ws) {
      w.on('message', (m) => { par2[m.i] = m.r; done++; if (done === pts.length) resolve(); feed(w); });
      w.on('error', reject);
      feed(w);
    }
  });
  const tPar = performance.now() - t1;
  let items = 0, same = 0;
  pts.forEach((_, i) => {
    const a = ser[i], b = par2[i];
    for (const [k, v] of Object.entries(a.scalars)) { items++; if (b.scalars[k] === v) same++; }
    for (const f of a.fields) {
      items++;
      const g = b.fields.find((x) => x.key === f.key);
      if (g && g.data.length === f.data.length && f.data.every((x, q) => Object.is(x, g.data[q]))) same++;
    }
  });
  const row = { date: new Date().toISOString(), loadavg: os.loadavg().map((x) => +x.toFixed(2)), sim, points: pts.length, workers: N, dof: ser.map((r) => r.dof), serialMs: +tSer.toFixed(0), parallelMs: +tPar.toFixed(0), speedup: +(tSer / tPar).toFixed(2), items, bitwiseIdentical: same };
  const out = arg('out', null);
  if (out) appendFileSync(out, `${JSON.stringify(row)}\n`);
  console.log(JSON.stringify(row));
  process.exit(same === items ? 0 : 2);
}
