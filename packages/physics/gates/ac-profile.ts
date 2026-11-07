// SPDX-License-Identifier: GPL-3.0-or-later
// Profile of the AC-02 harness path (prepareRun + acoustics run at hFactor 1, 0.5, 0.25 on sims/box-acoustics.yaml,
// the case's h_factors): per-stage times, end to end. Usage: nice -n 10 node --max-old-space-size=1536 gates/ac-profile.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseYaml } from '@amp/spec';
import { prepareRun, acousticsModule } from '../src/index.ts';
import { REPO, readCase } from './common.ts';
const spec = parseYaml(readFileSync(join(REPO, 'sims/box-acoustics.yaml'), 'utf8')).data as Record<string, unknown>;
const cs = readCase('a', 'AC-02');
let total = 0;
for (const f of cs.convergence.h_factors as number[]) {
  const t0 = performance.now();
  const ctx = await prepareRun({ spec, case: cs, hFactor: f });
  const s = await acousticsModule.run(ctx);
  const wall = performance.now() - t0;
  total += wall;
  const st = (s as unknown as { detail?: { stats?: Record<string, unknown> } }).detail?.stats ?? {};
  console.log(`hFactor ${f}: dof ${s.stats.dof} wall ${wall.toFixed(0)} ms ${JSON.stringify(Object.fromEntries(Object.entries(s.timing).map(([k, v]) => [k, Math.round(v)])))} op ${s.stats.iterations} restarts ${st.restarts} arnoldi ${Math.round(Number(st.arnoldiMs))} refine ${Math.round(Number(st.refineMs))} nnzL ${st.nnzL}`);
}
console.log(`end to end ${total.toFixed(0)} ms`);
