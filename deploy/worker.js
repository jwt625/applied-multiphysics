// SPDX-License-Identifier: GPL-3.0-or-later
// Cloudflare module Worker on the route outside5sigma.com/applied-multiphysics* (DevLog-017). Serves the static app from
// the Pages project (env.PAGES_ORIGIN, e.g. https://applied-multiphysics.pages.dev) under the same paths; every other
// path of the blog stays on its origin (GitHub Pages).
//   /applied-multiphysics               -> 301 /applied-multiphysics/ (query kept)
//   /applied-multiphysics/...           -> PAGES_ORIGIN + same path + query (method, headers, body); response returned
//                                          with its status and headers (COOP, COEP, CSP, Cache-Control) unchanged
//   anything else the route glob matches (e.g. /applied-multiphysics-notes) -> passed to the zone origin untouched
// Cache: no Cache API, no cf.cacheEverything / cacheKey, no Host or X-Forwarded-Host forwarding; the upstream URL is
// built only from the fixed PAGES_ORIGIN and the request path, so a response is never stored under a key it does not
// belong to.

export const BASE = '/applied-multiphysics';

/** Request headers that describe the client hop to this zone, not the request to Pages. */
const HOP = ['host', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-for', 'x-real-ip', 'forwarded', 'cf-connecting-ip', 'cf-ipcountry', 'cf-ray', 'cf-visitor', 'cf-worker', 'cdn-loop'];

export default {
	/**
	 * @param {Request} request
	 * @param {{ PAGES_ORIGIN?: string }} env
	 * @returns {Promise<Response>}
	 */
	async fetch(request, env) {
		const url = new URL(request.url);
		if (url.pathname === BASE) {
			return new Response(null, { status: 301, headers: { Location: `${url.origin}${BASE}/${url.search}` } });
		}
		if (!url.pathname.startsWith(BASE + '/')) return fetch(request);

		let origin = null;
		try { origin = new URL(env.PAGES_ORIGIN ?? ''); } catch { /* unset or malformed */ }
		if (!origin || origin.protocol !== 'https:' || origin.pathname !== '/' || origin.search || origin.hash) {
			return new Response('PAGES_ORIGIN must be an https origin', { status: 500 });
		}
		const target = new URL(url.pathname + url.search, origin);
		const headers = new Headers(request.headers);
		for (const h of HOP) headers.delete(h);
		const bodyless = request.method === 'GET' || request.method === 'HEAD';
		const upstream = await fetch(target, { method: request.method, headers, body: bodyless ? undefined : request.body, redirect: 'manual' });

		// Pages redirects (e.g. /x.html -> /x, /dir -> /dir/) must stay on this host
		const loc = upstream.headers.get('location');
		if (loc) {
			const to = new URL(loc, target);
			if (to.origin === origin.origin) {
				const res = new Response(upstream.body, upstream);
				res.headers.set('location', url.origin + to.pathname + to.search + to.hash);
				return res;
			}
		}
		return upstream;
	}
};
