// SPDX-License-Identifier: GPL-3.0-or-later
// Smoke run of prepareRun + module.run on the six sims/ hero specs (values N/A in a spec are taken from the eval case).
import { readFileSync } from 'node:fs';
import { parseYaml } from '@amp/spec';
import { prepareRun, registry } from '../src/index.ts';
import { REPO } from './common.ts';
const R = `${REPO}/`;
const pairs: Array<[string, string | null]> = [['heat-plate-fin', 'a/HT-01'], ['kirsch-plate', 'a/SM-01'], ['helmholtz-coil', 'a/EM-04'], ['box-acoustics', 'a/AC-02'], ['cylinder-cavity', 'a/RF-21'], ['si-rib-waveguide', null]];
for (const [sim, cs] of pairs) {
  const spec = parseYaml(readFileSync(`${R}sims/${sim}.yaml`, 'utf8')).data as Record<string, unknown>;
  const c = cs ? parseYaml(readFileSync(`${R}eval/cases/${cs}.yaml`, 'utf8')).data as Record<string, unknown> : undefined;
  try {
    const t0 = performance.now();
    const ctx = await prepareRun({ spec, case: c, hFactor: 1 } as any);
    const t1 = performance.now();
    const m = registry[(ctx.spec.physics![0] as any).type]!;
    const rd = m.readiness(ctx.spec, ctx.physicsId);
    let out = `ready ${rd.ready} ${rd.reasons.join(';')}`;
    try { const s = await m.run(ctx); out += ` | run ok dof ${s.stats.dof} scalars ${Object.entries(s.scalars).slice(0, 4).map(([k, v]) => `${k}=${v.value.toPrecision(6)}`).join(' ')}`; } catch (e) { out += ` | run error: ${(e as Error).message.slice(0, 200)}`; }
    console.log(`${sim}: mesh ${ctx.mesh.cells.type} ${ctx.mesh.cells.conn.length} prep ${(t1 - t0).toFixed(0)} ms; mats ${JSON.stringify(ctx.materials)}; ${out}\n   notes: ${ctx.notes.join(' | ').slice(0, 400)}`);
  } catch (e) { console.log(`${sim}: prepare error: ${(e as Error).message.slice(0, 300)}`); }
}
