// SPDX-License-Identifier: GPL-3.0-or-later
// Gate 3 (DevLog-013): summary table of every default property at reference conditions T = 293.15 K,
// lambda = 1550 nm (properties that depend on them; a leaf valid only at another stated condition is shown there),
// plus the N/A list. Markdown to stdout. Indices: vacuum wavelength, n relative to vacuum.
import { defaultLibrary } from '../src/node.ts';
import { MaterialNAError } from '../src/library.ts';
import { parseUnit, toSI } from '../src/units.ts';

const REF = { T: 293.15, lambda: 1.55e-6 };
const lib = defaultLibrary();
const fmt = (v: number): string => Number(v.toPrecision(5)).toString();
const esc = (s: string): string => s.replace(/\|/g, '/').replace(/\s+/g, ' ');
const rows: string[] = ['| material | property | value at ref. conditions | unit (SI) | basis | source: locator |', '|---|---|---|---|---|---|'];
for (const id of lib.ids()) {
  const d = lib.get(id)!;
  for (const [p, leaf] of Object.entries(d.properties)) {
    if (leaf.value === 'N/A') continue;
    let val: string;
    let unit = '', basis = leaf.basis ?? '', loc = `${([] as string[]).concat(leaf.source ?? []).join(', ')}: ${leaf.locator ?? ''}`;
    try {
      // reference conditions; a leaf whose stated validity excludes them is shown at its own stated condition
      const opts: Record<string, number> = { ...REF };
      const at0: string[] = [];
      for (const k of ['T', 'lambda', 'f'] as const) {
        const e = leaf.valid?.[k];
        if (!e || !('unit' in e)) continue;
        const q = opts[k];
        const lo = toSI(e.range[0], parseUnit(e.unit)), hi = toSI(e.range[1], parseUnit(e.unit));
        if (q === undefined || q < lo - 1e-9 * Math.abs(lo) || q > hi + 1e-9 * Math.abs(hi)) { opts[k] = (lo + hi) / 2; at0.push(`${k} ${fmt((e.range[0] + e.range[1]) / 2)} ${e.unit}`); }
      }
      const r = lib.getProperty(id, p, opts);
      unit = r.unit;
      const dep = leaf.table ? leaf.table.x : leaf.fit ? leaf.fit.vars.map((v) => v.name).join('+') : '';
      const at = at0.length ? ` @${at0.join(', ')} (stated)` : dep.includes('T') ? ' @293.15 K' : dep.includes('lambda') ? ' @1550 nm' : '';
      val = typeof r.value === 'number' ? fmt(r.value) + at : Object.entries(r.value).map(([k, v]) => `${k} ${fmt(v)}`).join(', ') + at;
      if (r.analogOf) basis += ` (analog of ${r.analogOf})`;
      if (r.cteKind) val += ` (${r.cteKind}${r.T_ref ? `, T_ref ${fmt(r.T_ref)} K` : ''})`;
    } catch (e) {
      val = e instanceof MaterialNAError ? `N/A component: ${e.missing}` : `not evaluable at ref.: ${(e as Error).message}`;
    }
    rows.push(`| ${id} | ${p} | ${esc(val)} | ${unit} | ${basis} | ${esc(loc)} |`);
  }
}
console.log(rows.join('\n'));
console.log('\nN/A properties:\n');
console.log('| material | property | why |\n|---|---|---|');
for (const n of lib.listNA()) console.log(`| ${n.material} | ${n.property} | ${esc(n.missing)} |`);
