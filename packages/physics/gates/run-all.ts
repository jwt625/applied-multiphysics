// SPDX-License-Identifier: GPL-3.0-or-later
// Run every L4 gate script in sequence (one heavy process at a time, nice 10, heap cap 1536 MB). Exit code: the worst
// of the scripts (1 error beats 2 gate missed beats 0 pass). Usage: node gates/run-all.ts
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const scripts: Array<[string, string[]]> = [['heat.ts', []], ['elastic.ts', []], ['em.ts', []], ['modes-wo01.ts', []], ['modes-wo02.ts', []], ['ac-02.ts', []], ['rf-axisym.ts', []], ['rf-01.ts', ['--mesh', 'nested']], ['rf-01.ts', ['--mesh', 'rings', '--levels', '4,5,6']]];
let worst = 0;
for (const [s, args] of scripts) {
  console.log(`\n=== ${s} ${args.join(' ')}`);
  const r = spawnSync('nice', ['-n', '10', process.execPath, '--max-old-space-size=1536', join(here, s), ...args], { stdio: 'inherit' });
  const code = r.status ?? 1;
  console.log(`=== ${s}: exit ${code}`);
  if (code === 1 || (code !== 0 && worst !== 1)) worst = code === 1 ? 1 : 2;
}
process.exit(worst);
