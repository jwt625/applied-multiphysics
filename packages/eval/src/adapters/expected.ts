// SPDX-License-Identifier: GPL-3.0-or-later
// Self-check adapter: compares each inline reference value in the case YAML with the value the generator wrote to
// eval/expected/<ID>.json. Catches retyping errors between the case and its generator. It says nothing about the
// engine. A target whose reference exists only in the expected JSON has nothing to cross-check and stays pending.
// Lookup: reference.expected {metric_id | key}, else targets[] by target id (id, metric_id, quantity).

import type { LoadedCase } from '../loader.ts';
import { generatedValue, targetId } from '../loader.ts';
import type { TargetObservation } from '../evaluate.ts';
import type { CaseObservation, Source } from '../source.ts';

export class ExpectedSource implements Source {
  name = 'expected';
  describe(): string { return 'expected: case YAML value vs eval/expected/<ID>.json generator value'; }

  async plan(lc: LoadedCase): Promise<{ runnable: boolean; reason: string }> {
    if (lc.expected === undefined) return { runnable: false, reason: `no ${lc.expectedFile ?? 'expected JSON'}` };
    const n = lc.data!.references.filter((r) => r.value !== undefined && r.value !== null && generatedValue(r, lc.expected) !== undefined).length;
    return { runnable: n > 0, reason: `${n}/${lc.data!.references.length} targets have both an inline and a generated value` };
  }

  async observe(lc: LoadedCase): Promise<CaseObservation> {
    if (lc.expected === undefined) return { kind: 'pending', reason: `no ${lc.expectedFile ?? 'expected JSON'}` };
    const targets: Record<string, TargetObservation | { pending: string } | { error: string }> = {};
    for (const r of lc.data!.references) {
      const id = targetId(r);
      if (r.extract?.kind === 'field') { targets[id] = { pending: 'field target: no scalar to cross-check' }; continue; }
      const g = generatedValue(r, lc.expected);
      if (g === undefined) { targets[id] = { pending: `no generated value for '${r.expected?.metric_id ?? r.expected?.key ?? id}' in ${lc.expectedFile}` }; continue; }
      if (r.value === undefined || r.value === null) { targets[id] = { pending: `reference comes only from ${lc.expectedFile}; nothing to cross-check` }; continue; }
      targets[id] = { levels: [{ value: g }], exact: true };
    }
    const e = (lc.expected ?? {}) as Record<string, unknown>;
    return {
      kind: 'observed', targets,
      run: { engine: `expected-selfcheck:${String(e.generator ?? 'unknown-generator')}`, generated_at: e.generated_at ?? e.timestamp ?? null, fidelity: 'reference' },
    };
  }
}
