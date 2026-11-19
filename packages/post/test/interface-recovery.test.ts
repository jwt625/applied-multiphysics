// SPDX-License-Identifier: GPL-3.0-or-later
// Interface-aware reading of derived fields (DevLog-059): per-domain recovery for points, lines, max / min, integrals and
// averages; element values on request; unchanged reading of fields without element values or without interfaces.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boxMesh, rectTriMesh, nCells, nNodes, NPC } from '@amp/physics/common/mesh';
import type { FieldData, Mesh, Solution } from '@amp/spec/types';
import {
  attachMesh, evalAverage, evalIntegral, evalMax, evalPoint, evaluateExpr, evaluateField, extrema, integrate, interpolate, locatePoints,
  recoverPerDomain, sample,
} from '../src/index.ts';

type Fn = (x: number[]) => number;

/** Split a single-domain mesh into two domains by the cell centroid (x < xs: domain 0, else 1). */
function twoDomains(m: Mesh, xs: number): Mesh {
  const k = NPC[m.cells.type], dim = m.dim, nc = nCells(m), domain = new Int32Array(nc);
  for (let c = 0; c < nc; c++) {
    let x = 0; for (let a = 0; a < k; a++) x += m.nodes[dim * m.cells.conn[k * c + a]!]! / k;
    domain[c] = x < xs ? 0 : 1;
  }
  return { ...m, hash: `${m.hash}-2dom`, cells: { ...m.cells, domain }, entities: { ...m.entities, domains: [{ id: 'dom:left' }, { id: 'dom:right' }] } };
}

/** A derived field as a producer gives it: element values = the domain's function at each cell node; data = the
 *  count-weighted mean of the element values at each node over every cell (across domains). `skip`: cells left out. */
function derivedField(m: Mesh, fs: Fn[], o: { name?: string; skip?: (c: number) => boolean } = {}): FieldData & { elementNodal: Float64Array } {
  const k = NPC[m.cells.type], dim = m.dim, nc = nCells(m), nn = nNodes(m);
  const el = new Float64Array(nc * k).fill(NaN), acc = new Float64Array(nn), cnt = new Float64Array(nn);
  for (let c = 0; c < nc; c++) {
    if (o.skip?.(c)) continue;
    const f = fs[m.cells.domain[c]!]!;
    for (let a = 0; a < k; a++) {
      const v = m.cells.conn[k * c + a]!, x = Array.from({ length: dim }, (_, d) => m.nodes[dim * v + d]!);
      el[k * c + a] = f(x); acc[v]! += f(x); cnt[v]!++;
    }
  }
  for (let v = 0; v < nn; v++) if (cnt[v]) acc[v]! /= cnt[v]!;
  return { name: o.name ?? 's', unit: 'Pa', space: m.cells.type === 'tri6' || m.cells.type === 'tet10' ? 'H1P2' : 'H1P1', components: 1, data: acc, elementNodal: el };
}

const solOf = (m: Mesh, fields: FieldData[]): Solution => {
  const sol = { meshHash: m.hash, fields, scalars: {}, stats: { dof: nNodes(m), solver: 'none' }, timing: {},
    run: { engine: 'test', specHash: '0'.repeat(64), meshHash: m.hash, startedAt: '2026-11-18T00:00:00.000-08:00', platform: { runtime: 'node' }, fidelity: 'rigorous' } } as Solution;
  attachMesh(sol, m);
  return sol;
};
const plain = (f: FieldData): FieldData => ({ name: f.name, unit: f.unit, space: f.space, components: f.components, data: f.data });

const left: Fn = ([x, y]) => 1 + 2 * x! - y!;
const right: Fn = ([x, y]) => 5 - x! + 3 * y!;

