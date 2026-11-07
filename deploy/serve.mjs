// SPDX-License-Identifier: GPL-3.0-or-later
// Local stand-in for Cloudflare Pages, verification only (DevLog-017). Serves a build directory with:
//   _redirects  exact-path rules `from to [status]` (status default 302)
//   _headers    path pattern lines (`*` = any suffix) followed by indented `Name: value` lines; every matching block
//               applies, a header set by several blocks is joined with ", " (Pages behaviour)
//   lookup      /p -> p, p.html, p/index.html (p/index.html only: 308 to /p/); /p/ -> p/index.html (p.html only: 308 to
//               /p); /p.html and /p/index.html -> 308 to the clean URL; anything else 404 (this build has no
//               top-level index.html or 404.html, so no SPA fallback)
// Usage: node deploy/serve.mjs <buildDir> <port>     (binds 127.0.0.1; the port must be free)
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, normalize, resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.txt': 'text/plain', '.yaml': 'text/yaml', '.png': 'image/png' };

/** @param {string} text */
export function parseHeaders(text) {
	/** @type {Array<{ re: RegExp, h: Array<[string, string]> }>} */
	const rules = [];
	for (const line of text.split('\n')) {
		if (!line.trim() || line.trim().startsWith('#')) continue;
		if (!/^\s/.test(line)) rules.push({ re: new RegExp('^' + line.trim().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'), h: [] });
		else { const i = line.indexOf(':'); rules.at(-1)?.h.push([line.slice(0, i).trim(), line.slice(i + 1).trim()]); }
	}
	return (/** @type {string} */ path) => {
		/** @type {Record<string, string>} */
		const out = {};
		for (const r of rules) if (r.re.test(path)) for (const [k, v] of r.h) out[k] = out[k] ? `${out[k]}, ${v}` : v;
		return out;
	};
}

/** @param {string} text */
export function parseRedirects(text) {
	/** @type {Map<string, { to: string, status: number }>} */
	const m = new Map();
	for (const line of text.split('\n')) {
		const t = line.trim();
		if (!t || t.startsWith('#')) continue;
		const [from, to, status] = t.split(/\s+/);
		if (from && to) m.set(from, { to, status: Number(status ?? 302) });
	}
	return m;
}

/** @param {string} p */
async function isFile(p) {
	try { return (await stat(p)).isFile(); } catch { return false; }
}

/** @param {string} root */
export function createPagesServer(root) {
	const dir = resolvePath(root);
	const read = (/** @type {string} */ f) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8') : '');
	const headersFor = parseHeaders(read('_headers'));
	const redirects = parseRedirects(read('_redirects'));
	return createServer(async (req, res) => {
		const url = new URL(req.url ?? '/', 'http://local');
		const path = decodeURIComponent(url.pathname);
		const send = (/** @type {number} */ status, /** @type {Record<string, string>} */ extra, /** @type {Buffer | string} */ body = '') => {
			res.writeHead(status, { ...headersFor(url.pathname), ...extra });
			res.end(req.method === 'HEAD' ? undefined : body);
		};
		const redirect = (/** @type {string} */ to, status = 308) => send(status, { Location: to + url.search });
		const r = redirects.get(url.pathname);
		if (r) return redirect(r.to, r.status);
		const rel = normalize(path).replace(/^(\.\.[/\\])+/, '');
		const fsPath = join(dir, rel);
		if (!fsPath.startsWith(dir)) return send(404, {}, '404');
		if (rel.endsWith('/index.html')) return redirect(url.pathname.slice(0, -'index.html'.length));
		if (rel.endsWith('.html') && (await isFile(fsPath))) return redirect(url.pathname.slice(0, -'.html'.length));
		/** @type {string | null} */
		let hit = null;
		if (path.endsWith('/')) {
			if (await isFile(join(fsPath, 'index.html'))) hit = join(fsPath, 'index.html');
			else if (path !== '/' && (await isFile(fsPath.replace(/\/$/, '') + '.html'))) return redirect(url.pathname.replace(/\/$/, ''));
		} else if (await isFile(fsPath)) hit = fsPath;
		else if (await isFile(fsPath + '.html')) hit = fsPath + '.html';
		else if (await isFile(join(fsPath, 'index.html'))) return redirect(url.pathname + '/');
		if (!hit) return send(404, { 'Content-Type': 'text/plain' }, '404');
		const type = /** @type {Record<string, string>} */ (TYPES)[extname(hit)] ?? 'application/octet-stream';
		send(200, { 'Content-Type': type }, await readFile(hit));
	});
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	const [root = 'apps/web/build', port = '47417'] = process.argv.slice(2);
	createPagesServer(root).listen(Number(port), '127.0.0.1', () => console.log(`serving ${root} on http://127.0.0.1:${port}`));
}
