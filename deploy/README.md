# Deploy: outside5sigma.com/applied-multiphysics/

The static app (`apps/web`) is built with `BASE_PATH=/applied-multiphysics` and hosted on the Cloudflare Pages project `applied-multiphysics`. A Cloudflare Worker on the blog zone forwards `outside5sigma.com/applied-multiphysics*` to that project with the paths unchanged. Every other path of outside5sigma.com stays on GitHub Pages. Design and verification: `DevLog/DevLog-017-deploy-subroute.md`.

```
browser -> outside5sigma.com (Cloudflare zone, proxied)
             /applied-multiphysics          -> Worker: 301 /applied-multiphysics/
             /applied-multiphysics/...      -> Worker: fetch https://applied-multiphysics.pages.dev/applied-multiphysics/...
             everything else                -> GitHub Pages (unchanged)
```

| File | Purpose |
|---|---|
| `worker.js` | Module Worker (redirect, forward, Location rewrite for Pages redirects, pass-through for other paths) |
| `wrangler.toml` | Worker name, route, zone, `PAGES_ORIGIN` |
| `worker.test.mjs` | Unit test with a mocked fetch: `node --test deploy/*.test.mjs` |
| `serve.mjs` | Local stand-in for Pages (`_headers`, `_redirects`, clean URLs), verification only |

Build output with a base path (`apps/web/build/`):

```
_headers                       every rule prefixed with /applied-multiphysics (COOP/COEP, CSP, immutable cache)
_redirects                     / -> /applied-multiphysics/ 302
applied-multiphysics/          index.html, play/*.html, _app/, service-worker.js, favicon.svg
```

## 1. Pages project

Cloudflare dashboard > Workers & Pages > Create > Pages > Connect to Git.

| Setting | Value |
|---|---|
| Repository | `applied-multiphysics` (GitHub) |
| Project name | `applied-multiphysics` (gives `applied-multiphysics.pages.dev`) |
| Production branch | `main` |
| Framework preset | None |
| Root directory | (empty: repository root) |
| Build command | `pnpm install --frozen-lockfile && BASE_PATH=/applied-multiphysics pnpm --filter ./apps/web build` |
| Build output directory | `apps/web/build` |
| Environment variables (production and preview) | `NODE_VERSION` = `23.7.0`, `PNPM_VERSION` = `10.12.4` |

Do not set `VITE_AMP_HOOKS` (test hooks; production builds carry none). Custom domains on the Pages project: none (the blog domain is served through the Worker). After the first deploy, `https://applied-multiphysics.pages.dev/` answers 302 to `/applied-multiphysics/` and the app is at `https://applied-multiphysics.pages.dev/applied-multiphysics/`.

## 2. Worker and route

Dashboard (no CLI needed):

1. Workers & Pages > Create > Worker. Name `applied-multiphysics-route`. Deploy the starter, then Edit code: replace everything with the contents of `deploy/worker.js`, Deploy.
2. Worker > Settings > Variables and Secrets > Add: type Text, name `PAGES_ORIGIN`, value `https://applied-multiphysics.pages.dev`. Deploy.
3. Worker > Settings > Domains & Routes > Add > Route: zone `outside5sigma.com`, route `outside5sigma.com/applied-multiphysics*`. If a request-limit failure mode is offered, choose fail closed.
4. Same page: disable the `workers.dev` route and Preview URLs (the Worker is only meant for the blog zone).
5. Compatibility date (Settings > Runtime): `2026-10-01` (as in `wrangler.toml`).

CLI alternative (same result, needs a Cloudflare API token with Workers Scripts and Workers Routes edit on the zone):

```
cd deploy && npx wrangler@4.152.0 deploy
```

The zone's DNS record for `outside5sigma.com` must stay proxied (orange cloud); a route only runs on proxied traffic.

Behaviour (tested in `worker.test.mjs`):
- `/applied-multiphysics` exactly: 301 to `/applied-multiphysics/`, query kept.
- `/applied-multiphysics/...`: `PAGES_ORIGIN` + same path + query, with the request method, headers (minus Host, X-Forwarded-*, Forwarded and the cf-* hop headers) and body, `redirect: manual`. The response is returned with its status and headers (COOP, COEP, CORP, CSP, Cache-Control). A Pages redirect pointing at `applied-multiphysics.pages.dev` gets its Location rewritten to `outside5sigma.com`.
- Other paths the glob matches (e.g. `/applied-multiphysics-notes`): passed to the zone origin unchanged (`fetch(request)`), never to Pages.
- No Cache API, no `cf.cacheEverything` or custom cache key, no forwarded Host: nothing is stored under a key it does not belong to.
- `PAGES_ORIGIN` unset or not a bare https origin: 500 (fails closed).

