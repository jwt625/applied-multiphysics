// SPDX-License-Identifier: GPL-3.0-or-later
// Minimal static server for verification only (DevLog-011 s.1.9): serves a directory with the headers of
// static/_headers (COOP same-origin, COEP require-corp, ...), prerendered `<path>.html` for extensionless routes.
// Usage: node scripts/serve.ts <dir> <port>
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const [dir = 'build', portS = '47391'] = process.argv.slice(2);
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.txt': 'text/plain', '.yaml': 'text/yaml', '.png': 'image/png' };
const HEAD = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cross-Origin-Resource-Policy': 'same-origin', 'X-Content-Type-Options': 'nosniff' };

async function file(p: string): Promise<string | null> {
	try { const s = await stat(p); return s.isFile() ? p : null; } catch { return null; }
}

createServer(async (req, res) => {
	const url = new URL(req.url ?? '/', 'http://x');
	const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
	const base = join(dir, rel);
	const hit = (await file(base)) ?? (await file(base + '.html')) ?? (await file(join(base, 'index.html')));
	if (!hit) { res.writeHead(404, HEAD); res.end('404'); return; }
	const body = await readFile(hit);
	res.writeHead(200, { ...HEAD, 'Content-Type': TYPES[extname(hit)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
	res.end(body);
}).listen(Number(portS), '127.0.0.1', () => console.log(`serving ${dir} on http://127.0.0.1:${portS}`));