test('no interface: per-domain recovery is null and every reader is bitwise the field without element values', () => {
  const m = rectTriMesh({ x: [0, 1], y: [0, 1], nx: 6, ny: 5, order: 2 });
  // a field that is not reproduced by the element basis, so data differs from the element values
  const f = derivedField(m, [([x, y]) => Math.sin(3 * x!) * Math.exp(y!)]);
  assert.equal(recoverPerDomain(m, f), null);
  const ps = locatePoints(m, [0.13, 0.27, 0.5, 0.5, 0.91, 0.08, 0.333, 0.999]);
  const a = interpolate(f, ps, { grad: true }), b = interpolate(plain(f), ps, { grad: true });
  assert.deepEqual(Array.from(a.values), Array.from(b.values));
  assert.deepEqual(Array.from(a.grad!), Array.from(b.grad!));
  const flat = [0.21, 0.73, 0.64, 0.12];
  assert.deepEqual(Array.from(evaluateField(m, f, flat).values), Array.from(evaluateField(m, plain(f), flat).values));
  const s1 = solOf(m, [f]), s2 = solOf(m, [plain(f)]);
  assert.equal(evalMax(s1, 's', { kind: 'domain' }).value, evalMax(s2, 's', { kind: 'domain' }).value);
  assert.deepEqual(extrema(m, f), extrema(m, plain(f)));
  // integrals and averages (domain and cut line) are bitwise the old reading; 'element' reads the element values
  assert.equal(evalIntegral(s1, 's', { kind: 'domain' }).value, evalIntegral(s2, 's', { kind: 'domain' }).value);
  assert.equal(evalAverage(s1, 's', { kind: 'domain' }).value, evalAverage(s2, 's', { kind: 'domain' }).value);
  assert.equal(integrate(m, f)[0], integrate(m, plain(f))[0]);
  assert.notDeepEqual(Array.from(interpolate(f, ps, { derived: 'element' }).values), Array.from(b.values));
});

test('two domains (tri6): one value per domain at interface nodes, exact per-domain point values, cut across the interface', () => {
  const m = twoDomains(rectTriMesh({ x: [0, 1], y: [0, 1], nx: 8, ny: 6, order: 2 }), 0.5);
  const f = derivedField(m, [left, right]);
  const rec = recoverPerDomain(m, f)!;
  assert.ok(rec, 'interface present');
  const k = 6;
  let worst = 0;
  for (let c = 0; c < nCells(m); c++)
    for (let a = 0; a < k; a++) {
      const v = m.cells.conn[k * c + a]!, x = [m.nodes[2 * v]!, m.nodes[2 * v + 1]!];
      worst = Math.max(worst, Math.abs(rec[k * c + a]! - [left, right][m.cells.domain[c]!]!(x)));
    }
  assert.ok(worst <= 1e-12, `recovered vs exact per domain: ${worst}`);
  const sol = solOf(m, [f]);
  // points just left / right of the interface: the side's own function (default 'recovered'); 'averaged' mixes them
  const pts = [[0.5 - 1e-9, 0.3], [0.5 + 1e-9, 0.3], [0.4999, 0.71], [0.5001, 0.71]];
  const r = evalPoint(sol, 's', pts), av = evalPoint(sol, 's', pts, { derived: 'averaged' });
  pts.forEach((p, i) => {
    const ex = (p[0]! < 0.5 ? left : right)(p);
    assert.ok(Math.abs(r.values[i]! - ex) <= 1e-6, `point ${i}: ${r.values[i]} vs ${ex}`);
    assert.ok(Math.abs(av.values[i]! - ex) > 0.1, `averaged mixes the sides at point ${i}`);
  });
  // sample (eval harness probes) and expressions read the same per-domain values
  const sv = sample(sol, 's', pts);
  pts.forEach((_, i) => assert.equal(sv[i], r.values[i]));
  const e = evaluateExpr(sol, '2 * s', pts);
  pts.forEach((_, i) => assert.equal(e.values[i], 2 * r.values[i]!));
  // gradients per domain
  const gx = evalPoint(sol, 'd(s, x)', [[0.49, 0.5], [0.51, 0.5]]);
  assert.ok(Math.abs(gx.values[0]! - 2) < 1e-9 && Math.abs(gx.values[1]! + 1) < 1e-9, `d(s, x): ${Array.from(gx.values)}`);
});

