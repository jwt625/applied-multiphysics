// SPDX-License-Identifier: GPL-3.0-or-later
// Redirect shim (test only): APA em2d/fe.mjs semantics on top of @amp/core fem/tri-fe.mjs. APA meshes carry
// micrometre coordinates and call elementMass / elementLoad / assembleByTag without a length scale; core defaults to
// SI metres (audit S1), so this shim passes lengthScale = UM unless the caller gives one.
import * as fe from '../../src/fem/tri-fe.mjs';

export const { UM2, UM, triangleGeometry, p1Space, p2Space, makeSpace, p2Grad, elementStiffness, restrictPattern, cmatvec } = fe;
export const elementMass = (space, geo, t, Me, lengthScale = fe.UM) => fe.elementMass(space, geo, t, Me, lengthScale);
export const elementLoad = (space, geo, t, f, lengthScale = fe.UM) => fe.elementLoad(space, geo, t, f, lengthScale);
export const assembleByTag = (space, geo, triTag, nTags, opts = {}) => fe.assembleByTag(space, geo, triTag, nTags, { lengthScale: fe.UM, ...opts });
