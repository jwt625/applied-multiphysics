# DevLog-017: deploy under outside5sigma.com/applied-multiphysics/ (lane D1, deployment prep)

| Field | Value |
|---|---|
| Date | 2026-11-06 |
| Lane | D1 (deployment prep) |
| Owns | `apps/web/**`, `deploy/**`, this file |
| Inputs | DevLog-001 A13 (static, Cloudflare Pages, COOP/COEP), Q6 (domain was TBD; now outside5sigma.com subroute); DevLog-011 s.1.9 / s.4.2 gates; DevLog-015 s.6 gates (CSP unchanged, FCP, drags, mesh hash) |

## 1. Plan (written 2026-11-06 19:00 PST, before coding)

Target: `https://outside5sigma.com/applied-multiphysics/`. The zone is on Cloudflare (proxied) in front of GitHub Pages (the blog). A Worker on the route `outside5sigma.com/applied-multiphysics*` forwards to the Pages project `applied-multiphysics` (`applied-multiphysics.pages.dev`); every other blog path stays on GitHub Pages.

### 1.1 Base path
- `BASE_PATH=/applied-multiphysics` (env, build time) sets kit `paths.base`. Unset: base `''`, build unchanged.
- With a base, the adapter writes pages and assets to `build/applied-multiphysics/`; a thin wrapper around adapter-static then writes `build/_headers` (every rule prefixed with the base) and `build/_redirects` (`/ /applied-multiphysics/ 302`) and removes the copied `build/applied-multiphysics/_headers`. Pages and the blog subroute then serve identical paths; the Worker forwards paths unchanged.
- `_headers` source stays `static/_headers` (rules written for root); the wrapper rewrites the path lines. No base: the file is copied as before.

### 1.2 Absolute paths in the app
- Links (`/play/...`, `/?sim=`, `/`): `resolve()` from `$app/paths`. Share URLs (`location.origin + '/play/...'`): `location.origin + resolve(...)`.
- `preload.server.ts` modulepreload links: prefix with `base`.
- Workers use `new URL(..., import.meta.url)` (base-safe, check in the build). WASM is built at run time from bytes (DevLog-016), no URL.
- Service worker: already uses `resolve` / `asset` for precache; check `pageKey` and the root key under a base (`/applied-multiphysics` vs `/applied-multiphysics/`). Registration scope comes from kit (`base + '/'`).
- Verification scripts (`scripts/shots.ts`, `v1-shots.ts`) keep root paths (they run on the default build).

### 1.3 Worker (`deploy/worker.js`, `deploy/wrangler.toml`)
- Module Worker. `/applied-multiphysics` exactly: 301 to `/applied-multiphysics/` (query kept). Path starting with `/applied-multiphysics/`: fetch `PAGES_ORIGIN + path + query` with method, headers, body (`redirect: 'manual'`), return the response unchanged (status, headers). Anything else (route glob also matches `/applied-multiphysicsX`): 404, never forwarded.
- No cache poisoning: no `cf.cacheEverything`, no Cache API, no rewriting of Host-dependent content; the upstream Host is the pages.dev host (fetch to a URL sets it); forwarded `Host`/`X-Forwarded-Host` not trusted for anything.
- `deploy/worker.test.mjs`: `node --test`, mocked `fetch`.

### 1.4 Verification
- Build with `BASE_PATH`, serve `apps/web/build` with `deploy/serve.mjs` (applies `build/_headers` and `build/_redirects` in Cloudflare Pages syntax, directory index and `.html` lookup), playwright-core headless Chromium: `/applied-multiphysics/`, two Play views; 0 404s / failed requests, `crossOriginIsolated === true`, SW registered with scope `/applied-multiphysics/`, a solve completes (hooks build `VITE_AMP_HOOKS=1`), CSP meta hash matches the inline script.
- Default build: `pnpm check`, `pnpm test`, `VITE_AMP_HOOKS=1 pnpm build` + `scripts/shots.ts`, production build last.

### 1.5 TODO
- [x] BASE_PATH in vite.config.ts, adapter wrapper writing `_headers` / `_redirects`
- [x] Fix absolute paths (links, share URLs, preload, SW)
- [x] deploy/worker.js, wrangler.toml, worker test
- [x] deploy/serve.mjs + base verification script
- [x] Base build verification
- [x] Default gates
- [x] deploy/README.md

## 2. Progress
- 2026-11-06 19:00 PST: plan written.
- 2026-11-06 19:02 PST: vite.config.ts BASE_PATH + adapter wrapper; links via resolve() (Workbench Play button, Play workbench / axisym / 3D links and share URL, RtPanel links), modulepreload via asset(); SW ignores requests outside its scope.
- 2026-11-06 19:04 PST: deploy/worker.js, wrangler.toml, worker.test.mjs (8/8), deploy/serve.mjs, scripts/base-check.ts.
- 2026-11-06 19:06 PST: first base check 23/26: SW page key of the root was `/applied-multiphysics` (trailing slash stripped), outside the scope. pageKey now keeps the scope root as is (root build: `/` as before). Rerun 26/26.
- 2026-11-06 19:07 PST: default gates: pnpm check 0/0, pnpm test 10/10, hooks build, scripts/shots.ts started.
- 2026-11-06 19:12 PST: shots.ts gates on the root hooks build passed; exact Pages build command (without the install) from the repo root; final root production build left in apps/web/build. Servers on 47417 / 47391 closed. No git.

