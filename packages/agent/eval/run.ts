// SPDX-License-Identifier: GPL-3.0-or-later
// Runs the agent task suite against the scripted mock provider (no network, no cost) and writes
// logs/L9-eval-<timestamp>.jsonl (one result per task, then a summary line). Exit code 1 if any task fails.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TASKS, runTask } from './tasks.ts';
import { isoNow } from '@amp/spec';
import { REPO } from './fixtures.ts';
import { toolDefinitionSize } from '../src/tools/defs.ts';

const stamp = isoNow().slice(0, 19).replace(/[-:]/g, ''); // local time, as the other lanes' logs
const results = [];
for (const t of TASKS) {
  const r = await runTask(t);
  results.push(r);
  console.log(`${r.pass ? 'PASS' : 'FAIL'} ${r.id} (${r.modelCalls} model calls, ${r.toolCalls} tool calls, ${r.ms} ms)${r.pass ? '' : `\n  ${r.failures.join('\n  ')}`}`);
}
const passed = results.filter((r) => r.pass).length;
// checker sensitivity: every checker against a do-nothing model
const nullPass: string[] = [];
for (const t of TASKS) if ((await runTask(t, { nullScript: true })).pass) nullPass.push(t.id);
console.log(`checker sensitivity: ${TASKS.length - nullPass.length}/${TASKS.length} checkers reject a do-nothing transcript; accepted: ${nullPass.join(', ') || 'none'}`);
const size = toolDefinitionSize();
const summary = { summary: true, ts: isoNow(), provider: 'mock-scripted', tasks: results.length, passed, passRate: passed / results.length, nullTranscriptAccepted: nullPass, toolDefs: { tools: size.tools, bytes: size.bytes, tokensEstimate: size.tokensEstimate, tokensNote: 'estimate: bytes / 4, not a tokenizer count' } };
console.log(`${passed}/${results.length} tasks passed; tool definitions ${size.tools} tools, ${size.bytes} B (~${size.tokensEstimate} tokens, estimate bytes/4)`);
mkdirSync(join(REPO, 'logs'), { recursive: true });
const file = join(REPO, 'logs', `L9-eval-${stamp}.jsonl`);
writeFileSync(file, [...results, summary].map((r) => JSON.stringify(r)).join('\n') + '\n');
console.log(`log: logs/L9-eval-${stamp}.jsonl`);
process.exitCode = passed === results.length ? 0 : 1;
