# DevLog-038: web test net and CI (lane T1, chunk 1)

| Field | Value |
|---|---|
| Date | 2026-11-18 |
| Lane | T1 (DevLog-037 s.3, scope C1) |
| Owns | `apps/web/test/**`, `apps/web/scripts/e2e*.ts` (new), `apps/web/package.json` scripts, move of `apps/web/src/lib/results/plot-ops.test.ts`, `.github/**` (new), root `package.json` scripts |
| Does not touch | app source under `apps/web/src` (bugs are listed in s.5 with file:line and repro), packages, sims, eval, git |

Conventions: F = fact read from code or a run; E = estimate; D = decision; O = open item.

## 1. Plan

1. plot-ops tests in the glob. D: move `src/lib/results/plot-ops.test.ts` to `test/plot-ops.test.ts` (imports rewritten to `../src/lib/results/plot-ops.ts`, sims path from the new location). The existing glob `test/*.test.ts` then picks it up; no glob change, so no test outside `test/` can hide again.
2. Unit tests (new files under `apps/web/test/`), expected values derived by hand:
   - `probe.test.ts`: `rayHit` (axis-aligned ray on a unit triangle, hit point and barycentric ref point; nearest of two parallel triangles; miss outside; ray parallel to the plane; hit behind the origin; clip half space drops the near hit; displacement times scale moves the drawn hit, ref stays on the undeformed surface); `columns` and `toTsv` (2D only, mixed 2D/3D, length unit factor, N/A for null, 8 significant digits, trailing newline).
   - `dg0.test.ts`: `recoverDG0` on hand-built tri3 meshes: constant field is reproduced; two-cell square with different areas gives the area-weighted mean at shared corners and the own value at unshared corners; domain interface keeps one value per domain (no smoothing across); NaN cell is skipped; vector components; bounded by the cell values; `smoothCoefficients` mid values are edge means.
   - `tree.test.ts`: `buildTree` on a hand-written spec object (node kinds, pointers, labels, subs, issue counts under each pointer, results folders present even without a results block, grouped items with `off`), `findNode`.
   - `tree-view.test.ts`: `viewFor` mode per node kind, `expandIds` (exact, split pieces `id#k`, parent, ancestors, fallback to the input ids), feature highlight ids, JSON Pointer unescaping.
   - `params.test.ts`: `paramViews` (number, literal string with unit, expression, object with range, span 0.5x..2x of the original value, negative value, zero value), `paramValue`, `paramPatchSI` (number, string with unit mm: SI 0.002 m -> "2 mm", object param, expression replaced by the SI-unit literal, unknown name).
   - `plot-data.test.ts`: pure exports (`enabledItems`, `plotGroup`, `groupsReading`, `lengthDisplay` thresholds, `fieldRef` incl. axisym components and physics tags) and `plot1dData` / `overlay2d` on a stub ResultsClient (NaN breaks between crossing pieces and between chains, x in the length unit, error items carry reasons, max/min marker positions).
3. e2e smoke `apps/web/scripts/e2e-smoke.ts` (playwright-core, headless shell resolved at runtime: `AMP_CHROME` env, else the newest `chromium_headless_shell-*` under `$PLAYWRIGHT_BROWSERS_PATH` or the per-OS ms-playwright cache under HOME; no hard-coded paths). Starts `vite dev` on `--port` (default 41731, refuses a busy port unless `--reuse`), checks:
   - landing: card count equals the library count computed in the page from the dev server's own `catalog.ts` and `sims.ts` modules with the analog-hide rule; a search narrows the cards and every shown card matches; no console errors.
   - the Play routes of `HEROES` load and settle (status solved or meshed), canvas not blank, no console errors.
   - per sim (every `SIM_IDS` entry, sorted; catalog entries and uncatalogued files; hidden analogs through `/workbench?sim=<id>`): page loads, no console errors or uncaught exceptions, mesh builds, Compute ends `solved` within the per-sim timeout, the graphics canvas is not blank (pixel standard deviation of a screenshot of the canvas element), DOM headlines recorded, and the paired case's numeric references with `extract.kind` scalar or eigen (with floor / offset / index, unit conversion through `@amp/spec` units) compared with the browser solution. D: a reference outside its tolerance is a failure only when the tolerance is not `after: richardson` (single browser level); otherwise it is recorded as `warn`. Comparisons are made only when the case's `spec:` names this sim file; other pairings are recorded as skipped with the reason.
   - flags: `--port`, `--only=<id>[,<id>]`, `--skip-landing`, `--skip-play`, `--timeout-scale`, `--reuse` (attach to a dev server already on the port). Output: `logs/T1-e2e-<ts>.jsonl` (one line per check) and `logs/T1-e2e-<ts>-summary.md`. Sequential, one page at a time; RSS of the browser and vite sampled per sim and recorded; a sim whose browser RSS exceeds 2 GB is recorded.
   - `apps/web/package.json`: script `e2e`.
