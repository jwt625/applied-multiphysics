// SPDX-License-Identifier: GPL-3.0-or-later
// TFLN MZM cross-sections for the electro-optic gates (DevLog-032 G-EO2 / G-EO3), shared by test/photonic-tfln.test.ts.
// Geometry: eo-modulator-atlas sims/<id>/config.yaml (designed parameters from the papers; read only, values cited
// in the comments). Materials: @amp/materials library (sourced YAML); air n = 1 and eps_r = 1 are assumptions (the
// library has no air permittivity and its air index fit ends at 1.69 um).
// The study runs through runStudy: electrostatics (anisotropic eps_r, LN crystal orientation from the electro-optic
// coupling's settings.crystals; DevLog-036 R3) -> electro-optic -> em-modes. Electrode terminals select all four hole
// edges by name, the bottom edge through the shared-edge name (DevLog-036 G1). Until 2026-11-07 09:1x the field was
// solved here by a test-side anisotropic P1 Poisson solver (VpiL CP-43 4.241246, CP-44 4.015275 V cm, DevLog-032).

import type { Mesh, Solution } from '@amp/spec/types';
import { prepareRun } from '../src/prepare.ts';
import { runStudy } from '../src/index.ts';
import { nCells } from '../src/common/mesh.ts';
import { defaultLibrary } from '@amp/materials/node';

const LIB = defaultLibrary();
const prop = (id: string, p: string, o: Record<string, number> = {}) => LIB.getProperty(id, p, o).value;
const um = (v: number) => `${v} um`;
const rect = (id: string, x: [number, number], y: [number, number]) => ({ id, type: 'rect', settings: { size: [um(x[1] - x[0]), um(y[1] - y[0])], center: [um((x[0] + x[1]) / 2), um((y[0] + y[1]) / 2)] } });
const poly = (id: string, pts: Array<[number, number]>) => ({ id, type: 'polygon', settings: { points: pts.map(([x, y]) => [um(x), um(y)]) } });

export interface TflnCase {
  id: string; lambda: number; mirrorX: number;
  domain: { x: [number, number]; y: [number, number] };
  /** y of the BOX top / LN bottom is 0; layers bottom-up */
  box: number; film: number; slab: number;
  ribs: Array<Array<[number, number]>>;     // [arm A, arm B] polygons (um)
  electrodes: { sig: [[number, number], [number, number]]; gR: [[number, number], [number, number]]; gL: [[number, number], [number, number]] };
  /** SiO2 cladding / buffer above the slab top up to this y (um), or null for air */
  clad: number | null;
  win: { x: [number, number]; y: [number, number] };
  h: { hmax: number; rib: number; win: number; edge: number };
}

/** Pan et al. 2021 (CP-43), atlas sims/pan2021/config.yaml: g 6.5, ws 17, wg 60, t 0.5 um, rib top 1.1 um, h 0.3 of 0.6 um film, BOX 2 um, sidewall 30 deg from vertical (atlas inference). */
export const PAN2021: TflnCase = {
  id: 'pan2021-a', lambda: 1.957e-6, mirrorX: -11.75,
  domain: { x: [-150, 120], y: [-250, 120] }, box: 2, film: 0.6, slab: 0.3,
  ribs: [[[-0.7232, 0.3], [0.7232, 0.3], [0.55, 0.6], [-0.55, 0.6]], [[-24.2232, 0.3], [-22.7768, 0.3], [-22.95, 0.6], [-24.05, 0.6]]],
  electrodes: { sig: [[-20.25, -3.25], [0.3, 0.8]], gR: [[3.25, 63.25], [0.3, 0.8]], gL: [[-86.75, -26.75], [0.3, 0.8]] },
  clad: null,
  win: { x: [-3.1, 3.1], y: [-1.5, 1.5] },
  h: { hmax: 10, rib: 0.04, win: 0.1, edge: 0.04 },
};

/**
 * Arab Juneghani et al. 2022 device 2 (CP-44), atlas sims/arabjuneghani2022/config.yaml (template tfln_rib_gsg): x-cut
 * film 0.5 um, etch 0.2 um, rib 0.8 um (vertical walls, atlas), BOX 2 um (atlas placeholder), SiO2 cladding Tc 0.8 um
 * above the slab top, buffer Tb 0.2 um, gap G 10 um, offset D 2.6 um, signal Wc 22 um, ground Wg 40 um, Tg 1.0 um;
 * 1550 nm TE (atlas assumption); optical window +-2.0 um x [-1.5, 1.5] um (atlas template rule).
 */
