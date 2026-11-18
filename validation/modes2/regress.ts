// SPDX-License-Identifier: GPL-3.0-or-later
// em-modes regression dump (DevLog-043 s.8): the 9 sims with em-modes, prepareRun + runStudy; per sim the mesh hash,
// eigenvalues, scalars, per-field sums of squares and notes. Compare two dumps for bitwise identity.
// Usage (repo root): nice -n 10 node --max-old-space-size=1536 validation/modes2/regress.ts logs/<name>-<ts>.json (peak RSS about 1.3 GB)
import { readFileSync, writeFileSync } from 'node:fs';
const R = new URL('../..', import.meta.url).pathname.replace(/\/$/, ''), OUT = process.argv[2]!;
const P = `${R}/packages/`;
const { prepareRun, runStudy } = await import(`${P}physics/src/index.ts`);
const { parseYaml } = await import(`${P}spec/src/index.ts`);
const sims = ['hadley-rib-wo02', 'hadley-square-core', 'hadley-square-hole', 'si-microheater-to', 'si-rib-waveguide', 'si-slab-te0', 'si-slab-tm0', 'si-strip-te0', 'tfln-mzm-eo'];
const out: Record<string, unknown> = {};
for (const s of sims) {
  const spec = parseYaml(readFileSync(`${R}/sims/${s}.yaml`, 'utf8')).data as any;
  const pid = spec.physics.find((p: any) => p.type === 'em-modes').id;
  const t0 = performance.now();
  const prep = await prepareRun(spec, { physicsId: pid });
  const mh = String(prep.mesh.hash) + '/' + String(prep.mesh.tagHash);
  const sol = (await runStudy(prep)) as any;
  const scalars: Record<string, number> = {};
  for (const [k, v] of Object.entries(sol.scalars ?? {})) scalars[k] = (v as any).value;
  const fieldSumSq: Record<string, number> = {};
  for (const f of sol.fields ?? []) {
    const d = (f as any).data;
    let a = 0; for (let i = 0; i < d.length; i++) a += d[i] * d[i];
    fieldSumSq[`${f.name}.${f.step ?? ''}`] = a;
  }
  const steps = sol.steps;
  out[s] = { meshHash: mh, steps, scalars, fieldSumSq, notes: sol.notes ?? [], ms: Math.round(performance.now() - t0) };
  console.log(s, Math.round(performance.now() - t0), 'ms', Object.keys(fieldSumSq).length, 'fields');
}
writeFileSync(OUT, JSON.stringify(out, null, 1));
console.log('rss GB', (process.memoryUsage().rss / 2 ** 30).toFixed(2));
