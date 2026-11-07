// SPDX-License-Identifier: GPL-3.0-or-later
// The one test that reads the live sims/ files (owned by lane I1): every sims/*.yaml must validate against the full
// registry, i.e. the spec seed superseded by @amp/physics, @amp/geom/spec and @amp/materials registrations. Those
// packages depend on @amp/spec, so they are loaded here by relative path at test time only (no package dependency);
// the test is skipped, with the reason, when one is absent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { parseSpecText, formatIssues } from '../src/yaml.ts';
import type { Registry } from '../src/registry.ts';
import { SIMS } from './heroes.ts';

async function fullRegistry(): Promise<{ reg: Registry | null; why: string }> {
  try {
    const phys = await import(new URL('../../physics/src/registrations.ts', import.meta.url).href) as { physicsRegistry(): Registry };
    const geom = await import(new URL('../../geom/src/spec.ts', import.meta.url).href) as { registerGeomFeatures(r: Registry): Registry };
    const mat = await import(new URL('../../materials/src/properties.ts', import.meta.url).href) as { registerMaterialProperties(r: Registry): string[] };
    const reg = geom.registerGeomFeatures(phys.physicsRegistry());
    mat.registerMaterialProperties(reg);
    return { reg, why: '' };
  } catch (e) { return { reg: null, why: (e as Error).message }; }
}

test('every live sims/*.yaml validates against the full registry (physics + geom + materials)', async (t) => {
  const { reg, why } = await fullRegistry();
  if (!reg) { t.skip(`full registry unavailable: ${why}`); return; }
  const files = readdirSync(SIMS).filter((f) => f.endsWith('.yaml')).sort();
  assert.ok(files.length > 0);
  const bad: string[] = [];
  for (const f of files) {
    const r = parseSpecText(readFileSync(new URL(f, SIMS), 'utf8'), reg);
    if (!r.ok) bad.push(`${f}:\n${formatIssues(r.issues)}`);
  }
  assert.deepEqual(bad, [], bad.join('\n'));
});
