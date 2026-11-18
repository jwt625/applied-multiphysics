// SPDX-License-Identifier: GPL-3.0-or-later
// Lane E2 (DevLog-048) runner: prepareRun + runStudy of one sims/<id>.yaml at nested mesh levels, printing selected
// scalars, DOF and peak RSS as one JSON line per level. Param overrides as name=value (SI number or quantity string).
// Usage (repo root): nice -n 10 node --max-old-space-size=1536 validation/modes3/run.ts <sim-id> [--h 1,0.5] [--study id] [--p name=value ...] [--s neff_0,ng_0]
import { readFileSync } from 'node:fs';
const R = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const { prepareRun, runStudy } = await import(`${R}/packages/physics/src/index.ts`);
const { parseYaml } = await import(`${R}/packages/spec/src/index.ts`);
const a = process.argv.slice(2);
const id = a[0]!;
const opt = (k: string) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
const hs = (opt('--h') ?? '1').split(',').map(Number);
const want = opt('--s')?.split(',');
const spec = parseYaml(readFileSync(`${R}/sims/${id}.yaml`, 'utf8')).data as any;
for (let i = 0; i < a.length; i++) if (a[i] === '--p') {
  const [k, v] = a[i + 1]!.split('=');
  const num = Number(v);
  spec.params[k!] = Number.isFinite(num) ? { ...spec.params[k!], value: num } : v;
}
const pid = spec.physics.find((p: any) => p.type === 'em-modes')?.id ?? spec.physics[0].id;
let peak = 0;
for (const h of hs) {
  const t0 = performance.now();
  const prep = await prepareRun(spec, { physicsId: pid, hFactor: h, ...(opt('--study') ? { studyId: opt('--study') } : {}) });
  const sol = (await runStudy(prep)) as any;
  const sc: Record<string, number> = {};
  for (const [k, v] of Object.entries(sol.scalars ?? {})) if (!want || want.includes(k)) sc[k] = (v as any).value;
  peak = Math.max(peak, process.memoryUsage().rss);
  console.log(JSON.stringify({ sim: id, h, dof: sol.stats?.dof, ms: Math.round(performance.now() - t0), scalars: sc, steps: sol.steps?.values ? Array.from(sol.steps.values).slice(0, 12) : undefined, rssGB: +(peak / 2 ** 30).toFixed(2), notes: process.env.NOTES ? [...prep.notes, ...(sol.notes ?? [])] : undefined }));
}
