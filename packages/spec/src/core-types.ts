// SPDX-License-Identifier: GPL-3.0-or-later
// Core (non-provisional) registrations owned by @amp/spec: physics-agnostic study types. The parametric study is the
// spec side of the @amp/core sweep API (which no longer reads config, DevLog-002): axes are params, each with an
// explicit value list or a linear range; axes combine row-major (first axis slowest), as in the EO sweep.

import * as z from 'zod';
import { quantity, nodeId } from './schema.ts';
import { createRegistry, type Registration, type Registry, type CheckIssue } from './registry.ts';

const axis = z.union([
  z.strictObject({ param: z.string(), values: z.array(quantity('*')).min(1) }),
  z.strictObject({ param: z.string(), range: z.strictObject({ start: quantity('*'), stop: quantity('*'), n: z.number().int().min(2) }) }),
]);

export const CORE: Registration[] = [
  { kind: 'study', type: 'parametric', owner: '@amp/spec',
    description: 'Sweep params around another study; axes row-major (first slowest); range = n points from start to stop inclusive',
    settings: z.strictObject({ study: nodeId, sweep: z.array(axis).min(1).max(4) }),
    check: (n, ctx) => {
      const out: CheckIssue[] = [];
      const s = n.settings as { study: string; sweep: Array<{ param: string; values?: unknown[]; range?: { start: unknown; stop: unknown } }> };
      const inner = ctx.studies.get(s.study);
      if (!inner) out.push({ path: ['settings', 'study'], message: `no study '${s.study}'` });
      else if (inner.type === 'parametric') out.push({ path: ['settings', 'study'], message: 'nested parametric studies are not supported' });
      const seen = new Set<string>();
      s.sweep.forEach((ax, i) => {
        if (seen.has(ax.param)) out.push({ path: ['settings', 'sweep', i, 'param'], message: `param '${ax.param}' swept twice` });
        seen.add(ax.param);
        const p = ctx.params.get(ax.param);
        if (!p) { out.push({ path: ['settings', 'sweep', i, 'param'], message: `no param '${ax.param}'` }); return; }
        const items: Array<[unknown, Array<string | number>]> = ax.values
          ? ax.values.map((v, j) => [v, ['values', j]])
          : [[ax.range!.start, ['range', 'start']], [ax.range!.stop, ['range', 'stop']]];
        for (const [v, sub] of items) {
          const r = ctx.resolve(v);
          if (r && r.dim.some((d, k) => Math.abs(d - (p.dim[k] ?? 0)) > 1e-9)) out.push({ path: ['settings', 'sweep', i, ...sub], message: `value has another dimension than param '${ax.param}'` });
        }
      });
      return out;
    } },
];

/** A registry with the core types only. */
export const coreRegistry = (): Registry => createRegistry(CORE);
