// SPDX-License-Identifier: GPL-3.0-or-later
// @amp/post: solution store, derived values, field evaluation at points, sampling for plots, CSV export (DevLog-010).
export { Locator, locatorFor, evaluateField, type Located } from './evaluate.ts';
export { SolutionStore, rememberMesh, attachMesh, meshOf, fieldOf } from './store.ts';
export { integrate, extrema } from './derived.ts';
export { sample, linePoints, gridPoints, toCsv, type SampleOptions } from './sample.ts';
export * as refine from './refine.mjs';
