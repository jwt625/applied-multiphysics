// SPDX-License-Identifier: GPL-3.0-or-later
// Gate 1 (DevLog-013): validate every materials/*.yaml; exit 1 on any issue.
import { loadMaterialsDir, DEFAULT_MATERIALS_DIR } from '../src/node.ts';

const dir = process.argv[2] ?? DEFAULT_MATERIALS_DIR;
const r = loadMaterialsDir(dir);
for (const f of r.files) {
  const n = r.issues.filter((i) => i.file === f).length;
  console.log(`${n === 0 ? 'ok  ' : 'FAIL'} ${f}${n ? ` (${n} issues)` : ''}`);
}
for (const i of r.issues) console.log(`  ${i.file}: ${i.path}: ${i.message}`);
console.log(`${r.files.length} files, ${r.docs.length} valid, ${r.issues.length} issues`);
process.exit(r.issues.length ? 1 : 0);