4. CI `.github/workflows/ci.yml`: Node 24 (engines >= 23.6, type stripping default on), pnpm through corepack from `packageManager`, `pnpm install --frozen-lockfile`, `pnpm check`, `pnpm test` with `AMP_RT_ALLOW_NO_GPU=1`, class-a hero eval subset through `node packages/eval/src/cli.ts --case <ID>`; optional e2e job with the playwright headless shell installed on the runner (`playwright-core install chromium-headless-shell`) and software GL (swiftshader flags already in the launch). YAML validated locally with a parser.
5. Run everything; record results; real app or engine failures listed in s.5 for the coordinator.

## 2. TODO

- [x] plot-ops test moved into `test/`, runs in `pnpm test`
- [x] probe, dg0, tree, tree-view, params, plot-data unit tests
- [x] coordinator request (T3): runStudies, paramsOf, makeNavHost, resolvePointer tests; landing check on the app's listing rule; studies recorded
- [x] e2e smoke script + `e2e` script entry
- [x] e2e full run, JSONL + summary in logs/
- [x] CI workflow + root scripts; YAML parsed locally
- [x] apps/web `pnpm test`, root `pnpm check`; results recorded
- [x] hand-off

## 3. Progress log

- 2026-11-18 08:49 PST: Read CLAUDE.md, DevLog-037, shots.ts, hooks, catalog, Workbench/Play hooks, session fields, headline/accuracy, eval case format and harness extract (packages/eval/src/registry.ts). Plan written (s.1).
- 2026-11-18 08:52 PST: `plot-ops.test.ts` moved to `apps/web/test/` (imports and sims path rewritten); apps/web `pnpm test` 15 -> 21 tests, all pass.
- 2026-11-18 08:58 PST: unit tests probe (7), dg0 (8), tree + tree-view (6), params (5), plot-data (8) written; all pass first run except one wrong expectation of mine in `lengthDisplay` (extent 1.99 m is `cm` by the < 2 rule; fixed the test, kept the 1.99 case as a boundary check). apps/web `pnpm test`: 55 tests, 55 pass.
- 2026-11-18 09:00 PST: e2e smoke written (`scripts/e2e-smoke.ts`, `scripts/e2e-vite.ts`). First trial: every workbench check took 30 s: my `locator('.fail').textContent()` waited the default 30 s timeout for an absent banner; replaced by a count-first helper. Trial also showed 14 console 404s per page: app bug B1 (s.5), classified as `known` in the e2e (counted, not failed).
- 2026-11-18 09:05 PST: CI workflow `.github/workflows/ci.yml` written; YAML parsed with the `yaml` package (no actionlint installed). `e2e` script entries added (apps/web, root). Full e2e run started (port 41731).
- 2026-11-18 09:08 PST: full e2e run 1: 55 checks, 42 pass, 12 warn, 1 fail (semi-infinite-convection "canvas blank", 0.67 % non-background pixels). Screenshot looked at: the field is drawn; the model is a 2 m x 0.01 m strip, so it covers under 1 % of the canvas. Test threshold lowered to 0.05 % (s.1 D). `result` extracts were matched against headlines only (max / min / point items), so CP-43 VpiL and ng (global items) were not found: now evaluated from the item's group table (`results/api.ts` runOf / resultsClient, as the Table tab). A value the solution does not provide is recorded `pending` (harness rule), not warned.
- 2026-11-18 09:13 PST: run 2: 55 checks, 46 pass, 9 warn, 0 fail.
- 2026-11-18 09:14 PST: coordinator note (T3 done): `test/nav-studies.test.ts` (runStudies incl. solved study and parametric wrappers, paramsOf snapshot, makeNavHost, resolvePointer; nav.svelte.ts compiled with svelte/compiler server output into node_modules/.cache, removed after the test). Landing check now uses the app's `HIDDEN_ANALOGS`, `listedIds`, `LISTED_ENTRIES`, `libraryFor` (no restated rule) and compares the card ids with that list. Each sim records its studies; the default study is computed. B1 404s are counted as known only when the path is one of the page's own modulepreload links.
- 2026-11-18 09:19 PST: run 3 (final, s.4). apps/web `pnpm test` 60/60; root `pnpm check` all 11 packages Done, svelte-check 0 errors 0 warnings (1481 files). CI eval subset run locally (`--no-log`): 10 cases, all exit 0, 28 s. Superseded run-1/2 logs and my scratch files removed.

## 4. Results (2026-11-18 09:20 PST)

Unit tests (apps/web `pnpm test`, `node --test --test-concurrency=1 "test/*.test.ts"`): 60 tests, 60 pass, 0 fail (was 15 running; 6 of plot-ops never ran).

| File | Tests | Covers |
|---|---|---|
| test/plot-ops.test.ts (moved) | 6 | results tree ops (DevLog-027) |
| test/probe.test.ts | 7 | rayHit (hit, nearest, misses, clip, displacement), columns, toTsv |
| test/dg0.test.ts | 8 | recoverDG0 (constant, area weights, domain interface, NaN, vectors, fan of 2 domains, tri6), smoothCoefficients / evalCoef |
| test/tree.test.ts | 6 | buildTree, findNode, expandIds, viewFor |
| test/params.test.ts | 5 | paramViews, paramValue, paramPatchSI (incl. degC offset) |
| test/plot-data.test.ts | 8 | enabledItems, plotGroup, groupsReading, lengthDisplay, fieldRef, plot1dData (NaN breaks, units, errors, point graph), overlay2d (max/min, probes, line bins) |
| test/nav-studies.test.ts | 5 | runStudies, paramsOf, makeNavHost, resolvePointer |

