// SPDX-License-Identifier: GPL-3.0-or-later
// Rate-limited cached fetch for material sources (DevLog-013). Usage:
//   node scripts/fetch-cached.ts <material-id> <url> <file-name>
// Writes cache/materials/<id>/<file> and <file>.json {url, date, sha256, status, contentType, bytes}. Skips files
// already cached. Waits 3-6 s (jitter) before every network request. Generic User-Agent, no contact details.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [id, url, name] = process.argv.slice(2);
if (!id || !url || !name || !/^[a-z0-9][a-z0-9._-]*$/.test(id) || name.includes('/')) {
  console.error('usage: fetch-cached.ts <material-id> <url> <file-name>');
  process.exit(2);
}
const root = resolve(import.meta.dirname, '../../..');
const dir = join(root, 'cache', 'materials', id);
const file = join(dir, name);
if (existsSync(file)) {
  console.log(`cached: ${file}`);
  process.exit(0);
}
mkdirSync(dir, { recursive: true });
await new Promise((r) => setTimeout(r, 3000 + Math.random() * 3000));
const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (research fetch; materials library)' }, redirect: 'follow' });
const buf = Buffer.from(await res.arrayBuffer());
const meta = {
  url, finalUrl: res.url, date: new Date().toISOString(), status: res.status,
  contentType: res.headers.get('content-type'), bytes: buf.length,
  sha256: createHash('sha256').update(buf).digest('hex'),
};
if (!res.ok) {
  console.error(`HTTP ${res.status} for ${url}; not cached`);
  console.error(buf.subarray(0, 400).toString('utf8'));
  process.exit(1);
}
writeFileSync(file, buf);
writeFileSync(`${file}.json`, JSON.stringify(meta, null, 2) + '\n');
console.log(`${meta.status} ${meta.contentType} ${meta.bytes} B -> ${file}`);
