// SPDX-License-Identifier: GPL-3.0-or-later
// Lane S4 (DevLog-045): study-level linear solver setting (stationary settings.solver / rtol through runStudy and
// common/scalar.ts withStudySolver), block element slots on a real mesh, facet slots.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseYaml } from '@amp/spec';
import { prepareRun, runStudy } from '../src/index.ts';
import { autoSolverChoice, cellBlockPattern, cellBlockSlots, cellPattern, facetSlots, withStudySolver, STUDY_SOLVER_TYPES, AUTO_FLOPS_PER_DOF, AUTO_MAX_FACTOR_BYTES } from '../src/common/scalar.ts';
import { entryIndex } from '@amp/core/la/sparse';
import { NPC } from '../src/common/mesh.ts';

const base = parseYaml(readFileSync(new URL('../../../sims/poisson-square.yaml', import.meta.url), 'utf8')).data as Record<string, unknown>;
function withSettings(settings: Record<string, unknown> | undefined): Record<string, unknown> {
  const s = structuredClone(base) as { studies: Array<Record<string, unknown>> };
  if (settings) s.studies[0]!.settings = settings; else delete s.studies[0]!.settings;
  return s as unknown as Record<string, unknown>;
}
async function solve(settings?: Record<string, unknown>, hFactor = 0.5) {
  const prep = await prepareRun({ spec: withSettings(settings), hFactor });
  return runStudy(prep);
}
const fieldsOf = (s: { fields: Array<{ name: string; data: ArrayLike<number> }> }) => s.fields.map((f) => ({ name: f.name, data: Float64Array.from(f.data) }));

test('stationary settings.solver: direct and auto (below the threshold) are bitwise the default run; amg-pcg reports its tolerance', async () => {
  const ref = await solve();
  const direct = await solve({ solver: 'direct' });
  const auto = await solve({ solver: 'auto' });
  for (const s of [direct, auto]) {
    const a = fieldsOf(ref), b = fieldsOf(s);
    assert.equal(a.length, b.length);
    a.forEach((f, i) => assert.ok(f.data.every((x, q) => Object.is(x, b[i]!.data[q])), `${f.name} bitwise`));
    assert.ok((s as { notes?: string[] }).notes?.some((n) => n.includes('direct (Cholesky)')), 'note names the direct solver');
  }
  assert.ok((auto as { notes?: string[] }).notes?.some((n) => /auto: direct factor .* flop\/DOF </.test(n)), 'auto note gives the reason');
  const amg = await solve({ solver: 'amg-pcg', rtol: 1e-10 });
  assert.match(amg.stats.solver, /amg-pcg/);
  assert.match(amg.stats.solver, /rtol 1e-10/);
  assert.ok(amg.stats.residual !== undefined && amg.stats.residual <= 1e-10, `relative residual ${amg.stats.residual}`);
  const note = (amg as { notes?: string[] }).notes?.find((n) => n.startsWith('linear solver'));
  assert.ok(note && /amg-pcg, rtol 1e-10, 1 solve\(s\), iterations \d+-\d+, max relative residual/.test(note), note);
  // the AMG-PCG temperature agrees with the direct one to about the requested tolerance
  const T0 = fieldsOf(ref).find((f) => f.name === 'T')!.data, T1 = fieldsOf(amg).find((f) => f.name === 'T')!.data;
  let d = 0, mx = 0;
  for (let i = 0; i < T0.length; i++) { d = Math.max(d, Math.abs(T0[i]! - T1[i]!)); mx = Math.max(mx, Math.abs(T0[i]!)); }
  assert.ok(d / mx < 1e-7, `max |T_amg - T_direct| / max |T| = ${d / mx}`);
});

test("'auto' rule: flop per DOF and factor size thresholds", () => {
  assert.equal(autoSolverChoice(646625, 2.59e10, 4.87e7).kind, 'cholesky');   // 2D tri6 (DevLog-045 s.3.3)
  assert.equal(autoSolverChoice(35937, 2.74e10, 1.87e7).kind, 'amg-pcg');    // 3D tet10
  assert.equal(autoSolverChoice(1000, AUTO_FLOPS_PER_DOF * 1000, 1e5).kind, 'amg-pcg');
  assert.equal(autoSolverChoice(1000, AUTO_FLOPS_PER_DOF * 999, 1e5).kind, 'cholesky');
  assert.equal(autoSolverChoice(1e6, 1e9, AUTO_MAX_FACTOR_BYTES / 8 + 1).kind, 'amg-pcg');
});

test('stationary settings.solver: invalid values are rejected by the spec; non-scalar physics are untouched', async () => {
  await assert.rejects(prepareRun({ spec: withSettings({ solver: 'gmres' }) }), /spec invalid/);
  await assert.rejects(prepareRun({ spec: withSettings({ solver: 'amg-pcg', rtol: 2 }) }), /spec invalid/);
  assert.deepEqual([...STUDY_SOLVER_TYPES].sort(), ['currents', 'electrostatics', 'heat']);
  const out = await withStudySolver({ settings: { solver: 'amg-pcg' } }, 'elastic', async () => ({ stats: { solver: 'cholesky' } }));
  assert.deepEqual(out, { stats: { solver: 'cholesky' } });
});

test('cellBlockSlots and facetSlots match the per-entry search on a real tri6 mesh', async () => {
  const prep = await prepareRun({ spec: withSettings(undefined), hFactor: 1 });
  const m = prep.mesh;
  for (const bs of [1, 2, 3]) {
    const pat = cellBlockPattern(m, bs);
    const slots = cellBlockSlots(m, pat, bs);
    const k = NPC[m.cells.type]!, nd = k * bs, nc = m.cells.conn.length / k;
    for (let e = 0; e < nc; e++) for (let a = 0; a < nd; a++) for (let b = 0; b < nd; b++) {
      const row = bs * m.cells.conn[k * e + Math.floor(a / bs)]! + (a % bs), col = bs * m.cells.conn[k * e + Math.floor(b / bs)]! + (b % bs);
      if (slots[nd * nd * e + nd * a + b] !== entryIndex(pat, row, col)) assert.fail(`bs ${bs} e ${e} (${a}, ${b})`);
    }
  }
  const pat = cellPattern(m), kf = NPC[m.facets.type]!;
  const facets = Array.from({ length: m.facets.conn.length / kf }, (_, i) => i);
  const fs = facetSlots(m, pat, facets);
  assert.equal(facetSlots(m, pat, facets), fs, 'cached');
  facets.forEach((f, i) => { for (let a = 0; a < kf; a++) for (let b = 0; b < kf; b++) assert.equal(fs[kf * kf * i + kf * a + b], entryIndex(pat, m.facets.conn[kf * f + a]!, m.facets.conn[kf * f + b]!)); });
});
