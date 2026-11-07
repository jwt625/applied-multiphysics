// SPDX-License-Identifier: GPL-3.0-or-later
// All coupling implementations and their spec registrations (C11): core (lane MC), photonic (MO), two-way (MT),
// optomechanical (MOM, DevLog-034).
import type { Registration } from '@amp/spec';
import { CORE_COUPLINGS, CORE_REGISTRATIONS, CORE_NEEDS, type CouplingImpl } from './core.ts';
import { PHOTONIC_COUPLINGS, PHOTONIC_REGISTRATIONS, PHOTONIC_NEEDS } from './photonic.ts';
import { TWOWAY_COUPLINGS, TWOWAY_REGISTRATIONS } from './twoway.ts';
import { OPTOMECH_COUPLINGS, OPTOMECH_REGISTRATIONS, OPTOMECH_NEEDS } from './optomech.ts';

export type { CouplingImpl } from './core.ts';
/** Material properties each coupling type needs on its `to` / `from` physics (core + photonic + optomechanical; readiness, prepareRun). */
export const COUPLING_NEEDS: Record<string, { to?: string[]; from?: string[] }> = { ...CORE_NEEDS, ...PHOTONIC_NEEDS, ...OPTOMECH_NEEDS };

export const COUPLINGS: CouplingImpl[] = [...CORE_COUPLINGS, ...PHOTONIC_COUPLINGS, ...TWOWAY_COUPLINGS, ...OPTOMECH_COUPLINGS];
export const COUPLING_REGISTRATIONS: Registration[] = [...CORE_REGISTRATIONS, ...PHOTONIC_REGISTRATIONS, ...TWOWAY_REGISTRATIONS, ...OPTOMECH_REGISTRATIONS];

/** Implementation of a coupling type, or undefined. */
export const couplingImpl = (type: string, list: readonly CouplingImpl[] = COUPLINGS): CouplingImpl | undefined => list.find((c) => c.type === type);
