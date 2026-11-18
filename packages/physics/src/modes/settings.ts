// SPDX-License-Identifier: GPL-3.0-or-later
// em-modes physics settings schema and result names (lane S2, DevLog-043 s.2.2). Every key except `order` and
// `crystals` (DevLog-032) is new and optional; absent keys give the earlier behaviour.

import * as z from 'zod';
import { quantity } from '@amp/spec';
import { crystalsSchema } from '../couplings/photonic.ts';

const dnq = quantity('1/m');

export const EM_MODES_SETTINGS = z.strictObject({
  order: z.union([z.literal(1), z.literal(2)]).optional(),
  crystals: crystalsSchema.optional(),
  /** complex permittivity eps = (n - j kappa)^2 from material kappa */
  loss: z.boolean().optional(),
  /** n_g with material dispersion; dndlambda per material id (1/m), else the resolved material dn_dlambda */
  dispersion: z.union([z.boolean(), z.strictObject({
    dndlambda: z.record(z.string(), z.union([dnq, z.strictObject({ perp: dnq, par: dnq })])).optional(),
    /** dkappa/dlambda per lossy material id (1/m), else the resolved material dkappa_dlambda; absent = kappa constant */
    dkappadlambda: z.record(z.string(), dnq).optional(),
    /** library dn/dlambda options per material id (prepareRun, DevLog-046): named n alternative, extrapolation */
    library: z.record(z.string(), z.strictObject({ alternative: z.string().optional(), extrapolate: z.boolean().optional() })).optional(),
  })]).optional(),
  /** complex coordinate stretching s = 1 - j strength xi^power on outer domains */
  pml: z.array(z.strictObject({
    select: z.array(z.string()).min(1),
    strength: z.number().positive().optional(),
    power: z.number().min(0).optional(),
    x: z.tuple([quantity('m'), quantity('m')]).optional(),
    y: z.tuple([quantity('m'), quantity('m')]).optional(),
  })).optional(),
  /** bend in the x-z plane about an axis parallel to y; centre of curvature at x = x0 - radius */
  bend: z.strictObject({ radius: quantity('m'), x0: quantity('m').optional(), model: z.enum(['metric', 'conformal']).optional() }).optional(),
});

/** Result scalars added by DevLog-043 (complex solves; bend). */
export const RESULT_NAMES_MODES2 = ['kappaEff_<k>', 'Lprop_<k>', 'bendLossDbPer90_<k>', 'pmlFraction_<k>'] as const;
