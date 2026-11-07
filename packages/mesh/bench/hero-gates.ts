// SPDX-License-Identifier: GPL-3.0-or-later
// L3 gate: mesh the H1-H6 hero specs in sims/*.yaml (geometry and mesh blocks as written by L2, dimensions from the
// R3 eval cases) and check that every entity id the spec selects exists in the mesh entity table and has cells or
// facets. Each spec is first validated against @amp/spec with the @amp/geom feature registrations (replacing the
// provisional seed). Median of 5 runs after 1 warm-up; element count, quality, hash (stable over the 5 runs).
// Extra rows: a finned plate (no sim yet), the AC-02 box as extruded tets, and a > 80k-vertex 2D mesh.
// JSONL to logs/l3-hero-gates-<stamp>.jsonl. Run: nice -n 10 node --max-old-space-size=1536 packages/mesh/bench/hero-gates.ts

import { mkdirSync, appendFileSync, readFileSync } from 'node:fs';
import { parseYaml, parseSpecText } from '@amp/spec';
import { wave1Registry } from '@amp/spec/provisional';
import { registerGeomFeatures } from '@amp/geom/spec';
import { buildGeometry2D, resolveEntityIds, type Feature, type Mesh } from '@amp/geom';
import { mesh2d, meshExtruded } from '../src/index.ts';
import { meshFromSpec } from '../src/spec.ts';

const root = new URL('../../../', import.meta.url);
const mm = 1e-3;
interface Row { id: string; what: string; src: string; build: () => Mesh; selected: string[]; valid: string }

