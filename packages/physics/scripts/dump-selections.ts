// SPDX-License-Identifier: GPL-3.0-or-later
// Selection dump (DevLog-036 G1): for every sims/*.yaml, mesh the spec (order 1; the entity table is order-independent),
// resolve every 'dom:' / 'bnd:' / 'pnt:' string of the spec with resolveEntityIds and print one JSON object
// {sim: {selection: {ids: [matched entity ids], mesh: 'cells|facets <n> <sha-256 of the sorted indices>'} | 'unknown'}
// | {error}}. `mesh` is the selected mesh entities (cells of domains, facets of boundaries, point nodes): equal `mesh`
// strings before / after a naming change mean the same entities are selected even when ids were renamed.
//   node --max-old-space-size=1536 packages/physics/scripts/dump-selections.ts > out.json
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseYaml } from '@amp/spec';
import { meshFromSpec } from '@amp/mesh/spec';
import { resolveEntityIds, type EntityKindKey, type EntityTable } from '@amp/geom';

const root = new URL('../../../sims/', import.meta.url);
const KIND: Record<string, EntityKindKey> = { dom: 'domains', bnd: 'boundaries', pnt: 'points', edg: 'edges' };

function strings(v: unknown, out: Set<string>): void {
  if (typeof v === 'string') { if (/^(dom|bnd|pnt|edg):/.test(v)) out.add(v); }
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) strings(x, out);
}

const res: Record<string, unknown> = {};
for (const f of readdirSync(root).filter((x) => x.endsWith('.yaml')).sort()) {
  const spec = parseYaml(readFileSync(new URL(f, root), 'utf8')).data as Record<string, unknown>;
  const sel = new Set<string>();
  strings({ ...spec, geometry: undefined }, sel);
  try {
    const t0 = performance.now();
    const m = meshFromSpec(spec, { order: 1 });
    const table = m.entities as EntityTable;
    const out: Record<string, unknown> = {};
    for (const s of [...sel].sort()) {
      const kind = KIND[s.slice(0, 3)]!;
      const r = resolveEntityIds(table, kind, [s]);
      const ids = r.indices.map((i) => table[kind]![i]!.id);
      const on = new Set(r.indices);
      const sel: number[] = [];
      if (kind === 'domains') m.cells.domain.forEach((d, c) => { if (on.has(d)) sel.push(c); });
      else if (kind === 'boundaries') {
        const nf = m.facets.boundary.length;
        m.facets.boundary.forEach((b, f) => { if (on.has(b)) sel.push(f); });
        const f2 = (m as { facets2?: { boundary: Int32Array } }).facets2;
        f2?.boundary.forEach((b, f) => { if (on.has(b)) sel.push(nf + f); });
      } else for (const i of r.indices) sel.push((m as { pointNode?: Int32Array }).pointNode?.[i] ?? -1);
      sel.sort((a, b) => a - b);
      const h = createHash('sha256').update(sel.join(',')).digest('hex').slice(0, 16);
      out[s] = r.unknown.length ? 'unknown' : { ids, mesh: `${kind === 'domains' ? 'cells' : kind === 'boundaries' ? 'facets' : 'nodes'} ${sel.length} ${h}` };
    }
    res[f] = out;
    process.stderr.write(`${f}: ${sel.size} selections, ${Math.round(performance.now() - t0)} ms\n`);
  } catch (e) {
    res[f] = { error: (e as Error).message.slice(0, 300) };
    process.stderr.write(`${f}: error ${(e as Error).message.slice(0, 120)}\n`);
  }
}
process.stdout.write(`${JSON.stringify(res, null, 1)}\n`);