## 3. Post-deploy checks

```
# Pages project
curl -sI https://applied-multiphysics.pages.dev/ | grep -iE '^(HTTP|location)'                     # 302, location: /applied-multiphysics/
curl -sI https://applied-multiphysics.pages.dev/applied-multiphysics/ | grep -iE '^(HTTP|cross-origin|content-security)'
# Worker
curl -sI https://outside5sigma.com/applied-multiphysics | grep -iE '^(HTTP|location)'                # 301, location: https://outside5sigma.com/applied-multiphysics/
curl -sI https://outside5sigma.com/applied-multiphysics/ | grep -iE '^(HTTP|cross-origin|content-security|x-github-request-id|cache-control)'
#   expect 200, cross-origin-opener-policy: same-origin, cross-origin-embedder-policy: require-corp,
#   cross-origin-resource-policy: same-origin, content-security-policy: frame-ancestors 'none', no x-github-request-id
curl -sI https://outside5sigma.com/applied-multiphysics/play/kirsch-plate | grep -iE '^(HTTP|cross-origin-embedder)'
JS=$(curl -s https://outside5sigma.com/applied-multiphysics/ | grep -o '/applied-multiphysics/_app/immutable/entry/start\.[^"]*\.js' | head -1)
curl -sI "https://outside5sigma.com$JS" | grep -iE '^(HTTP|cache-control|content-security|cross-origin-embedder)'
#   expect cache-control: public, max-age=31536000, immutable; CSP with 'wasm-unsafe-eval' and connect-src 'self' https://api.anthropic.com
curl -sI https://outside5sigma.com/applied-multiphysics/service-worker.js | grep -i cache-control        # no-cache
curl -sI https://outside5sigma.com/applied-multiphysics/nope | grep -i '^HTTP'                          # expect 404 (see caveats)
# the zone must not rewrite the HTML (Rocket Loader, Email Obfuscation would break the CSP hashes): both hashes equal
curl -s https://outside5sigma.com/applied-multiphysics/ | shasum -a 256
curl -s https://applied-multiphysics.pages.dev/applied-multiphysics/ | shasum -a 256
# blog untouched
curl -sI https://outside5sigma.com/ | grep -iE '^(HTTP|x-github-request-id)'                         # 200, x-github-request-id present
```

In a browser at `https://outside5sigma.com/applied-multiphysics/`, DevTools console:

```
crossOriginIsolated                                                    // true
(await navigator.serviceWorker.ready).scope                            // "https://outside5sigma.com/applied-multiphysics/"
```

Then open `/applied-multiphysics/play/kirsch-plate`: the result plot and K_t appear (solve in the browser), Network shows no 404, Console shows no CSP violation. Reload once: still `crossOriginIsolated === true` (now served by the service worker).

## 4. Local verification

```
# from the repository root
(cd apps/web && BASE_PATH=/applied-multiphysics VITE_AMP_HOOKS=1 pnpm build)          # verification build (test hooks)
(cd apps/web && BASE_PATH=/applied-multiphysics node scripts/base-check.ts <outDir> 47417)   # deploy/serve.mjs + headless Chromium
node --test deploy/*.test.mjs
node deploy/serve.mjs apps/web/build 47417                                         # manual look: http://127.0.0.1:47417/
```

A plain `pnpm build` (no `BASE_PATH`) gives the root build of DevLog-011 (files directly in `build/`); the screenshots and gates of `scripts/shots.ts` run on that one.

## 5. Caveats

- Unknown paths: the base build has no top-level `index.html` or `404.html`. Pages treats a project without `404.html` as a single-page app; what it returns for a missing path when there is no top-level `index.html` was not verified (the local server answers 404). Check `/applied-multiphysics/nope` after the first deploy.
- `wrangler pages dev` was not used locally; `deploy/serve.mjs` emulates the `_headers` / `_redirects` / clean-URL rules this build uses.
- The service worker is scoped to `/applied-multiphysics/` and ignores requests outside it, so it does not touch the blog.