const reg = registerGeomFeatures(wave1Registry());
const fromSim = (hero: string, file: string, what: string, order: 1 | 2): Row => {
  const text = readFileSync(new URL(`sims/${file}`, root), 'utf8');
  const v = parseSpecText(text, reg);
  const errs = v.issues.filter((i) => (i as { severity?: string }).severity !== 'warning');
  const data = parseYaml(text).data as Record<string, unknown>;
  const selected = [...new Set(text.match(/(dom|bnd|pnt|edg):[A-Za-z0-9_.#&@-]+/g) ?? [])].sort();
  return { id: hero, what, src: `sims/${file}`, build: () => meshFromSpec(data, { order }), selected, valid: errs.length ? `invalid: ${errs.map((i) => i.message).join('; ')}` : 'valid' };
};

const fins: Feature[] = [{ id: 'base', type: 'rect', x: [0, 100 * mm], y: [0, 10 * mm] }];
for (let k = 0; k < 5; k++) fins.push({ id: `fin${k}`, type: 'rect', x: [(9 + 20 * k) * mm, (11 + 20 * k) * mm], y: [10 * mm, 50 * mm] });
fins.push({ id: 'plate', type: 'union', inputs: ['base', 'fin0', 'fin1', 'fin2', 'fin3', 'fin4'] });

const rows: Row[] = [
  fromSim('H1', 'kirsch-plate.yaml', 'Kirsch quarter plate, tri6', 2),
  fromSim('H2', 'heat-plate-fin.yaml', 'NAFEMS T4 plate, tri6', 2),
  fromSim('H3', 'helmholtz-coil.yaml', 'axisym Helmholtz coil + air box, tri6', 2),
  fromSim('H4', 'si-rib-waveguide.yaml', 'rib waveguide cross-section, tri6', 2),
  fromSim('H5', 'cylinder-cavity.yaml', 'cylinder cavity, extruded tet4', 1),
  fromSim('H6', 'box-acoustics.yaml', 'AC-02 box, structured hex8', 1),
  { id: 'H2b', what: 'finned plate (placeholder dims), tri6', src: 'bench (base 100 x 10 mm, 5 fins 2 x 40 mm)', selected: [], valid: 'n/a',
    build: () => mesh2d(buildGeometry2D({ features: fins }), { hmax: 1 * mm, order: 2 }) },
  { id: 'H6t', what: 'AC-02 box, extruded tet4', src: 'bench (1.0 x 0.8 x 0.6 m, h 50 mm)', selected: [], valid: 'n/a',
    build: () => meshExtruded(buildGeometry2D({ features: [{ id: 'room', type: 'rect', x: [0, 1], y: [0, 0.8] }] }), [{ id: 'air', z: [0, 0.6] }], { mesh2d: { hmax: 0.05 }, dz: 0.05 }) },
  { id: 'H1f', what: 'H1 past the EO 80k-vertex cap, tri3', src: 'bench (as H1, h 0.05 mm at hole, hmax 0.3 mm)', selected: [], valid: 'n/a',
    build: () => mesh2d(buildGeometry2D({ features: [{ id: 'quarter', type: 'rect', x: [0, 0.1], y: [0, 0.1] }, { id: 'hole', type: 'circle', c: [0, 0], r: 5 * mm }, { id: 'plate', type: 'difference', target: 'quarter', tools: ['hole'] }] }),
      { hmax: 0.3 * mm, refine: [{ select: ['bnd:hole.edge'], h: 0.05 * mm, grade: 0.15 }] }) },
];

const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
mkdirSync(new URL('logs/', root), { recursive: true });
const log = new URL(`logs/l3-hero-gates-${stamp}.jsonl`, root);
for (const h of rows) {
  h.build();
  const ts: number[] = [];
  const hashes = new Set<string>();
  let M: Mesh | null = null;
  for (let r = 0; r < 5; r++) {
    const t0 = performance.now();
    M = h.build();
    ts.push(performance.now() - t0);
    hashes.add(M.hash);
  }
  ts.sort((a, b) => a - b);
  const m = M!;
  // selected ids through the canonical resolver; each must resolve and carry cells (domains) or facets (boundaries)
  const dUsed = new Set(m.cells.domain), bUsed = new Set(m.facets.boundary);
  if (m.facets2) for (const b of m.facets2.boundary) bUsed.add(b);
  const KIND = { dom: 'domains', bnd: 'boundaries', pnt: 'points', edg: 'edges' } as const;
  const missing = h.selected.filter((id) => {
    const kind = KIND[id.slice(0, 3) as keyof typeof KIND];
    const r = resolveEntityIds(m.entities, kind, [id]);
    if (r.unknown.length) return true;
    if (kind === 'domains') return !r.indices.some((i) => dUsed.has(i));
    if (kind === 'boundaries') return !r.indices.some((i) => bUsed.has(i));
    return false;
  });
  const nn = m.nodes.length / m.dim, q = m.quality ?? {};
  const rec = {
    hero: h.id, what: h.what, src: h.src, specValidation: h.valid, ts: new Date().toISOString(), median_ms: ts[2], min_ms: ts[0], max_ms: ts[4],
    cellType: m.cells.type, cells: m.cells.domain.length, nodes: nn, facetType: m.facets.type, facets: m.facets.boundary.length + (m.facets2?.boundary.length ?? 0),
    domains: m.entities.domains.map((e) => e.id), boundaries: m.entities.boundaries.map((e) => e.id), selected: h.selected, missing,
    quality: q, warnings: m.warnings ?? [], hash: m.hash, tagHash: m.tagHash, hashStable: hashes.size === 1, platform: { node: process.version, arch: process.arch },
  };
  appendFileSync(log, JSON.stringify(rec) + '\n');
  const qs = q.minAngleDeg !== undefined ? `min angle ${q.minAngleDeg.toFixed(1)} deg, q_min ${q.minShape!.toFixed(3)}`
    : q.minDihedralDeg !== undefined ? `min dihedral ${q.minDihedralDeg.toFixed(1)} deg, q_min ${q.minShape!.toFixed(3)}`
      : `q_min ${q.minShape!.toFixed(3)}, inverted ${q.nInverted}`;
  const ids = h.selected.length ? `${h.selected.length - missing.length}/${h.selected.length}${missing.length ? ` missing ${missing.join(' ')}` : ''}` : 'n/a';
  console.log(`| ${h.id} | ${h.what} | ${h.valid} | ${ts[2]!.toFixed(1)} | ${m.cells.domain.length} ${m.cells.type} / ${nn} | ${rec.facets} | ${m.entities.domains.length} / ${m.entities.boundaries.length} | ${ids} | ${qs} | \`${m.hash.slice(0, 16)}\` ${hashes.size === 1 ? 'stable' : 'UNSTABLE'} |`);
}
console.log(`log: logs/l3-hero-gates-${stamp}.jsonl`);
