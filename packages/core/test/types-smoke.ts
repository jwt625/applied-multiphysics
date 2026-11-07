// SPDX-License-Identifier: GPL-3.0-or-later
// Type-level tests (tsc --noEmit only; not run by node --test): typed uses of the public @amp/core APIs, and
// wrong-call probes (audit S2) that must fail to compile (`@ts-expect-error` makes tsc fail if a probe compiles).
import { parseUnit, formatUnit, displayConversion, dimMul, type Dim } from '../src/units.mjs';
import { compileExpression, type ExprScope } from '../src/expr.mjs';
import { resolveParams, evaluateExpression } from '../src/params.mjs';
import { parametricStudy, runSweep } from '../src/sweep.mjs';
import { buildElementPattern, buildPattern, SparseCholesky, analyze, matVec } from '../src/la/sparse.mjs';
import { SymbolicLDLT, LDLT, SupernodalLDLT, ComplexSupernodalLDLT } from '../src/la/ldlt.mjs';
import { makeFactor } from '../src/la/ldlt-select.mjs';
import { blockArnoldi } from '../src/la/arnoldi.mjs';
import { gmres } from '../src/la/krylov.mjs';
import { gmres as gmresReal } from '../src/la/gmres-real.mjs';
import { createStencil, padded, StencilCholesky } from '../src/la/stencil.mjs';
import { buildMG, mgPrecond } from '../src/la/mg.mjs';
import { pcg } from '../src/la/pcg.mjs';
import { tetMatricesP, simplexMoment, triTables } from '../src/fem/hcurl.mjs';
import { tetGeometry } from '../src/fem/nedelec1.mjs';
import { buildSpace, type HcurlTetMesh } from '../src/fem/space.mjs';
import { p1Space, makeSpace, assembleByTag, triangleGeometry as triGeo, UM } from '../src/fem/tri-fe.mjs';
import { PoissonSolver, p2Space, restrictMatrix, type TriMesh } from '../src/fem/tri.mjs';
import { TRI_Q4, TRI_QUAD, GAUSS01 } from '../src/fem/quadrature.mjs';
import * as core from '../src/index.mjs';