test('two domains: integrals and averages per domain (recovered and element values exact here), max / min nodal per domain', () => {
  const m = twoDomains(rectTriMesh({ x: [0, 1], y: [0, 1], nx: 8, ny: 6, order: 2 }), 0.5);
  const f = derivedField(m, [left, right]);
  const sol = solOf(m, [f]);
  const L = { kind: 'domain' as const, ids: ['dom:left'] }, R = { kind: 'domain' as const, ids: ['dom:right'] };
  // int over [0, 0.5] x [0, 1] of 1 + 2x - y = 0.5; over [0.5, 1] x [0, 1] of 5 - x + 3y = 2.875
  const iL = evalIntegral(sol, 's', L), aR = evalAverage(sol, 's', R);
  assert.ok(Math.abs(iL.value - 0.5) < 1e-13, `left integral ${iL.value}`);
  assert.ok(Math.abs(aR.value - 2.875 / 0.5) < 1e-13, `right average ${aR.value}`);
  assert.doesNotMatch(iL.method, /_element_values/);
  const eL = evalIntegral(sol, 's', L, { derived: 'element' });
  assert.ok(Math.abs(eL.value - 0.5) < 1e-13, `left integral, element values ${eL.value}`);
  assert.match(eL.method, /_element_values$/);
  assert.equal(eL.continuous, false);
  assert.ok(Math.abs(integrate(m, f, { select: ['dom:left'] })[0]! - 0.5) < 1e-13);
  assert.ok(Math.abs(integrate(m, f, { select: ['dom:left'], derived: 'element' })[0]! - 0.5) < 1e-13);
  // the old reading (nodal mean across the interface) is off by a layer of one cell
  const old = evalIntegral(sol, 's', L, { derived: 'averaged' });
  assert.ok(Math.abs(old.value - 0.5) > 1e-3, `averaged integral ${old.value}`);
  assert.doesNotMatch(old.method, /_element_values/);
  // max of 1 + 2x - y over the left domain: 2 at (0.5, 0); the averaged value there mixes in 4.5
  const mx = evalMax(sol, 's', L);
  assert.ok(Math.abs(mx.value - 2) < 1e-12, `left max ${mx.value}`);
  assert.deepEqual(mx.at, [0.5, 0]);
  assert.ok(evalMax(sol, 's', L, { derived: 'averaged' }).value > 2.5);
  assert.ok(Math.abs(extrema(m, f, { select: ['dom:left'] }).max - 2) < 1e-12);
  // lattice and quad methods read the same per-domain values
  assert.ok(Math.abs(evalMax(sol, 's', L, { method: 'lattice', resolution: 3 }).value - 2) < 1e-12);
});

test('cells left out by the producer (NaN element values): not a domain at a node, element mode reads data there', () => {
  const m0 = twoDomains(rectTriMesh({ x: [0, 1], y: [0, 1], nx: 4, ny: 4, order: 2 }), 0.5);
  // the right domain is outside the physics: element values NaN, data from the left cells only
  const f = derivedField(m0, [left, right], { skip: (c) => m0.cells.domain[c] === 1 });
  assert.equal(recoverPerDomain(m0, f), null, 'one active domain: no interface');
  const sol = solOf(m0, [f]);
  const all = evalIntegral(sol, 's', { kind: 'domain' }, { derived: 'element' }), avg = evalIntegral(sol, 's', { kind: 'domain' }, { derived: 'averaged' });
  assert.ok(Number.isFinite(all.value));
  const iL = evalIntegral(sol, 's', { kind: 'domain', ids: ['dom:left'] }, { derived: 'element' });
  assert.ok(Math.abs(iL.value - 0.5) < 1e-13);
  // right cells: data at their nodes, as before
  const iR = evalIntegral(sol, 's', { kind: 'domain', ids: ['dom:right'] }, { derived: 'element' }), iRold = evalIntegral(sol, 's', { kind: 'domain', ids: ['dom:right'] }, { derived: 'averaged' });
  assert.equal(iR.value, iRold.value);
  assert.ok(Math.abs(all.value - (iL.value + iR.value)) < 1e-12 && Number.isFinite(avg.value));
});

