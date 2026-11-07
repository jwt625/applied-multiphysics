// SPDX-License-Identifier: GPL-3.0-or-later
// @amp/post: solution store, derived values, field evaluation at points, sampling for plots, CSV export (DevLog-010);
// results kernels (DevLog-026): field expressions, datasets (steps, cut points, cut lines, 2D edges), evaluations.
export { Locator, locatorFor, evaluateField, type Located } from './evaluate.ts';
export { SolutionStore, rememberMesh, attachMesh, meshOf, fieldOf } from './store.ts';
export { integrate, extrema } from './derived.ts';
export { sample, linePoints, gridPoints, toCsv, type SampleOptions } from './sample.ts';
export * as refine from './refine.mjs';
export { locatePoints, interpolate, mapToPhysical, flatPoints, NODE_REF, type PointSet } from './points.ts';
export { compileFieldExpr, evaluateExpr, isPointSet, paramLookup, type ExprOptions, type FieldExpr, type ParamScope, type ParamValue } from './expr.ts';
export {
  solutionSteps, cutPoints, cutLine, lineCrossings, edgeDataset, domainQuad, boundaryQuad, facetCell, facetsOfBoundaries, cellsOfDomains,
  type StepSelect, type SolutionSteps, type CutPointsDataset, type LineDataset, type EdgeDataset, type QuadSet,
} from './datasets.ts';
export { evalPoint, evalGlobal, evalIntegral, evalAverage, evalMax, evalMin, evalMeasure, type Region, type EvalOptions, type EvalResult, type ExtremeMethod } from './evaluations.ts';
