// SPDX-License-Identifier: GPL-3.0-or-later
// Spec registrations and result names of wave2d (lane S1, DevLog-042): physics `emw-2d`, the frequency-domain conditions
// shared with `acoustics` (pml, plane-wave, port, scattering, impedance, normal-velocity) and pec / pmc for emw-2d;
// periodic (Bloch / Floquet) condition and the `bands` study (DevLog-050).

import * as z from 'zod';
import { quantity, type Registration } from '@amp/spec';

const own = { owner: '@amp/physics (wave2d)' } as const;
const BOTH = ['emw-2d', 'acoustics'] as const;

export const WAVE2D_REGISTRATIONS: Registration[] = [
  { kind: 'physics', type: 'emw-2d', ...own, dims: ['2d'], description: 'Electromagnetic waves in the plane, frequency domain: TM = out-of-plane E_z, TE = out-of-plane H_z; PML, plane-wave (scattered field), ports (S-parameters), absorbing, PEC / PMC, impedance',
    settings: z.strictObject({ polarization: z.enum(['TM', 'TE']).meta({ description: 'TM: E_z out of plane (E normal to the plane); TE: H_z out of plane' }), order: z.union([z.literal(1), z.literal(2)]).optional() }) },
  { kind: 'bc', type: 'pml', ...own, for: BOTH, select: ['dom'], description: 'Perfectly matched layer by complex coordinate stretching; Cartesian slabs and corners outside the box of the non-PML region; s = 1 - j f_max (d/L)^order with continuum reflection R0',
    settings: z.strictObject({ R0: quantity('1', { gt: 0, lt: 1 }).optional(), order: z.number().int().min(0).max(4).optional() }) },
  { kind: 'bc', type: 'plane-wave', ...own, for: BOTH, select: ['dom'], description: 'Background plane wave, scattered-field formulation; select = the background domains (one homogeneous medium; PML domains hold it too). direction = propagation angle from +x; amplitude in V/m (TM), A/m (TE) or Pa',
    settings: z.strictObject({ direction: quantity('1'), amplitude: quantity('*') }) },
  { kind: 'bc', type: 'port', ...own, for: BOTH, select: ['bnd'], description: 'Modal port on a straight exterior boundary: modes of the port cross-section (1D eigenproblem), exact discrete DtN; S-parameters of the first nModes modes; excite = the port whose fundamental mode drives the field output',
    settings: z.strictObject({ excite: z.boolean().optional(), nModes: z.number().int().min(1).max(32).optional(), power: quantity('W/m', { gt: 0 }).optional() }) },
  { kind: 'bc', type: 'scattering', ...own, for: BOTH, select: ['bnd'], description: 'First-order absorbing (Sommerfeld) boundary: dn u = -j k u' },
  { kind: 'bc', type: 'pec', ...own, for: ['emw-2d'], select: ['bnd'], description: 'Perfect electric conductor (TM: E_z = 0; TE: dn H_z = 0)' },
  { kind: 'bc', type: 'pmc', ...own, for: ['emw-2d'], select: ['bnd'], description: 'Perfect magnetic conductor (TM: dn E_z = 0; TE: H_z = 0)' },
  { kind: 'bc', type: 'impedance', ...own, for: ['emw-2d'], select: ['bnd'], description: 'Leontovich surface impedance Zs = R + j X, or a good conductor of conductivity sigma (Zs = (1 + j) sqrt(omega mu0 / (2 sigma)))',
    settings: z.strictObject({ R: quantity('ohm').optional(), X: quantity('ohm').optional(), sigma: quantity('S/m', { gt: 0 }).optional() }),
    check: (n) => {
      const s = (n.settings ?? {}) as { R?: unknown; X?: unknown; sigma?: unknown };
      const zs = s.R !== undefined || s.X !== undefined;
      return zs === (s.sigma !== undefined) ? [{ path: ['settings'], message: 'impedance: give R (and optionally X), or sigma' }] : [];
    } },
  { kind: 'bc', type: 'impedance', ...own, for: ['acoustics'], select: ['bnd'], description: 'Specific acoustic impedance Z = p / v_n (v_n outward); Z = rho c absorbs normal incidence',
    settings: z.strictObject({ Z: quantity('Pa*s/m', { gt: 0 }) }) },
  { kind: 'bc', type: 'normal-velocity', ...own, for: ['acoustics'], select: ['bnd'], description: 'Normal velocity into the domain (frequency domain)',
    settings: z.strictObject({ v: quantity('m/s') }) },
  // periodic cells (DevLog-050)
  { kind: 'bc', type: 'periodic', ...own, for: ['emw-2d'], select: ['bnd'], description: 'Bloch (Floquet) periodicity between two opposite, straight, parallel cell sides (select both): u(x + a) = u(x) exp(-j k.a), a = the translation between the sides. The mesh puts the same nodes on both sides. k comes from the band path (bands study), from the plane wave (frequency study), or from the setting k',
    settings: z.strictObject({ k: quantity('1').optional().meta({ description: 'Bloch wave-vector component along this pair, k.a / (2 pi) (0 = periodic, 0.5 = antiperiodic); used by eigen studies and by frequency studies without a plane wave' }) }) },
  { kind: 'study', type: 'bands', ...own, description: 'Band structure: eigenfrequencies of a periodic cell along a path of Bloch wave vectors (lossless media; periodic, pec, pmc conditions)',
    settings: z.strictObject({
      kPath: z.array(z.strictObject({ label: z.string().min(1).max(16), k: z.array(z.number()).min(1).max(2) })).min(1).meta({ description: 'Path points, k in units of the reciprocal lattice vectors of the periodic conditions in their listed order (b1, b2 with a_i . b_j = 2 pi delta_ij); e.g. Gamma [0, 0], X [0.5, 0], M [0.5, 0.5]' }),
      interpolate: z.number().int().min(0).max(64).optional().meta({ description: 'Points inserted between consecutive path points (default 4)' }),
      nBands: z.number().int().min(1).max(32).optional().meta({ description: 'Bands per k point (default 8)' }),
    }) },
];