test('two domains (tet10): exact per-domain recovery and volume means (recovered and element values)', () => {
  const m = twoDomains(boxMesh({ x: [0, 1], y: [0, 1], z: [0, 1], nx: 4, ny: 3, nz: 2, cell: 'tet10' }), 0.5);
  const l3: Fn = ([x, y, z]) => 1 + 2 * x! - y! + 0.5 * z!, r3: Fn = ([x, y, z]) => -3 + x! + y! - 2 * z!;
  const f = derivedField(m, [l3, r3]);
  const sol = solOf(m, [f]);
  const pts = [[0.5 - 1e-9, 0.4, 0.3], [0.5 + 1e-9, 0.4, 0.3]];
  const v = evalPoint(sol, 's', pts);
  assert.ok(Math.abs(v.values[0]! - l3(pts[0]!)) < 1e-6 && Math.abs(v.values[1]! - r3(pts[1]!)) < 1e-6, `${Array.from(v.values)}`);
  // mean of l3 over [0, 0.5] x [0, 1]^2 = 1 + 0.5 - 0.5 + 0.25 = 1.25; of r3 over [0.5, 1] x [0, 1]^2 = -3 + 0.75 + 0.5 - 1 = -2.75
  const aL = evalAverage(sol, 's', { kind: 'domain', ids: ['dom:left'] }), aR = evalAverage(sol, 's', { kind: 'domain', ids: ['dom:right'] });
  assert.ok(Math.abs(aL.value - 1.25) < 1e-12 && Math.abs(aR.value + 2.75) < 1e-12, `${aL.value} ${aR.value}`);
  const eL = evalAverage(sol, 's', { kind: 'domain', ids: ['dom:left'] }, { derived: 'element' });
  assert.ok(Math.abs(eL.value - 1.25) < 1e-12, `${eL.value}`);
});

// DevLog-066: recovery groups from the producer's constitutive groups (FieldData.cellGroup), not the geometric domains
import { solveElastic } from '@amp/physics';
import { recoveryGroups } from '../src/index.ts';

test('cellGroup: a boundary between two domains of one material is not an interface; distinct materials keep one value per side', async () => {
  const base = rectTriMesh({ x: [0, 1], y: [0, 0.25], nx: 8, ny: 2, order: 2 });
  const m = { ...twoDomains(base, 0.5), hash: base.hash };   // the run record needs a sha-256 mesh hash
  const nc = nCells(m), fill = (v: number) => new Float64Array(nc).fill(v);
  const bcs = [{ type: 'fixed' as const, select: ['bnd:rect.left'] }, { type: 'traction' as const, select: ['bnd:rect.right'], t: [0, -1e6] }];
  // same constants in both domains: one group, recovery null (data, the smooth nodal mean), bitwise the field read as averaged
  const same = await solveElastic({ mesh: m, model: 'plane-stress', E: fill(170e9), nu: fill(0.28), bcs });
  const sxx = same.fields.find((f) => f.name === 'sxx')! as FieldData & { cellGroup?: Int32Array };
  assert.ok(sxx.cellGroup && sxx.cellGroup.every((g) => g === 0));
  assert.equal(recoverPerDomain(m, sxx), null);
  const ps = locatePoints(m, [[0.5, 0.1], [0.5, 0.0], [0.25, 0.2]]);
  const rec = interpolate(sxx, ps).values, avg = interpolate(sxx, ps, { derived: 'averaged' }).values;
  assert.ok(rec.every((v, i) => Object.is(v, avg[i])), 'same material: recovered = averaged (bitwise)');
  // without cellGroup (older producers): the geometric domain rule (one value per domain at x = 0.5)
  const { cellGroup: _g, ...noGroup } = sxx;
  assert.notEqual(recoverPerDomain(m, noGroup as FieldData), null);
  // a cellGroup with -1 on a cell that has element values: domain fallback
  assert.equal(recoveryGroups(m, { ...sxx, cellGroup: new Int32Array(nc).fill(-1) } as FieldData), m.cells.domain);
  // distinct constants: groups = domains here, the recovery equals the domain-keyed one (bitwise)
  const E2 = Float64Array.from({ length: nc }, (_, c) => (m.cells.domain[c] === 0 ? 170e9 : 70e9));
  const two = await solveElastic({ mesh: m, model: 'plane-stress', E: E2, nu: fill(0.28), bcs });
  const s2 = two.fields.find((f) => f.name === 'sxx')! as FieldData & { cellGroup?: Int32Array };
  assert.deepEqual(Array.from(new Set(s2.cellGroup)), [0, 1]);
  const { cellGroup: _h, ...s2NoGroup } = s2;
  const a = recoverPerDomain(m, s2)!, b = recoverPerDomain(m, s2NoGroup as FieldData)!;
  assert.ok(a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i])));
});