## 3. Results

### 3.1 Base build (`BASE_PATH=/applied-multiphysics`, `logs/D1-base-check-20261107T030700.json`, build `logs/D1-build-base-hooks-*.log`)
Served by `deploy/serve.mjs` (Pages `_headers` / `_redirects` / clean-URL rules) on 127.0.0.1:47417; chrome-headless-shell 151.0.7922.34. 26/26 checks:

| Check | Result |
|---|---|
| `/` | 302 -> `/applied-multiphysics/` |
| `/applied-multiphysics` | 308 -> `/applied-multiphysics/` (Pages clean URL; in production the Worker answers 301 first) |
| `/applied-multiphysics/` headers | COOP same-origin, COEP require-corp, CORP same-origin, CSP frame-ancestors none |
| `_app/immutable/*.js` | `public, max-age=31536000, immutable`; CSP with `wasm-unsafe-eval` and `connect-src self https://api.anthropic.com` |
| `service-worker.js` | no-cache |
| outside the base (`/play/kirsch-plate`, `/_app/version.json`) | 404 |
| CSP meta hash vs inline bootstrap | matches on all 10 pages |
| workbench, kirsch-plate, heat-plate-fin | 0 failed / >= 400 requests; crossOriginIsolated true on first load and on the SW-served reload; SW scope `/applied-multiphysics/`, controller `/applied-multiphysics/service-worker.js`; all SW cache keys under the base; all internal links under the base; kirsch solved (42,796 DOF, cholesky), heat solved (60,970 DOF), workbench meshed (2,647 cells); no page errors |

Exact Pages build command (minus `pnpm install --frozen-lockfile`, not run to leave the shared node_modules alone) from the repo root: ok (`logs/D1-build-base-prod-*.log`), `build/` = `_headers`, `_redirects`, `applied-multiphysics/`; 0 hook references. Root lockfile `apps/web` importer specifiers = `apps/web/package.json` (22/22, script compare), so `--frozen-lockfile` should pass; not executed.

### 3.2 Default build (no BASE_PATH)
`pnpm check` 0 errors 0 warnings (1397 files); `pnpm test` 10/10; hooks build + `scripts/shots.ts` (`logs/L5-shots-20261107T030735.json`, run log `logs/D1-shots-root-20261106T190735.log`): errors none; FCP median 36.4 / 36.7 / 34.7 ms (workbench, kirsch Play, lbm RT); all six heroes solved and fresh, browser mesh hash = Node 6/6; drag max 24-613 ms (< 1 s), 0 long tasks; op-log round trip identical; B1 pass. `build/_headers` identical to `static/_headers`. Final production root build: 0 hook references (`logs/D1-build-root-prod-20261106T191238.log`). Screenshots of this run were kept in session scratch only (no layout change in this lane; RT and Play pages looked unchanged).

### 3.3 Worker
`node --test deploy/*.test.mjs`: 8/8 (301 with query, forward path + query + method + headers + body, hop headers dropped, headers and status returned intact, 304/404 pass-through, Pages Location rewrite to this host, other glob paths to the zone origin, dot segments, bad PAGES_ORIGIN fails closed). Not deployed; no live Cloudflare call.

## 4. Changes

| File | Change |
|---|---|
| `apps/web/vite.config.ts` | `BASE_PATH` -> `paths.base`; with a base, output to `build/<base>/` and an adapter wrapper writes `build/_headers` (rules prefixed) and `build/_redirects` |
| `apps/web/src/lib/workbench/Workbench.svelte`, `play/Play.svelte`, `play/RtPanel.svelte` | links and the Play share URL through `resolve()` |
| `apps/web/src/lib/shell/preload.server.ts` | modulepreload hrefs through `asset()` |
| `apps/web/src/service-worker/index.ts` | handles only requests inside its scope; root page key kept at the scope root |
| `apps/web/scripts/base-check.ts` | base verification driver (new) |
| `deploy/worker.js`, `wrangler.toml`, `worker.test.mjs`, `serve.mjs`, `README.md` | new |

Grep after the change: no absolute `/_app`, `/play` or `fetch("/...")` URLs in `apps/web/src`; remaining matches are route ids passed to `resolve` and the SW `includes('/_app/immutable/')` substring test (base-independent); workers use `new URL(..., import.meta.url)`; WASM is built from bytes at run time (DevLog-016), no URL.

## 5. Open items (for Wentao / coordinator)
1. Pages behaviour for a missing path when the output has no top-level `index.html` / `404.html` (SPA-fallback rule) is unverified; check `/applied-multiphysics/nope` after the first deploy (deploy/README.md s.5).
2. Zone features that rewrite HTML (Rocket Loader, Email Obfuscation) would break the CSP hashes; README s.3 compares the HTML hash via the blog and via pages.dev.
3. `wrangler@4.152.0` (npm publish 2026-10-22) is named for the optional CLI deploy; not run.
4. Pass-through of other glob paths relies on a Worker subrequest to its own zone going to the origin (GitHub Pages); a tighter alternative is two routes (`outside5sigma.com/applied-multiphysics` and `outside5sigma.com/applied-multiphysics/*`).
