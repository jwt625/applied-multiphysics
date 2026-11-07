// SPDX-License-Identifier: GPL-3.0-or-later
// Run every L4 gate script in sequence (one heavy process at a time). Usage: pnpm gates  (or node gates/run-all.ts)
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const scripts = ['heat.ts', 'elastic.ts', 'em.ts', 'modes-wo01.ts', 'modes-wo02.ts', 'ac-02.ts', 'rf-01.ts'];
let bad = 0;
for (const s of scripts) {
  console.log(`\n=== ${s}`);
  const r = spawnSync('node', ['--max-old-space-size=1536', join(here, s)], { stdio: 'inherit' });
  if (r.status !== 0) bad++;
}
process.exit(bad ? 1 : 0);
