// SPDX-License-Identifier: GPL-3.0-or-later
// Export the amp-material/0 JSON Schema (generated from the zod definition) to packages/materials/schema/.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { materialJsonSchema } from '../src/schema.ts';

const out = resolve(import.meta.dirname, '../schema/amp-material-0.schema.json');
mkdirSync(resolve(out, '..'), { recursive: true });
const text = JSON.stringify(materialJsonSchema(), null, 2) + '\n';
writeFileSync(out, text);
console.log(`${out} ${text.length} B`);
