// SPDX-License-Identifier: GPL-3.0-or-later
// Results adapter (lane R3, DevLog-028) on real solves: kirsch `kt` through the evaluation group equals the R0 value.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseYaml, resolveParams, runId } from '@amp/spec';
import { prepareRun, registry } from '@amp/physics';
import type { Mesh, Solution } from '@amp/spec/types';
import { evalTable, evalItemValue, type AdapterRun } from '../src/lib/results/adapter.ts';

const read = (id: string) => readFileSync(new URL(`../../../sims/${id}.yaml`, import.meta.url), 'utf8');

export async function solveSim(id: string, o: { text?: string; case?: Record<string, unknown>; hFactor?: number } = {}): Promise<{ spec: Record<string, unknown>; run: AdapterRun }> {
  const spec = parseYaml(o.text ?? read(id)).data as Record<string, unknown>;
  const st = (spec.studies as Array<{ id: string; physics: string[] }>)[0]!;
  const physicsId = st.physics[0]!;
  const ctx = await prepareRun({ spec, physicsId, ...(o.case ? { case: o.case } : {}), ...(o.hFactor !== undefined ? { hFactor: o.hFactor, level: 0 } : {}) });
  const type = (ctx.spec.physics ?? []).find((p) => p.id === ctx.physicsId)!.type;
  const sol = (await registry[type]!.run(ctx)) as Solution;
  return { spec, run: { key: await runId(sol.run), solution: sol, mesh: ctx.mesh as Mesh, params: resolveParams(spec.params).scope, studies: [st.id], label: '' } };
}

test('kirsch kt: evaluation group table = item value = 3.021233775361685 (10810 DOF)', async () => {
  const { spec, run } = await solveSim('kirsch-plate');
  assert.equal(run.solution.stats.dof, 10810);
  const t = evalTable(spec, 'ev_std1', [run]);
  assert.deepEqual(t.errors, []);
  const col = t.columns.findIndex((c) => c.key === 'kt');
  const v = t.rows[0]!.cells[col];
  console.log('kt', v, t.rows[0]!.meta[col], t.columns[col]);
  assert.equal(v, 3.021233775361685);
  const iv = evalItemValue(spec, 'kt', run);
  assert.ok('value' in iv && iv.value === 3.021233775361685);
});

// ---- gate: adapter values = R1 Node values on the same meshes (logs/r1-post-gates-20261107T070753Z.json) ----------
import { solveLevels, hFactorsOf } from '../../../packages/post/gates/r1-gates.ts';
import { cutLine, evalPoint } from '@amp/post';
import { evalDataset } from '../src/lib/results/adapter.ts';

const R1_LOG = JSON.parse(readFileSync(new URL('../../../logs/r1-post-gates-20261107T070753Z.json', import.meta.url), 'utf8')) as {
  runs: Array<{ sim: string; levels: Array<{ hFactor: number; meshHash: string }> }>;
  rows: Array<{ gate: string; levels: Array<{ hFactor: number; value?: number; error: number }> }>;
};

test('R1 gate 3: kirsch cut-line integral through a spec integral item = R1 values, every level, same meshes', async () => {
  const hk = hFactorsOf('eval/cases/a/SM-01.yaml');
  const K = await solveLevels('sims/kirsch-exact.yaml', [...hk, hk[hk.length - 1]! / 2], 'eval/cases/a/SM-01.yaml');
  const spec = parseYaml(read('kirsch-exact')).data as Record<string, any>;
  spec.results = {
    datasets: [{ id: 'sol_std1', type: 'solution', data: 'std1' }, { id: 'cl_x0', type: 'cutline', data: 'sol_std1', from: ['0 m', 'a'], to: ['0 m', 'L'] }],
    evaluations: [{ id: 'ev_line', data: 'cl_x0', items: [{ id: 'I_sxx', type: 'integral', expr: 'solid.sxx', unit: 'N/m' }] }],
  };
  const r1 = R1_LOG.rows.find((r) => r.gate === '3')!.levels;
  const hashes = R1_LOG.runs.find((r) => r.sim === 'sims/kirsch-exact.yaml')!.levels;
  for (const [k, l] of K.levels.entries()) {
    assert.equal(l.mesh.hash, hashes[k]!.meshHash, `level ${l.hFactor}: mesh differs from R1`);
    const run: AdapterRun = { key: `k${k}`, solution: l.sol, mesh: l.mesh, params: K.params as never, studies: ['std1'], label: '' };
    const t = evalTable(spec, 'ev_line', [run]);
    const ci = t.columns.findIndex((c) => c.key === 'I_sxx');
    const si = t.rows[0]!.meta[ci]!.si;
    console.log(`gate3 h ${l.hFactor} dof ${l.dof}: adapter ${si} N/m, R1 ${r1[k]!.value} N/m, method ${t.rows[0]!.meta[ci]!.method}`);
    assert.equal(si, r1[k]!.value, `level ${l.hFactor}`);
    assert.equal(t.rows[0]!.cells[ci], si, 'N/m display = SI');
  }
});