E2E smoke, final run `logs/T1-e2e-20261118T171545.jsonl` (+ `-summary.md`, `-vite.log`): headless shell 151.0.7922.34 (revision 1234 in the ms-playwright cache), SwiftShader GL, 1440 x 900, vite dev on 41731 with HMR off; 210 s wall.
- 55 checks: 46 pass, 9 warn, 0 fail. Landing: 42 cards = 42 listed ids, search `acoustics` 2 = 2 expected, cleared back to 42. Play: 6/6 routes solved, canvas drawn. Sims: 48/48 meshed, computed `solved`, canvas drawn, no uncaught exceptions, no console errors other than B1.
- References (paired cases whose spec names the sims file): 47 within tolerance, 24 outside, 78 skipped (case spec is another sims file, or extract kind not evaluated), 15 pending (the solution has no such scalar / item). Every "outside" is a gated target with an `after: richardson` tolerance compared at one browser level (relative errors 1.1e-6 to 4.1e-3, all in box-acoustics, cpw-halfspace, cylinder-cavity-axisym, hadley-square-core / -hole, kirsch-exact, si-slab-tm0, si-strip-te0, wr90-te-cutoffs): warnings, not bugs. No gated reference outside a non-Richardson tolerance.
- Peak browser RSS 1816 MB (under the 2048 MB limit); slowest sims pzt4-cube 12.8 s, hadley-rib-wo02 12.6 s (parametric sweep), hot-arm-actuator 9.0 s.
- Multi-study sims (default study computed, others recorded): hadley-rib-wo02 and si-rib-waveguide (modes, sweep_t), membrane-air (eig, eig_vac), pzt4-cube (std_sc, std_oc).

CI (`.github/workflows/ci.yml`): job `check-test-eval` (Node 24, pnpm from `packageManager`, frozen lockfile, `pnpm check`, `pnpm test` with AMP_RT_ALLOW_NO_GPU=1, eval cases EM-01 EM-04 HT-01 HT-02 HT-03 SM-01 SM-02 WO-01 RF-21 AC-02, 15 min cap); job `e2e` (non-blocking, 15 min cap, headless shell installed on the runner only, `--skip-3d --timeout-scale 3`). YAML parsed with the `yaml` package; actionlint not installed, so not linted; the workflow has not run on GitHub yet (O1).

## 5. App and engine issues found (not fixed; coordinator)

- B1 (dev only): `apps/web/src/lib/shell/preload.server.ts:8-9` returns modulepreload links from `.svelte-kit/output/client/.vite/manifest.json` whenever that file exists, so after any `vite build` every `vite dev` page of `/workbench` (and Play) links 12-14 build chunks that 404 (744 console errors over the final run). Repro: `pnpm build` once, then `pnpm dev`, open `/workbench?sim=kirsch-plate`, console shows 404 for `/_app/immutable/chunks/*.js`. Fix idea: return `[]` when `import.meta.env.DEV`. The e2e counts these as `known` only when each 404 path is one of the page's own modulepreload links; remove the KNOWN entry in `e2e-smoke.ts` once fixed.
- B2 (warning, not an error): `apps/web/src/lib/landing/previews.ts:42` calls `asset('/previews/...')`; SvelteKit warns `asset_leading_slash` (126 warnings per landing load in the dev-server log; "should now be `asset('previews/...')`").
- Minor: `apps/web/src/lib/state/params.ts:47` `paramValue` writes a unitless string param (`'5'`, unit `1`) as `"7 1"`; it parses back to the same literal, so only the YAML text is odd.

## 6. Requests and open items

- R1 (T2 / eval): references the sims do not produce (recorded `pending` by the e2e and the harness): CP-04 `tip_UY` (hot-arm-actuator), EM-61 `L_kin`, `L_total_london`, EM-04 uniformity / truncation, CP-21 `sigma_yy_D_infinite`, RF-01 Q targets, WO-63 two targets, CP-43 `Z0_real`, `VpiL_measured`. Expected for pending targets; listed so the eval lane can confirm.
- O1: the workflow has not run on GitHub; first push will show whether the e2e job's `playwright-core install --with-deps chromium-headless-shell` and SwiftShader rendering work on ubuntu-latest. The e2e job is `continue-on-error`.
- O2: the e2e compares `probe` extracts on 2D meshes only and skips `expr`, `reduce`, `field`, `combine` and array eigen targets (recorded as skipped with the reason).
- Re-run at integration: `pnpm --filter @amp/web e2e` (or `pnpm e2e` at the root); flags `--port`, `--only id,id`, `--skip-landing|--skip-play|--skip-sims|--skip-3d`, `--timeout-scale`, `--rss-limit-mb`, `--reuse`, `--tag`. Exit 0 = no fail.
