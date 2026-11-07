// SPDX-License-Identifier: GPL-3.0-or-later
// Regression dump (DevLog-036 gate 1): every sims/*.yaml with an electrostatics physics, prepared with prepareRun and
// solved by the electrostatics module alone; prints {sim: {scalars (exact JS number strings), fields: sha-256 of the
// field bytes, dof} | {error}}. Run before and after a change of the module and diff.
//   node --max-old-space-size=1536 packages/physics/scripts/check-sims.ts > out.json
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseYaml } from '@amp/spec';
import { prepareRun } from '../src/prepare.ts';
import { electrostaticsModule } from '../src/index.ts';

const root = new URL('../../../sims/', import.meta.url);
const res: Record<string, unknown> = {};
for (const f of readdirSync(root).filter((x) => x.endsWith('.yaml')).sort()) {
  const spec = parseYaml(readFileSync(new URL(f, root), 'utf8')).data as { physics?: Array<{ id: string; type: string }> };
  for (const ph of (spec.physics ?? []).filter((p) => p.type === 'electrostatics')) {
    const key = `${f}#${ph.id}`;
    try {
      const t0 = performance.now();
      const prep = await prepareRun(spec as Record<string, unknown>, { physicsId: ph.id });
      const sol = await electrostaticsModule.run(prep);
      const scalars = Object.fromEntries(Object.entries(sol.scalars).map(([k, v]) => [k, String(v.value)]));
      const fields = sol.fields.map((x) => `${x.name}${x.step !== undefined ? `@${x.step}` : ''}:${createHash('sha256').update(new Uint8Array(x.data.buffer, x.data.byteOffset, x.data.byteLength)).digest('hex').slice(0, 16)}`);
      res[key] = { scalars, fields, dof: sol.stats.dof };
      process.stderr.write(`${key}: ok ${Math.round(performance.now() - t0)} ms\n`);
    } catch (e) {
      res[key] = { error: (e as Error).message.slice(0, 300) };
      process.stderr.write(`${key}: error ${(e as Error).message.slice(0, 160)}\n`);
    }
  }
}
process.stdout.write(`${JSON.stringify(res, null, 1)}\n`);
