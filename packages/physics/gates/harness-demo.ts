// SPDX-License-Identifier: GPL-3.0-or-later
// End-to-end check of the L8 harness path (registry hook + prepareRun + @amp/post sample) on HT-01 before L7a points
// the case at a sims/ spec: the case text is read, its pending `spec` replaced in memory by sims/heat-plate-fin.yaml and
// a probe extract added to T_E (point E from the case). Nothing is written into eval/.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCase, runCase } from '../../eval/src/index.ts';
import { EngineSource, loadDefaultRegistry } from '../../eval/src/registry.ts';
import { REPO } from './common.ts';

const file = join(REPO, 'eval/cases/a/HT-01.yaml');
let text = readFileSync(file, 'utf8');
text = text.replace(/^spec: \{status: pending[^\n]*\n(?:    [^\n]*\n)*/m, 'spec: sims/heat-plate-fin.yaml\n');
text = text.replace('  metric_id: T_E\n', '  metric_id: T_E\n  extract: {kind: probe, field: T, point: [0.6, 0.2]}\n');
const lc = parseCase(text, file, { dirClass: 'a', stem: 'HT-01', expectedFile: 'eval/expected/HT-01.json', expectedText: readFileSync(join(REPO, 'eval/expected/HT-01.json'), 'utf8') });
const errs = lc.issues.filter((i) => i.severity === 'error');
if (errs.length) { console.log(errs.map((e) => e.message).join('\n')); process.exit(1); }
const { registry, reason } = await loadDefaultRegistry();
const src = new EngineSource(registry, reason);
console.log(src.describe());
const res = await runCase(lc, src, { log: (m: string) => console.log(m) });
console.log(res.status, JSON.stringify(res.targets.map((t) => ({ target: t.target, status: t.status, value: (t as { value?: unknown }).value, ref: t.ref, reason: t.reason })), null, 0));
