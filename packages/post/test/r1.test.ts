// SPDX-License-Identifier: GPL-3.0-or-later
// R1 kernels (DevLog-026) on structured fixture meshes: every reference is a closed form of a polynomial field that
// the P2 / P1 basis represents exactly, so the checks are at round-off.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boxMesh, rectTriMesh, nNodes } from '@amp/physics/common/mesh';
import type { FieldData, Mesh, Solution } from '@amp/spec/types';
import {
  attachMesh, compileFieldExpr, evaluateExpr, cutLine, cutPoints, edgeDataset, lineCrossings, solutionSteps, evalIntegral, evalAverage,
  evalMax, evalMin, evalMeasure, evalPoint, evalGlobal, integrate, sample, locatePoints,
} from '../src/index.ts';

const nodal = (m: Mesh, name: string, unit: string, f: (x: number[]) => number[], space: 'H1P1' | 'H1P2' = 'H1P2', step?: number): FieldData => {
  const nn = m.nodes.length / m.dim, nc = f(Array(m.dim).fill(0)).length;
  const data = new Float64Array(nn * nc);
  for (let i = 0; i < nn; i++) { const v = f(Array.from(m.nodes.subarray(m.dim * i, m.dim * i + m.dim))); for (let j = 0; j < nc; j++) data[nc * i + j] = v[j]!; }
  return { name, unit, space, components: nc as 1 | 2 | 3, data, ...(step !== undefined ? { step } : {}) };
};
const solOf = (m: Mesh, fields: FieldData[], extra: Partial<Solution> = {}): Solution => attachMesh({
  meshHash: m.hash, fields, scalars: {}, stats: { dof: nNodes(m), solver: 'none' }, timing: {},
  run: { engine: 'test', specHash: '0'.repeat(64), meshHash: m.hash, startedAt: '2026-11-06T00:00:00.000-08:00', platform: { runtime: 'node' }, fidelity: 'rigorous' },
  ...extra,
} as Solution, m);
const close = (a: number, b: number, tol: number, what = '') => assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${what}: ${a} vs ${b} (diff ${a - b})`);

const m2 = rectTriMesh({ x: [0, 2], y: [0, 1], nx: 6, ny: 4, order: 2 });
const T = (x: number, y: number) => 1 + 2 * x - y + x * y + 0.5 * x * x;   // quadratic: exact in P2
const s2 = solOf(m2, [nodal(m2, 'T', 'K', ([x, y]) => [T(x!, y!)]), nodal(m2, 'u', 'm', ([x, y]) => [x! * y!, x! - y!])], { scalars: { Q: { value: 3, unit: 'W' } } });

test('expressions: fields, components, params, units, d(), defs, errors', () => {
  const pts = [[0.3, 0.7], [1.9, 0.05], [1.234, 0.5]];
  const r = evaluateExpr(s2, 'heat.T*2 + dT', pts, { physicsId: 'heat', params: { dT: { si: 0.5, unit: 'K' } } });
  assert.equal(r.unit, 'K');
  pts.forEach(([x, y], i) => close(r.values[i]!, 2 * T(x!, y!) + 0.5, 1e-13, 'T expr'));
  const g = evaluateExpr(s2, 'd(T, x)', pts);
  assert.equal(g.unit, 'K/m'); assert.equal(g.continuous, false);
  pts.forEach(([x, y], i) => close(g.values[i]!, 2 + y! + x!, 1e-11, 'dT/dx'));
  const gr = evaluateExpr(s2, '-d(T, r)', pts);
  pts.forEach(([x, y], i) => close(gr.values[i]!, -((2 + y! + x!) * x! + (-1 + x!) * y!) / Math.sqrt(x! * x! + y! * y!), 1e-11, 'dT/dr'));
  const u = evaluateExpr(s2, 'u.x + u.y*d(u.y, y)', pts);
  pts.forEach(([x, y], i) => close(u.values[i]!, x! * y! + (x! - y!) * -1, 1e-12, 'u comps'));
  const nrm = evaluateExpr(s2, 'u.norm', pts);
  pts.forEach(([x, y], i) => close(nrm.values[i]!, Math.sqrt((x! * y!) ** 2 + (x! - y!) ** 2), 1e-12, 'norm'));
  const th = evaluateExpr(s2, 'cos(th)^2 + sin(th)^2 + 0*T/(1[K])', pts, { defs: { th: 'atan2(y, x)' } });
  for (const v of th.values) close(v, 1, 1e-15, 'defs');
  assert.equal(th.unit, '1');
  assert.throws(() => compileFieldExpr(s2, 'u'), /vector field/);
  assert.throws(() => compileFieldExpr(s2, 'nope + 1'), /unknown variable 'nope'/);
  assert.throws(() => compileFieldExpr(s2, 'T + x'), /incompatible units/);
  assert.throws(() => compileFieldExpr(s2, 'T', { params: { T: 1 } }), /both a param and a field/);
  assert.throws(() => compileFieldExpr(s2, 'd(2*T, x)'), /d\(\) takes a field/);
  assert.throws(() => compileFieldExpr(s2, 'd(T, q)'), /not a coordinate/);
  assert.throws(() => compileFieldExpr(s2, 'a', { defs: { a: 'b', b: 'a' } }), /defs cycle/);
  assert.throws(() => evaluateExpr(s2, 'sqrt(T - 100[K])', pts), /complex at some points/);
  // outside: NaN; module scalar as a constant
  const out = evaluateExpr(s2, 'T + Q/(1[W/K])', [[5, 5], [0.5, 0.5]]);
  assert.ok(Number.isNaN(out.values[0]!)); close(out.values[1]!, T(0.5, 0.5) + 3, 1e-13, 'scalar');
  // sample() stays backward compatible
  assert.deepEqual(Array.from(sample(s2, 'T', [0.3, 0.7])), [evaluateExpr(s2, 'T', [0.3, 0.7]).values[0]]);
});

test('cut line 2D: crossings, uniform and crossing modes, exact line integral, partial coverage', () => {
  const p0 = [0.05, 0.1], p1 = [1.9, 0.83];
  const br = lineCrossings(m2, p0, p1);
  assert.ok(br.length > 10 && br[0] === 0 && br[br.length - 1] === 1);
  const L = cutLine(m2, p0, p1, { n: 50 });
  close(L.covered, L.length, 1e-14, 'covered');
  assert.equal(L.points.n, 50);
  // int T ds along the segment: T(p0 + t d) is quadratic in t
  const d = [p1[0]! - p0[0]!, p1[1]! - p0[1]!];
  const Tt = (t: number) => T(p0[0]! + t * d[0]!, p0[1]! + t * d[1]!);
  const exact = L.length * (Tt(0) + 4 * Tt(0.5) + Tt(1)) / 6;   // Simpson: exact for quadratics
  const I = evalIntegral(s2, 'T', L);
  assert.equal(I.unit, 'm*K'); close(I.value, exact, 1e-13, 'line integral');
  close(evalAverage(s2, 'T', L).value, exact / L.length, 1e-13, 'line average');
  const C = cutLine(m2, p0, p1, { mode: 'crossing' });
  assert.equal(C.points.n, 3 * (C.pieces.length / 2));
  for (let i = 0; i < C.points.n; i++) close(evalPoint(s2, 'T', C.points).values[i]!, Tt(C.s[i]! / C.length), 1e-12, 'crossing pts');
  // half outside: covered length is the inside part, integral over it
  const H = cutLine(m2, [1, 0.5], [3, 0.5], { n: 201 });
  close(H.covered, 1, 1e-13, 'covered half');
  const Th = (x: number) => T(x, 0.5);
  close(evalIntegral(s2, 'T', H).value, (Th(1) + 4 * Th(1.5) + Th(2)) / 6, 1e-13, 'half integral');
  close(evalMax(s2, 'T', H).value, Th(2), 1e-12, 'max on line');
  assert.ok(evalMax(s2, 'T', H).nOutside! > 0);
});

test('cut line 3D on tet10 and hex8: exact integrals', () => {
  for (const cell of ['tet10', 'hex8'] as const) {
    const m = boxMesh({ x: [0, 1], y: [0, 1], z: [0, 1], nx: 3, ny: 3, nz: 3, cell });
    const f = (x: number, y: number, z: number) => (cell === 'tet10' ? x * y + z * z : 1 + x + 2 * y - z);
    const s = solOf(m, [nodal(m, 'f', '1', ([x, y, z]) => [f(x!, y!, z!)], cell === 'tet10' ? 'H1P2' : 'H1P1')]);
    const p0 = [0.1, 0.2, 0.05], p1 = [0.9, 0.7, 0.95];
    const L = cutLine(m, p0, p1);
    close(L.covered, L.length, 1e-12, `${cell} covered`);
    const ft = (t: number) => f(p0[0]! + t * 0.8, p0[1]! + t * 0.5, p0[2]! + t * 0.9);
    close(evalIntegral(s, 'f', L).value, L.length * (ft(0) + 4 * ft(0.5) + ft(1)) / 6, 1e-12, `${cell} line integral`);
    close(evalIntegral(s, '1', { kind: 'domain' }).value, 1, 1e-13, `${cell} volume`);
    close(evalMeasure(m, { kind: 'boundary', ids: ['bnd:box.xmax'] }).value, 1, 1e-13, `${cell} face area`);
    if (cell === 'tet10') close(evalIntegral(s, 'f', { kind: 'boundary', ids: ['bnd:box.zmax'] }).value, 0.25 + 1, 1e-12, 'face integral');
  }
});

test('edge dataset: chain order, arc length, normals, integrals; boundary and domain regions', () => {
  const E = edgeDataset(m2, ['bnd:rect.right', 'bnd:rect.bottom']);
  close(E.length, 3, 1e-14, 'length');
  assert.equal(E.chains.length, 1);
  // starts at the open end with the smaller x: (0, 0), along the bottom, then up the right side
  assert.deepEqual(Array.from(E.points.x.subarray(0, 2)), [0, 0]);
  for (let i = 1; i < E.s.length; i++) assert.ok(E.s[i]! > E.s[i - 1]!);
  close(E.s[E.s.length - 1]!, 3, 1e-14, 's end');
  // int T ds: bottom (y = 0) x in [0, 2], right (x = 2) y in [0, 1]
  const bottom = 2 + 4 + 8 / 6, right = (1 + 4 + 2) - 0.5 + 1;   // int (1 + 2x + x^2/2) dx; int (7 + y) dy
  close(evalIntegral(s2, 'T', E).value, bottom + right, 1e-13, 'edge integral');
  close(evalIntegral(s2, 'T', { kind: 'boundary', ids: ['bnd:rect.bottom', 'bnd:rect.right'] }).value, bottom + right, 1e-13, 'boundary integral');
  // outward normals: n . grad T flux on the right edge = int dT/dx (x = 2) dy = int (4 + y) dy
  const R = edgeDataset(m2, ['bnd:rect.right']);
  close(evalIntegral(s2, 'nx*d(T, x) + ny*d(T, y)', R).value, 4.5, 1e-12, 'flux');
  // the reverse chain flips s, tangent
  const Rr = edgeDataset(m2, ['bnd:rect.right'], { reverse: true });
  close(Rr.points.x[1]!, 1, 0, 'reverse start y');
  close(evalIntegral(s2, 'tx', R).value, 0, 1e-14, 'tx'); close(evalIntegral(s2, 'ty', R).value, 1, 1e-14, 'ty up');
  close(evalIntegral(s2, 'ty', Rr).value, -1, 1e-14, 'ty down');
  // domain: area, int T dA vs integrate(); average; max / min nodal and lattice with location
  close(evalMeasure(m2, { kind: 'domain' }).value, 2, 1e-14, 'area');
  const IT = evalIntegral(s2, 'T', { kind: 'domain', ids: ['dom:rect'] });
  close(IT.value, integrate(m2, s2.fields[0]!)[0]!, 1e-13, 'vs integrate'); assert.equal(IT.unit, 'm^2*K');
  const mx = evalMax(s2, 'T', { kind: 'domain' }), mn = evalMin(s2, 'T', { kind: 'domain' }, { method: 'lattice', resolution: 4 });
  close(mx.value, T(2, 1), 1e-13, 'max'); assert.deepEqual(mx.at, [2, 1]); assert.equal(mx.method, 'nodal');
  close(mn.value, T(0, 1), 1e-13, 'min lattice'); assert.equal(mn.method, 'lattice_r4');
  assert.throws(() => edgeDataset(m2, ['bnd:nope']), /matches no boundary/);
});

test('axisymmetric weights: volume, surface of revolution, revolve only on axisym meshes', () => {
  const ma = rectTriMesh({ x: [1, 2], y: [0, 3], nx: 3, ny: 4, order: 2, axisym: true });
  const sa = solOf(ma, [nodal(ma, 'f', '1', ([r]) => [r!])]);
  close(evalMeasure(ma, { kind: 'domain' }).value, Math.PI * (4 - 1) * 3, 1e-13, 'volume');
  assert.equal(evalMeasure(ma, { kind: 'domain' }).unit, 'm^3');
  close(evalMeasure(ma, { kind: 'boundary', ids: ['bnd:rect.right'] }).value, 2 * Math.PI * 2 * 3, 1e-13, 'cylinder side');
  close(evalMeasure(ma, { kind: 'domain' }, { revolve: false }).value, 3, 1e-14, 'meridional area');
  // int r dV = 2 pi int r^2 dr dz = 2 pi (8 - 1)/3 * 3
  close(evalIntegral(sa, 'r', { kind: 'domain' }).value, 2 * Math.PI * 7, 1e-12, 'int r dV');
  const L = cutLine(ma, [1, 1], [2, 1]);
  close(evalMeasure(ma, L).value, Math.PI * (4 - 1), 1e-13, 'annulus by revolved cut line');
  assert.throws(() => evalMeasure(m2, { kind: 'domain' }, { revolve: true }), /axisymmetric/);
});

test('cut points, steps, global evaluation', () => {
  const s = solOf(m2, [0, 1, 2].map((k) => nodal(m2, 'T', 'K', ([x]) => [x! * (k + 1)], 'H1P2', k)), { steps: { kind: 'time', values: Float64Array.from([0, 0.5, 1]), unit: 's' } });
  assert.deepEqual(solutionSteps(s).indices, [0, 1, 2]);
  assert.deepEqual(solutionSteps(s, 'last').values, [1]);
  assert.throws(() => solutionSteps(s, [7]), /not in the solution/);
  const P = cutPoints(m2, [[1, 0.5], [9, 9]]);
  assert.deepEqual(P.outside, [1]);
  const v = evalPoint(s, 'T/t', P, { step: 1 });
  close(v.values[0]!, 2 / 0.5, 1e-13, 'step 1 at t'); assert.equal(v.unit, 'K/s');
  const g = evalGlobal(s2, 'Q*2/(a*1[W])', { params: { a: 4 } });
  close(g.value, 1.5, 1e-15, 'global'); assert.equal(g.unit, '1');
  assert.throws(() => evalGlobal(s2, 'T'), /unknown variable/);
  // locatePoints keeps NaN outside, a constant expression fills the inside
  const ps = locatePoints(m2, [0.5, 0.5, 7, 7]);
  const c = compileFieldExpr(s2, '2[K]').evaluate(ps);
  assert.equal(c[0], 2); assert.ok(Number.isNaN(c[1]!));
});

test('audit fixes: curved-cell crossings, closed-loop orientation, name clashes, dataset inputs, coverage', async () => {
  const { makeMesh } = await import('@amp/physics/common/mesh');
  // top boundary mid nodes raised by 0.02: each top facet is the parabola y = 1 + 0.08 xi (1 - xi)
  const base = rectTriMesh({ x: [0, 2], y: [0, 1], nx: 6, ny: 4, order: 2 });
  const nodes = base.nodes.slice(), NX = 12, NY = 8;
  for (let i = 1; i < NX; i += 2) nodes[2 * (NY * (NX + 1) + i) + 1] = 1.02;
  const { hash: _h, ...rest } = base; void _h;
  const mc = makeMesh({ ...rest, nodes });
  const L = cutLine(mc, [0, 1.019], [2, 1.019]);
  const w = 2 * Math.sqrt(0.25 - 0.019 / 0.08);   // xi interval width above y = 1.019 per facet
  close(L.covered, 6 * (2 / 6) * w, 1e-12, 'covered through the bulges');
  assert.equal(L.pieces.length / 2, 6);
  // closed loop (all four sides): counterclockwise around the domain, outward normal on the right
  const E = edgeDataset(m2, ['bnd:rect.bottom', 'bnd:rect.right', 'bnd:rect.top', 'bnd:rect.left']);
  assert.equal(E.chains.length, 1); assert.deepEqual(E.chainPoints, [[0, E.points.n]]);
  close(evalIntegral(s2, 'x*ty - y*tx', E).value, 4, 1e-13, 'oriented area x 2');
  close(evalIntegral(s2, 'x*nx + y*ny', E).value, 4, 1e-13, 'div x = 2');
  // names: reserved __d, error text quotes the original, DG0 d(), clashes with scalars and coordinates
  assert.throws(() => compileFieldExpr(s2, '__d0 + 1'), /reserved/);
  assert.throws(() => compileFieldExpr(s2, 'd(T, x) + 1[K]'), (e: Error) => e.message.includes('"d(T, x) + 1[K]"') && !e.message.includes('__d'));
  const sd = solOf(m2, [{ name: 'q', unit: '1', space: 'DG0', components: 1, data: new Float64Array(m2.cells.conn.length / 6) }]);
  assert.throws(() => compileFieldExpr(sd, 'd(q, x)'), /DG0/);
  assert.throws(() => compileFieldExpr(s2, 'Q', { params: { Q: 1 } }), /module scalar/);
  assert.throws(() => compileFieldExpr(s2, 'x', { params: { x: 1 } }), /coordinate/);
  assert.throws(() => evalGlobal(s2, 'a', { params: { a: { si: 5, unit: 'mm' } } }), /not SI/);
  // evalPoint takes line and edge datasets; integrals over a partly covered line report the coverage
  assert.equal(evalPoint(s2, 'T', cutLine(m2, [0.1, 0.1], [0.9, 0.9], { n: 5 })).values.length, 5);
  assert.equal(evalPoint(s2, 'T', E).values.length, E.points.n);
  const H = evalIntegral(s2, 'T', cutLine(m2, [1, 0.5], [3, 0.5]));
  close(H.coverage!.covered, 1, 1e-13, 'coverage'); close(H.coverage!.length, 2, 1e-15, 'length');
});
