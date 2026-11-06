// SPDX-License-Identifier: GPL-3.0-or-later
// Check that every $ref in the exported JSON Schema resolves to a $defs entry.
import { specJsonSchema } from '../src/schema.ts';
import { wave1Registry } from '../src/provisional/wave1.ts';
const js = specJsonSchema(wave1Registry()) as { $defs?: Record<string, unknown> };
const refs = new Set<string>();
JSON.stringify(js, (k, v) => { if (k === '$ref') refs.add(v as string); return v; });
const bad = [...refs].filter((r) => !(r.startsWith('#/$defs/') && js.$defs && r.slice(8) in js.$defs) && r !== '#');
console.log(`refs ${refs.size}, unresolved ${bad.length}${bad.length ? `: ${bad.join(', ')}` : ''}`);
process.exit(bad.length ? 1 : 0);