// ---- typed uses ----
const d: Dim = dimMul(parseUnit('W/(m*K)').dim, parseUnit('K').dim);
const s1: string = formatUnit(d);
const f: number = displayConversion(parseUnit('V/m').dim, 'V/um').factor;
const scope: ExprScope = { resolve: (n) => (n === 'a' ? { kind: 'const', re: 2, dim: parseUnit('m').dim } : null) };
const unit: string = compileExpression('a^2', scope).unit;
const v: number = evaluateExpression('2*a', { a: 3 }) + resolveParams({ a: { value: 1, unit: 'mm' } }).values.a!;
const st = parametricStudy([{ param: 'a', values: [1, 2] }], { params: ['a'] });
void runSweep(st, (vals) => vals.a! * 2).then((r) => r.points[0]?.result);
const pat = buildElementPattern(3, Int32Array.from([0, 1, 1, 2]), 2);
const ch = new SparseCholesky(pat);
const ok: boolean = ch.factor(new Float64Array(pat.nnz));
const xs: Float64Array[] = ch.solveMany([new Float64Array(3)]);
const y: Float64Array = matVec(pat, new Float64Array(pat.nnz), new Float64Array(3));
const ldl = new LDLT(new SymbolicLDLT(pat, analyze(pat).perm));
const nNeg: number | undefined = ldl.factor(new Float64Array(pat.nnz)).nNeg;
const sym = analyze(pat);
const sn = new SupernodalLDLT(sym);
const cf: ComplexSupernodalLDLT = makeFactor('blocked', sym);
const cs = cf.solve(new Float64Array(3), new Float64Array(3)).im;
const ar = blockArnoldi(3, (X) => X.map((x) => sn.solve(x)), { nWant: 1, blockSize: 1, maxBasis: 3, tol: 1e-8, X0: null, maxRestarts: 1, seed: 1, realOnly: true });
const mu: number = ar.mu[0]?.re ?? 0;
const g = gmres((xr, xi, yr, yi) => { yr.set(xr); yi.set(xi); }, null, new Float64Array(2), new Float64Array(2));
const gr = gmresReal((a, out) => out.set(a), (a, out) => out.set(a), new Float64Array(2)).x;
const op = createStencil(3, 3, 3);
const mg = buildMG(op, Float64Array.from([0, 1, 2]), Float64Array.from([0, 1, 2]), { coarseMax: 10 });
const levels: number = mg.stats.levels;
const r = pcg(op, (a, b) => { mgPrecond(mg, a, b); }, padded(op), padded(op), { rtol: 1e-10, ref: 'b' });
const solved: Float64Array = new StencilCholesky(op).solvePadded(padded(op), padded(op));
const m: number = simplexMoment([1, 1, 0], 2) + (TRI_Q4[0]?.[3] ?? 0) + (TRI_QUAD[0]?.[1] ?? 0) + (GAUSS01[2].w[0] ?? 0);
const tt: number = triTables(2).mixed.nA;
const nodes = new Float64Array(12), gg = new Float64Array(12);
const V: number = tetGeometry(nodes, [0, 1, 2, 3], gg);
const mat = { re: [1, 1, 1], im: [0, 0, 0] };
const n20 = new Float64Array(400);
tetMatricesP(2, gg, V, mat, mat, n20, n20, n20, n20);
declare const tetMesh: HcurlTetMesh;
const nDof: number = buildSpace(tetMesh, 2).nDof;
declare const triMesh: TriMesh;
const sp = p1Space(triMesh);
const M = assembleByTag(sp, triGeo(triMesh), new Int32Array(triMesh.nTris), 1, { stiffness: false, mass: true, lengthScale: UM }).M;
const sp2 = makeSpace(triMesh, 2);
const ps = new PoissonSolver(triMesh, new Float64Array(3 * triMesh.nTris), new Uint8Array(triMesh.nNodes), null, null, { space: p2Space(triMesh) });
const e: number = ps.energyForm(ps.solve(new Float64Array(ps.pat.n)).phi);
const sub = restrictMatrix(buildPattern(3, Int32Array.from([0, 1, 2])), new Float64Array(9), [1, 1, 0]).nf;
void [s1, f, unit, v, ok, xs, y, nNeg, cs, mu, g, gr, levels, r, solved, m, tt, nDof, M, sp2, e, sub, core.units.DIMLESS];

// ---- wrong-call probes (audit 2026-11-06 S2): each must be a compile error ----
// @ts-expect-error a string is not a CSR pattern
new SparseCholesky('not a pattern');
// @ts-expect-error gmres takes an operator, a preconditioner and two Float64Arrays
gmres(1, 2, 3, 4);
// @ts-expect-error buildSpace needs an H(curl) tet mesh and order 1 | 2
buildSpace({ nonsense: true }, 7);
// @ts-expect-error nDof is a number
const z: string = buildSpace(tetMesh).nDof;
// @ts-expect-error parseUnit takes a string
parseUnit(3);
// @ts-expect-error makeFactor needs sparse.analyze output, not a SymbolicLDLT
makeFactor('blocked', new SymbolicLDLT(pat, sym.perm));
// @ts-expect-error pcg needs a stencil operator
pcg({}, () => {}, padded(op), padded(op));
// @ts-expect-error buildMG needs coordinate arrays
buildMG(op, [0, 1, 2], [0, 1, 2]);
// @ts-expect-error the arnoldi operator maps Float64Array[] to Float64Array[]
blockArnoldi(3, (x: number) => x, { nWant: 1, blockSize: 1, maxBasis: 3, tol: 1e-8, X0: null, maxRestarts: 1, seed: 1, realOnly: true });
// @ts-expect-error SupernodalLDLT.factor takes values, not a pattern
sn.factor(pat);
// @ts-expect-error order 3 does not exist
tetMatricesP(3, gg, V, mat, mat, n20, n20, n20, n20);
// @ts-expect-error unknown expression scope kind
compileExpression('a', { resolve: () => ({ kind: 'nope' }) });
// @ts-expect-error assembleByTag lengthScale is a number
assembleByTag(sp, triGeo(triMesh), new Int32Array(1), 1, { lengthScale: 'um' });
void z;
