// SPDX-License-Identifier: GPL-3.0-or-later
// Declarations of la/ldlt-blocked.mjs (hand-written 2026-11-06, audit S2).
import { ComplexSupernodalLDLT } from './ldlt.mjs';
/** ComplexSupernodalLDLT with a 4-column blocked front update (same results to round-off). */
export class BlockedComplexLDLT extends ComplexSupernodalLDLT {}
