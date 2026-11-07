// SPDX-License-Identifier: GPL-3.0-or-later
// Pattern from eo-modulator-atlas app/src/service-worker/index.ts at 0546007 (GPL-3.0-or-later). Changes: own cache
// prefix, no on-demand data folders, no redirect workaround (Cloudflare Pages serves pages without redirects).
// One cache per deploy: pages and static files are precached on install, hashed code is stored on first use; the
// previous deploy's cache is kept so a page from it can still load its hashed files.
/// <reference lib="webworker" />
import { version } from '$app/env';
import { assets, prerendered } from '$app/manifest';
import { asset, resolve } from '$app/paths';
import { self as sw } from '$app/service-worker';

const PREFIX = 'amp-web-';
const CACHE = PREFIX + version;
const PRECACHE = [...prerendered.map((f) => resolve(f.path as '/')), ...assets.map((f) => asset(f.path)).filter((p) => !p.endsWith('/_headers'))];
const hashed = (path: string) => path.includes('/_app/immutable/');
const pageKey = (url: URL) => url.origin + (url.pathname.replace(/\/$/, '') || '/');

sw.addEventListener('install', (e) => {
	e.waitUntil(
		(async () => {
			const cache = await caches.open(CACHE);
			await Promise.all(
				PRECACHE.map(async (p) => {
					const res = await fetch(p, { cache: 'reload' });
					if (!res.ok) throw new Error(`${p}: HTTP ${res.status}`);
					await cache.put(pageKey(new URL(p, location.origin)), res);
				})
			);
			await sw.skipWaiting();
		})()
	);
});

sw.addEventListener('activate', (e) => {
	e.waitUntil(
		(async () => {
			const mine = (await caches.keys()).filter((k) => k.startsWith(PREFIX) && k !== CACHE).sort();
			for (const k of mine.slice(0, -1)) await caches.delete(k);
			await sw.clients.claim();
		})()
	);
});

async function respond(e: FetchEvent, url: URL): Promise<Response> {
	const key = e.request.mode === 'navigate' ? pageKey(url) : url.href;
	const cache = await caches.open(CACHE).catch(() => null);
	const hit = await cache?.match(key);
	if (hit) return hit;
	if (hashed(url.pathname)) {
		const old = await caches.match(key);
		if (old) {
			if (cache) e.waitUntil(cache.put(key, old.clone()).catch(() => {}));
			return old;
		}
	}
	const res = await fetch(e.request);
	if (res.ok && cache && hashed(url.pathname)) e.waitUntil(cache.put(key, res.clone()).catch(() => {}));
	return res;
}

sw.addEventListener('fetch', (e) => {
	const url = new URL(e.request.url);
	if (e.request.method !== 'GET' || url.origin !== location.origin) return;
	e.respondWith(respond(e, url));
});