// S-parameters between higher port modes p, q (mode 0 is the bare S<i><j> form); a frequency study with several
// frequencies suffixes every scalar with the step index, '<name>_<s>' (DevLog-047 R3, DevLog-061)
const S_HIGHER = ['S<i><j>_<p><q>_re', 'S<i><j>_<p><q>_im', 'S<i><j>_<p><q>_abs', 'S<i><j>_<p><q>_dB', 'S<i><j>_<p><q>_phase'];
const stepped = (names: string[]) => names.map((n) => `${n}_<s>`);
const FREQ_EMW = ['S<i><j>_re', 'S<i><j>_im', 'S<i><j>_abs', 'S<i><j>_dB', 'S<i><j>_phase', 'beta_<i>_<k>', 'neff_<i>_<k>', 'P_in', 'P_src_<i>', 'sigma2d_back', 'sigma2d_fwd', 'sigma2d_total', 'freq'];
const FREQ_AC = ['S<i><j>_re', 'S<i><j>_im', 'S<i><j>_abs', 'S<i><j>_dB', 'S<i><j>_phase', 'beta_<i>_<k>', 'P_in', 'P_src_<i>', 'sigma2d_back', 'sigma2d_fwd', 'sigma2d_total', 'freq'];

export const RESULT_NAMES_WAVE2D: Record<string, { fields: string[]; scalars: string[] }> = {
  'emw-2d': {
    fields: ['Ez_re', 'Ez_im', 'Ez_abs', 'Ez_sc_re', 'Ez_sc_im', 'Ez_sc_abs', 'H_re', 'H_im', 'normH', 'Hz_re', 'Hz_im', 'Hz_abs', 'Hz_sc_re', 'Hz_sc_im', 'Hz_sc_abs', 'E_re', 'E_im', 'normE'],
    scalars: [...FREQ_EMW,
      'f_<b>', 'f_<b>_<k>', 'fmax_<b>', 'fmin_<b>', 'kx_<k>', 'ky_<k>', ...S_HIGHER, ...stepped([...FREQ_EMW, ...S_HIGHER])],
  },
  'acoustics-frequency': {
    fields: ['p_re', 'p_im', 'p_abs', 'p_sc_re', 'p_sc_im', 'p_sc_abs', 'v_re', 'v_im', 'normV'],
    scalars: [...FREQ_AC, ...S_HIGHER, ...stepped([...FREQ_AC, ...S_HIGHER])],
  },
};

