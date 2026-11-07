// SPDX-License-Identifier: GPL-3.0-or-later
// Gate WO-01 (eval/cases/a/WO-01.yaml): symmetric Si slab (220 nm) in SiO2 at 1550 nm, n_eff of TE0 and TM0 against
// the slab dispersion relation (eval/expected/WO-01.json), tolerance rel 1e-6 after Richardson.
// Reduction of the 1D slab to the 2D vector solver: a window of width W in x (slab invariant in x), PEC at y = +-L.
//   TE0 (E = E_x(y) x^, parallel to the interfaces): its tangential E on the walls x = 0, W is (E_y, E_z) = 0, so PEC
//   side walls hold exactly; the x-invariant TE0 is an exact eigenmode of the 2D problem.
//   TM0 (H = H_x(y) x^, E = (0, E_y, E_z)): tangential H on x = 0, W is (H_y, H_z) = 0, so PMC side walls hold exactly.
//   W = 0.1 um << lambda / 2 pushes every x-varying mode (n_eff^2 reduced by (lambda / (2 W))^2 = 60) far below, so the
//   top mode is the x-invariant one; its polarisation is checked by the TE fraction.
// Cladding: 2.5 um each side of the core (case: >= 2 um); TM0 field at the wall ~ exp(-gamma 2.5 um) with
// gamma = k0 sqrt(n_eff^2 - n_SiO2^2) ~ 5.9 / um, i.e. a wall effect on n_eff far below 1e-6.
// Usage: nice -n 10 node --max-old-space-size=1536 packages/physics/gates/modes-wo01.ts

import { solveModes } from '../src/modes/index.ts';
import { slabMesh } from '../src/modes/fixtures.ts';
import { GateLog, readCase, readExpected, hFromDof, stagesOf, waitForLoad, type LevelRow } from './modes-common.ts';
import { verdictRows } from './common.ts';

const UM = 1e-6;

export async function runWO01(opts: { levels?: number[]; quiet?: boolean } = {}) {
  const cs = readCase('a', 'WO-01');
  const ex = readExpected('WO-01');
  const nSi = Number(cs.materials.Si.n), nOx = Number(cs.materials.SiO2.n);
  const t = Number(cs.geometry.spec.core_thickness_m);
  const lambda = Number(cs.study.settings.wavelength_m);
  const ref: Record<string, number> = {};
  for (const tg of ex.targets) ref[tg.metric_id] = tg.value;
  const tolRel = Number(cs.references.find((r: any) => r.metric_id === 'neff_TE0').tolerance.rel);
  const L = t / 2 + 2.5 * UM, W = 0.1 * UM;
  const levels = opts.levels ?? [1, 2, 4, 8];
  const log = new GateLog('modes-wo01');
  const load = await waitForLoad();
  log.write({ kind: 'meta', case: 'WO-01', nSi, nOx, t, lambda, L, W, order: 2, levels, load1: load, refs: ref, tolRel });
  const out: any = { case: 'WO-01', log: log.path, targets: {} };
  for (const [pol, side] of [['TE0', 'pec'], ['TM0', 'pmc']] as const) {
    const rows: LevelRow[] = [];
    for (const f of levels) {
      const mesh = slabMesh({ t, L, W, nCoreHalf: 2 * f, nClad: 12 * f, nx: f, c: 2.2 });
      const pec = ['bnd:rect.bottom', 'bnd:rect.top', ...(side === 'pec' ? ['bnd:rect.left', 'bnd:rect.right'] : [])];
      const t0 = performance.now();
      const { solution, result } = await solveModes({ mesh, eps: [nOx * nOx, nSi * nSi], pec, wavelength: lambda, nModes: 1, fields: false, order: 2 });
      const wall = performance.now() - t0;
      const m = result.modes[0];
      const want = pol === 'TE0' ? m.teFraction > 0.999 : m.teFraction < 1e-3;
      if (!want) throw new Error(`WO-01 ${pol} level ${f}: top mode has TE fraction ${m.teFraction}`);
      const r = ref[`neff_${pol}`]!;
      const row: LevelRow = { level: f, dof: solution.stats.dof, h: hFromDof(solution.stats.dof, 2), value: m.neff, err: (m.neff - r) / r, stages: stagesOf(solution), wall_ms: wall };
      rows.push(row);
      log.write({ kind: 'level', target: `neff_${pol}`, ...row, teFraction: m.teFraction, residual: m.residual });
    }
    const r = ref[`neff_${pol}`]!;
    // shared harness rule (gates/common.ts): ND2 / P2 eigenvalue, theoretical order 4
    const v = verdictRows(rows, { ref: r, unit: '1', rel: tolRel, after: 'richardson', order: 4 });
    const rich = { f_ext: v.value, p_obs: v.p_obs, gci_fine: null };
    const errExt = v.err !== null ? Math.abs(v.err) / r : NaN;
    const pass = v.status === 'pass';
    const raw = rows.find((x) => Math.abs(x.err) <= tolRel);
    const richMs = rows.slice(-3).reduce((s, x) => s + x.wall_ms, 0);
    const rec = { kind: 'target', case: 'WO-01', target: `neff_${pol}`, ref: r, tolRel, f_ext: rich.f_ext, p_obs: rich.p_obs, gci_fine: rich.gci_fine, err_ext_rel: errExt, pass,
      first_level_within_tol: raw ? { level: raw.level, dof: raw.dof, wall_ms: raw.wall_ms } : null, richardson_levels_wall_ms: richMs,
      under_5s: (raw ? raw.wall_ms : richMs) < 5000 };
    log.write(rec);
    out.targets[`neff_${pol}`] = { rows, ...rec };
    if (!opts.quiet) {
      console.log(`WO-01 ${pol}: ref ${r}`);
      for (const x of rows) console.log(`  level ${x.level}  dof ${x.dof}  n_eff ${x.value.toFixed(10)}  rel err ${x.err.toExponential(2)}  wall ${x.wall_ms.toFixed(0)} ms  ${JSON.stringify(x.stages)}`);
      console.log(`  [${v.basis}] value ${rich.f_ext?.toFixed(10)}  p_obs ${rich.p_obs?.toFixed(2)}  rel err ${errExt.toExponential(2)}  tol ${tolRel}  ${v.status.toUpperCase()}${v.reason ? ` (${v.reason})` : ''}  first raw level within tol: ${raw ? `${raw.level} (${raw.wall_ms.toFixed(0)} ms)` : 'none'}`);
    }
  }
  if (!opts.quiet) console.log(`log ${log.path}`);
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = await runWO01();
  process.exitCode = Object.values(r.targets).every((x: any) => x.pass) ? 0 : 2;
}
