// SPDX-License-Identifier: GPL-3.0-or-later
// Results tools (lane R3, DevLog-028): evaluate, get_table, show_plot. Read-only (no op), navigation in the trail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, headJson, blockJson } from '../eval/fixtures.ts';
import { AgentSession } from '../src/session.ts';

const txt = (o: { content: Array<{ type: string; text?: string }> }) => (o.content[0] as { text: string }).text;

test('evaluate / get_table: kirsch kt from the evaluation group, read-only, paged, errors named', async () => {
  const fx = await fixture('kirsch-plate', { sessionId: 'r3' });
  const s = fx.session;
  const before = await s.execute('get_table', { table: 'ev_std1' });
  assert.equal(headJson(txt(before))?.error, 'table_failed', 'no solve yet: a named failure');
  assert.match(txt(before), /run_study first/);
  await s.execute('run_study', { study: 'std1', reason: 'test' });
  const t = await s.execute('get_table', { table: 'ev_std1' });
  assert.equal(t.isError, false, txt(t));
  const h = headJson(txt(t))!;
  assert.equal(h.total_rows, 1);
  assert.equal(h.stale, false);
  const b = blockJson(txt(t)) as { columns: Array<{ key: string; unit: string }>; rows: Array<Record<string, unknown>> };
  assert.equal(b.rows[0]!.kt, 3.021233775361685);
  assert.equal(b.columns.find((c) => c.key === 'kt')!.unit, '1');
  // evaluate on the item: the same value; ad hoc nodal max over a domain: an evaluation, nothing stored
  const e = await s.execute('evaluate', { node: 'kt' });
  assert.equal((blockJson(txt(e)) as { rows: Array<Record<string, unknown>> }).rows[0]!.kt, 3.021233775361685);
  const a = await s.execute('evaluate', { data: 'sol_std1', kind: 'max', expr: 'solid.mises', unit: 'MPa', over: ['dom:plate'] });
  assert.equal(a.isError, false, txt(a));
  assert.equal(headJson(txt(a))?.stored, false);
  assert.equal(fx.log.ops.length, 0, 'evaluate and get_table change nothing');
  // errors: unknown node, node + ad hoc, unknown table, results-only edit keeps the run fresh
  assert.equal(headJson(txt(await s.execute('evaluate', { node: 'nope' })))?.error, 'unknown_results_node');
  assert.equal(headJson(txt(await s.execute('evaluate', { node: 'kt', data: 'sol_std1' })))?.error, 'node_or_adhoc');
  assert.equal(headJson(txt(await s.execute('get_table', { table: 'kt' })))?.error, 'unknown_table');
  await s.execute('apply_ops', { ops: [{ op: 'replace', path: '/results/evaluations/@ev_std1/items/@kt/unit', value: '1' }], reason: 'test' });
  assert.equal(headJson(txt(await s.execute('get_table', { table: 'ev_std1' })))?.stale, false, 'a results edit does not make the solution stale');
  await s.execute('apply_ops', { ops: [{ op: 'replace', path: '/params/D/value', value: 8 }], reason: 'test' });
  assert.equal(headJson(txt(await s.execute('get_table', { table: 'ev_std1' })))?.stale, true, 'a geometry edit does');
});

test('show_plot: navigation (trail, no op), unknown plot and missing host hook named', async () => {
  const fx = await fixture('kirsch-plate', { sessionId: 'r3b' });
  const r = await fx.session.execute('show_plot', { plot: 'sxx' });
  assert.equal(r.isError, false, txt(r));
  assert.equal(fx.nav.state.plot, 'sxx');
  assert.ok(fx.session.trail.entries.some((e) => e.tool === 'show_plot' && e.ok));
  assert.equal(fx.log.ops.length, 0);
  assert.equal(headJson(txt(await fx.session.execute('show_plot', { plot: 'sxx_surf' })))?.error, 'unknown_plot', 'an item is not a plot group');
  const nav = { ...fx.nav, focusNode: fx.nav.focusNode.bind(fx.nav), openSettings: fx.nav.openSettings.bind(fx.nav), highlightSelection: fx.nav.highlightSelection.bind(fx.nav), setCamera: fx.nav.setCamera.bind(fx.nav), setViewMode: fx.nav.setViewMode.bind(fx.nav), screenshot: fx.nav.screenshot.bind(fx.nav), showPlot: undefined };
  const s2 = new AgentSession({ log: fx.log, registry: fx.registry, memory: fx.memory, nav, sessionId: 'r3c' });
  assert.equal(headJson(txt(await s2.execute('show_plot', { plot: 'sxx' })))?.error, 'show_plot_unavailable');
  assert.equal(headJson(txt(await s2.execute('evaluate', { node: 'kt' })))?.error, 'no_results_host');
});
