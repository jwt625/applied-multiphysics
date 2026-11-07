// SPDX-License-Identifier: GPL-3.0-or-later
// R1 convergence script (DevLog-026): runs gates 1-6 (r1-gates.ts), prints the table, writes
// logs/r1-post-gates-<UTC timestamp>.json at the repo root. Exit code 2 when a gate fails.
// Usage (from packages/post): nice -n 10 node --max-old-space-size=1536 gates/r1-convergence.ts

import { mkdirSync, writeFileSync } from 'node:fs';
import { runR1Gates } from './r1-gates.ts';
import { gate7Fixture } from './fixture-r1.ts';

const t0 = new Date();
const { rows, runs, bench } = await runR1Gates({ bench: true });
const g7 = await gate7Fixture();
for (const r of runs) console.log(`${r.sim}: ${r.levels.map((l) => `h ${l.hFactor} dof ${l.dof} cells ${l.cells} ${l.ms} ms`).join(' | ')}`);
console.log('gate | quantity | expected p | observed p | finest error | finest rel | status');
for (const r of rows) console.log(`${r.gate} | ${r.quantity} | ${r.expected_order} | ${r.orders.map((p) => (Number.isFinite(p) ? p.toFixed(2) : '-')).join(', ')} | ${r.finest_error.toExponential(3)} ${r.unit} | ${r.finest_rel?.toExponential(2) ?? '-'} | ${r.status}${r.note ? ` | ${r.note}` : ''}`);
for (const b of bench ?? []) console.log(`timing (warm median of 5) kirsch h ${b.hFactor} dof ${b.dof}: cut line 500 points ${b.cutline500_ms} ms, domain integral ${b.domain_integral_ms} ms`);
console.log(`gate 7 fixture: ${g7.sha256} (${g7.count} values)`);
const stamp = t0.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const dir = new URL('../../../logs/', import.meta.url);
mkdirSync(dir, { recursive: true });
const file = new URL(`r1-post-gates-${stamp}.json`, dir);
writeFileSync(file, JSON.stringify({ started: t0.toISOString(), node: process.version, runs, rows, bench, gate7: g7 }, null, 1) + '\n');
console.log(`log: logs/r1-post-gates-${stamp}.json`);
if (rows.some((r) => r.status === 'fail')) process.exitCode = 2;
