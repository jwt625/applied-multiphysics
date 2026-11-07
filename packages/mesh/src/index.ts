// SPDX-License-Identifier: GPL-3.0-or-later
// @amp/mesh: 2D CDT quality mesher (EO port), structured hex grid and layered prism/tet meshers (APA ports), revolve
// sweep, quality metrics, P2 nodes, C2 mesh hash.

export { mesh2d, makeClassifier, DEFAULT_MAX_VERTICES, type MeshOptions2D, type Refine2D } from './mesh2d.ts';
export { meshDomain, createSizeField } from './cdt2d.mjs';
export { triQuality, tetQuality, solidQuality, type QualitySummary } from './quality.ts';
export { meshHash, tagHash, Sha256 } from './sha256.ts';
export type { Mesh, CellType, EntityTable, EntityRef } from '@amp/geom';
export { meshBoxes, type Box3, type BoxGridOptions } from './boxgrid.ts';
export { meshExtruded, meshRevolved, meshCylinder, cylinderSideProjector, type LayerMesh, type ExtrudeOptions, type RevolveOptions, type CylinderSpec } from './solid3d.ts';
export { toHcurlMesh, LOCAL_EDGES, type HcurlTetMesh } from './hcurl.ts';
export { subdivideInterval, splitPrism, splitQuad } from './layered.mjs';
export { refineUniform, toP2, cylinderProjector, curvedQuality, boundaryMeasure, simplexRule, type RefineOptions, type Projector } from './refine.ts';
