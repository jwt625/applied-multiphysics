// SPDX-License-Identifier: GPL-3.0-or-later
// @amp/geom: 2D sketch + CSG with persistent entity IDs (C2), axisymmetric flag, layered extrude and revolve.

export * from './curves.ts';
export * from './types.ts';
export { arrange, type Arrangement, type ArrSub, type ArrFace } from './arrangement.ts';
export {
  buildGeometry2D, primitive, combine, resolveSelection, domainAreas,
  type Feature, type GeometrySpec2D, type Geometry2D, type GeomEdge, type Obj, type EdgeRec, type DomainRec, type PointRec,
} from './model.ts';
export { extrudeLayered, revolve, boundarySides, type Layer, type Extruded, type Revolved } from './extrude.ts';
export * as polygon from './polygon.mjs';