export const ARAB2022: TflnCase = {
  id: 'arabjuneghani2022-b', lambda: 1.55e-6, mirrorX: -13.4,
  domain: { x: [-160, 130], y: [-250, 60] }, box: 2, film: 0.5, slab: 0.3,
  ribs: [[[-0.4, 0.3], [0.4, 0.3], [0.4, 0.5], [-0.4, 0.5]], [[-27.2, 0.3], [-26.4, 0.3], [-26.4, 0.5], [-27.2, 0.5]]],
  electrodes: { sig: [[-24.4, -2.4], [0.5, 1.5]], gR: [[7.6, 47.6], [0.5, 1.5]], gL: [[-74.4, -34.4], [0.5, 1.5]] },
  clad: 1.1,
  win: { x: [-2.0, 2.0], y: [-1.5, 1.5] },
  h: { hmax: 10, rib: 0.04, win: 0.1, edge: 0.04 },
};

export function tflnSpec(c: TflnCase, h = c.h, armB: 'mirror' | 'ideal' | 'none' = 'mirror'): Record<string, unknown> {
  const [ra, rb] = c.ribs as [Array<[number, number]>, Array<[number, number]>];
  const winB: [number, number] = [2 * c.mirrorX - c.win.x[1], 2 * c.mirrorX - c.win.x[0]];
  const E = c.electrodes;
  const base = [
    rect('sub', c.domain.x, [c.domain.y[0], -c.box]),
    rect('box', c.domain.x, [-c.box, 0]),
    rect('slab', c.domain.x, [0, c.slab]),
    poly('ribA', ra), poly('ribB', rb),
  ];
  const win = [rect('owin', c.win.x, c.win.y), rect('owinB', winB, c.win.y)];
  // no cladding: air above the slab, electrodes are holes; cladding: SiO2 from the slab top to c.clad, air above,
  // electrodes split at the cladding top into a lower and an upper hole
  const feats = c.clad === null ? [
    ...base,
    rect('sig', ...E.sig), rect('gR', ...E.gR), rect('gL', ...E.gL),
    rect('top', c.domain.x, [c.slab, c.domain.y[1]]),
    { id: 'air0', type: 'difference', settings: { base: 'top', tools: ['sig', 'gR', 'gL'] } },
    { id: 'air', type: 'difference', settings: { base: 'air0', tools: ['ribA', 'ribB'], keepTools: true } },
    ...win,
    { id: 'frag', type: 'fragment', settings: { inputs: ['box', 'slab', 'ribA', 'ribB', 'air', 'owin', 'owinB'] } },
  ] : [
    ...base,
    ...(['sig', 'gR', 'gL'] as const).flatMap((k) => [rect(`${k}Lo`, E[k][0], [E[k][1][0], c.clad!]), rect(`${k}Hi`, E[k][0], [c.clad!, E[k][1][1]])]),
    rect('cladR', c.domain.x, [c.slab, c.clad]),
    { id: 'clad0', type: 'difference', settings: { base: 'cladR', tools: ['sigLo', 'gRLo', 'gLLo'] } },
    { id: 'clad', type: 'difference', settings: { base: 'clad0', tools: ['ribA', 'ribB'], keepTools: true } },
    rect('airR', c.domain.x, [c.clad, c.domain.y[1]]),
    { id: 'air', type: 'difference', settings: { base: 'airR', tools: ['sigHi', 'gRHi', 'gLHi'] } },
    ...win,
    { id: 'frag', type: 'fragment', settings: { inputs: ['box', 'slab', 'ribA', 'ribB', 'clad', 'air', 'owin', 'owinB'] } },
  ];
  const optical = ['dom:box&owin', 'dom:slab&owin', 'dom:ribA&owin', ...(c.clad === null ? ['dom:air&owin'] : ['dom:clad&owin', ...(c.win.y[1] > c.clad ? ['dom:air&owin'] : [])])];
  // electrode outlines: every hole edge by name; a bottom edge on the slab is a bnd:slab.top#k piece that also carries
  // bnd:<electrode>.bottom (G1); with cladding the electrode is a lower hole (clad) under an upper hole (air)
  const edges = (e: string) => (c.clad === null ? ['right', 'top', 'left', 'bottom'].map((s) => `bnd:${e}.${s}`)
    : [...['right', 'left', 'bottom'].map((s) => `bnd:${e}Lo.${s}`), ...['right', 'top', 'left'].map((s) => `bnd:${e}Hi.${s}`)]);
  return {
    schema: 'amp-spec/0', id: `tfln-${c.id}`, title: `TFLN MZM ${c.id}`,
    params: {},
    geometry: { dim: 2, features: feats },
    materials: [
      { id: 'LN', ref: 'materials/linbo3-congruent', select: ['dom:slab', 'dom:ribA', 'dom:ribB'] },
      { id: 'SiO2', ref: 'materials/sio2-thermal-oxide', select: c.clad === null ? ['dom:box'] : ['dom:box', 'dom:clad'] },
      { id: 'Si', ref: 'materials/silicon', select: ['dom:sub'] },
      { id: 'Air', override: { n: 1, eps_r: 1 }, select: ['dom:air'] },
    ],
    physics: [
      { id: 'es', type: 'electrostatics', select: ['dom:sub', 'dom:box', 'dom:slab', 'dom:ribA', 'dom:ribB', 'dom:air', ...(c.clad === null ? [] : ['dom:clad'])],
        bcs: [{ id: 'V_sig', type: 'terminal', select: edges('sig') }, { id: 'gnd', type: 'ground', select: [...edges('gR'), ...edges('gL')] }] },
      { id: 'ewg', type: 'em-modes', select: optical, settings: { order: 2 } },
    ],
    mesh: {
      size: { hmax: um(h.hmax), grading: 0.25 },
      refine: [
        { select: ['dom:owin', 'dom:owinB'], h: um(h.win) },
        { select: ['dom:ribA', 'dom:ribB'], h: um(h.rib) },
        { select: c.clad === null ? ['bnd:sig.right', 'bnd:sig.left', 'bnd:gR.left', 'bnd:gL.right'] : ['bnd:sigLo.right', 'bnd:sigLo.left', 'bnd:gRLo.left', 'bnd:gLLo.right'], h: um(h.edge) },
      ],
    },
    couplings: [{ id: 'eo', type: 'electro-optic', from: 'es', to: 'ewg', settings: {
      armB, ...(armB === 'mirror' ? { mirrorX: { value: c.mirrorX * 1e-6, unit: 'm' } } : {}), terminal: 'V_sig',
      crystals: [{ material: 'LN', cut: 'x', propagation: 'y' }] } }],
    studies: [{ id: 'std', type: 'mode', physics: ['es', 'ewg'], settings: { wavelength: { value: c.lambda, unit: 'm' }, nModes: 2 } }],
  };
}

