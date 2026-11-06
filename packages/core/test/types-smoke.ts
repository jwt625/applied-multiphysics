// SPDX-License-Identifier: GPL-3.0-or-later
// Type-level smoke test (tsc --noEmit only; not run by node --test): typed uses of the main @amp/core APIs so the
// .d.mts declarations are exercised by the compiler.
import { parseUnit, formatUnit, displayConversion, dimMul, type Dim } from '../src/units.mjs';
import { compileExpression, type ExprScope } from '../src/expr.mjs';
import { resolveParams, evaluateExpression } from '../src/params.mjs';
import { parametricStudy, runSweep } from '../src/sweep.mjs';
import { buildElementPattern, SparseCholesky, analyze } from '../src/la/sparse.mjs';
import { SymbolicLDLT, LDLT, ComplexSupernodalLDLT } from '../src/la/ldlt.mjs';
import { makeFactor } from '../src/la/ldlt-select.mjs';
import { blockArnoldi } from '../src/la/arnoldi.mjs';
import { gmres } from '../src/la/krylov.mjs';
import { createStencil, padded } from '../src/la/stencil.mjs';
import { buildMG, mgPrecond } from '../src/la/mg.mjs';
import { pcg } from '../src/la/pcg.mjs';
import { tetMatricesP, simplexMoment } from '../src/fem/hcurl.mjs';
import { TRI_Q4 } from '../src/fem/quadrature.mjs';
import { PoissonSolver } from '../src/fem/tri.mjs';
import * as core from '../src/index.mjs';

const d: Dim = dimMul(parseUnit('W/(m*K)').dim, parseUnit('K').dim);
const s1: string = formatUnit(d);
const f: number = displayConversion(parseUnit('V/m').dim, 'V/um').factor;
const scope: ExprScope = { resolve: (n) => (n === 'a' ? { kind: 'const', re: 2, dim: parseUnit('m').dim } : null) };
const c = compileExpression('a^2', scope);
const unit: string = c.unit;
const v: number = evaluateExpression('2*a', { a: 3 }) + resolveParams({ a: { value: 1, unit: 'mm' } }).values.a!;
const st = parametricStudy([{ param: 'a', values: [1, 2] }], { params: ['a'] });
void runSweep(st, (vals) => vals.a! * 2).then((r) => r.points[0]?.result);
const pat = buildElementPattern(3, Int32Array.from([0, 1, 1, 2]), 2);
const ch = new SparseCholesky(pat);
const ok: boolean = ch.factor(new Float64Array(pat.nnz));
const sym = new SymbolicLDLT(pat, analyze(pat).perm);
const ldl = new LDLT(sym);
const cf = makeFactor('blocked', sym);
const ar = blockArnoldi(3, (X) => X, { nWant: 1, blockSize: 1, maxBasis: 3, tol: 1e-8, X0: null, maxRestarts: 1, seed: 1, realOnly: true });
const mu: number = ar.mu[0]?.re ?? 0;
const g = gmres((xr: Float64Array, xi: Float64Array, yr: Float64Array, yi: Float64Array) => { yr.set(xr); yi.set(xi); }, null, new Float64Array(2), new Float64Array(2));
const op = createStencil(3, 3, 3);
const mg = buildMG(op, Float64Array.from([0, 1, 2]), Float64Array.from([0, 1, 2]));
const r = pcg(op, (a: Float64Array, b: Float64Array) => mgPrecond(mg, a, b), padded(op), padded(op));
const m: number = simplexMoment([1, 1, 0], 2) + (TRI_Q4[0]?.[3] ?? 0);
void [s1, f, unit, v, ok, ldl, cf, mu, g, r, m, tetMatricesP, PoissonSolver, ComplexSupernodalLDLT, core.units.DIMLESS];