test('R1 coax V(r): spec cutline values = R1 kernel values (radial line phi = 0.3, 1001 points, snap 1e-6), same meshes', async () => {
  const C = await solveLevels('sims/coax-line.yaml', hFactorsOf('eval/cases/a/EM-01.yaml'), 'eval/cases/a/EM-01.yaml');
  const P = C.params as ReadonlyMap<string, { si: number }>;
  const ra = P.get('a')!.si, rb = P.get('b')!.si, phi = 0.3, lnba = Math.log(rb / ra);
  const p0 = [ra * Math.cos(phi), ra * Math.sin(phi)], p1 = [rb * Math.cos(phi), rb * Math.sin(phi)];
  const spec = parseYaml(read('coax-line')).data as Record<string, any>;
  spec.results.datasets.push({ id: 'cl_r', type: 'cutline', data: 'sol_std1', from: { value: p0, unit: 'm' }, to: { value: p1, unit: 'm' }, n: 1001 });
  const hashes = R1_LOG.runs.find((r) => r.sim === 'sims/coax-line.yaml')!.levels;
  const r5a = R1_LOG.rows.find((r) => r.gate === '5a')!.levels as Array<{ error: number }>;
  for (const [k, l] of C.levels.entries()) {
    assert.equal(l.mesh.hash, hashes[k]!.meshHash, `level ${l.hFactor}: mesh differs from R1`);
    const run: AdapterRun = { key: `c${k}`, solution: l.sol, mesh: l.mesh, params: C.params as never, studies: ['std1'], label: '' };
    const d = evalDataset(spec, 'cl_r', 'es.V', run, { unit: 'V' });
    const U = cutLine(l.mesh, p0, p1, { n: 1001, snap: 1e-6 });
    const ref = evalPoint(l.sol, 'es.V', U.points, { params: C.params, physicsId: 'es' }).values;
    assert.equal(d.values!.length, ref.length);
    let same = 0, maxErr = 0;
    for (let i = 0; i < ref.length; i++) {
      if (Object.is(d.values![i], ref[i])) same++;
      if (!Number.isFinite(d.values![i])) continue;
      const x = d.points[2 * i]!, y = d.points[2 * i + 1]!;
      maxErr = Math.max(maxErr, Math.abs(d.values![i]! - Math.log(rb / Math.sqrt(x * x + y * y)) / lnba));
    }
    console.log(`coax h ${l.hFactor} dof ${l.dof}: ${same}/${ref.length} values bitwise equal to the R1 kernel call (${d.outside.length} outside the mesh, NaN in both); max |V - ln(b/r)/ln(b/a)| over the inside points ${maxErr.toExponential(4)} V`);
    assert.equal(same, ref.length);
    // R1 gate 5a (logged): max error over crossing + uniform + quadrature point sets of this line; the uniform set is
    // part of it, so the adapter's error on it cannot exceed the logged level error
    assert.ok(maxErr <= r5a[k]!.error, `level ${l.hFactor}: ${maxErr} > R1 gate-5a ${r5a[k]!.error}`);
  }
});

// ---- audit fixes (DevLog-028 s.7) ------------------------------------------------------------------------------
test('datasets reading a join / mirror parent are not evaluated (never the root value)', async () => {
  const { spec, run } = await solveSim('kirsch-plate');
  const r = spec.results as Record<string, any>;
  r.datasets.push(
    { id: 'j', type: 'join', a: 'sol_std1', b: 'sol_std1', op: 'difference' },
    { id: 'j_pt', type: 'cutpoint', data: 'j', points: [['20 mm', '20 mm']] },
    { id: 'm', type: 'mirror', data: 'sol_std1', planes: [{ normal: [1, 0] }] },
    { id: 'm_cl', type: 'cutline', data: 'm', from: ['-50 mm', '20 mm'], to: ['50 mm', '20 mm'] },
  );
  r.evaluations.push({ id: 'ev_x', items: [{ id: 'jv', type: 'point', data: 'j_pt', expr: 'solid.sxx' }, { id: 'mI', type: 'integral', data: 'm_cl', expr: 'solid.sxx' }] });
  const t = evalTable(spec, 'ev_x', [run]);
  for (const k of ['jv', 'mI']) {
    const ci = t.columns.findIndex((c) => c.key === k);
    assert.equal(t.rows[0]!.cells[ci], null, k);
    assert.match(t.rows[0]!.errors[ci]!, /not evaluated yet/, k);
  }
});

test('steps: item > group > dataset; rows are the union of the items selections', async () => {
  const { spec, run } = await solveSim('wr90-te-cutoffs');
  const n = run.solution.steps!.values.length;
  assert.ok(n >= 2, `${n} modes`);
  const r = spec.results as Record<string, any>;
  r.datasets[0].steps = 'last';
  r.evaluations.push({ id: 'ev_s', data: 'sol_eig', items: [{ id: 'p0', type: 'max', expr: 'hz.p', over: ['dom:guide'], method: 'nodal', steps: 0 }, { id: 'pl', type: 'max', expr: 'hz.p', over: ['dom:guide'], method: 'nodal' }] });
  const dom = (run.mesh.entities.domains[0] as { id: string }).id;
  for (const it of r.evaluations.at(-1).items) it.over = [dom];
  const t = evalTable(spec, 'ev_s', [run]);
  assert.deepEqual(t.rows.map((x) => x.step), [0, n - 1]);
  const c0 = t.columns.findIndex((c) => c.key === 'p0'), cl = t.columns.findIndex((c) => c.key === 'pl');
  assert.equal(typeof t.rows[0]!.cells[c0], 'number', 'item steps 0 evaluated at step 0');
  assert.equal(t.rows[0]!.cells[cl], null, 'dataset steps last: not at step 0');
  assert.equal(t.rows[1]!.cells[c0], null);
  assert.equal(typeof t.rows[1]!.cells[cl], 'number');
  const v0 = evalItemValue(spec, 'p0', run);
  assert.ok('value' in v0 && v0.si === t.rows[0]!.meta[c0]!.si, 'evalItemValue = table cell (item steps)');
  assert.match(t.columns[c0]!.tip, /solver normalization/, 'eigen columns state the arbitrary scale');
});