export async function runTfln(c: TflnCase, h = c.h, armB: 'mirror' | 'ideal' | 'none' = 'mirror') {
  const spec = tflnSpec(c, h, armB);
  const prep = await prepareRun(spec, { physicsId: 'ewg', studyId: 'std' });
  // material values as the test-side solver used them (DevLog-032), SI; prepareRun's flattened tensor keys
  // '<prop>.<component>' are the same library values
  const nLN = prop('linbo3-congruent', 'n', { lambda: c.lambda }) as Record<string, number>;   // Zelmon 1997
  const r = prop('linbo3-congruent', 'r_eo') as Record<string, number>;                         // Weis-Gaylord 1985, 633 nm clamped
  const eLN = prop('linbo3-congruent', 'eps_r') as Record<string, number>;                      // Weis-Gaylord 1985 Table 1, clamped
  prep.materials.LN = { 'n.perp': nLN.perp!, 'n.par': nLN.par!, 'eps_r.perp': eLN.perp!, 'eps_r.par': eLN.par!, 'r_eo.r13': r.r13!, 'r_eo.r22': r.r22!, 'r_eo.r33': r.r33!, 'r_eo.r51': r.r51! };
  prep.materials.SiO2 = { ...prep.materials.SiO2, n: prop('sio2-thermal-oxide', 'n', { lambda: c.lambda }) as number,   // Malitson 1965
    eps_r: prop('sio2-thermal-oxide', 'eps_r') as number };                                      // Zhu 2021 Table 1 (model input)
  prep.materials.Si = { ...prep.materials.Si, eps_r: prop('silicon', 'eps_r', { T: 293 }) as number };   // Li 1980 (optical-fit limit)
  const t0 = performance.now();
  const sol = await runStudy(prep) as Solution & { notes?: string[] };
  return { sol, mesh: prep.mesh as Mesh, ms: performance.now() - t0, nCells: nCells(prep.mesh) };
}
