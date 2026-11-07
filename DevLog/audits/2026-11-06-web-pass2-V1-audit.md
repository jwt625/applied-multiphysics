# Audit: web pass 2 (agent panel, Memory tab, BYO key, CSP) and V1 visual design pass

| Field | Value |
|---|---|
| Date | 2026-11-06 (runs 18:15-18:32 PST) |
| Auditor | fresh-context audit subagent (no prior conversation; files and runs only; no file edited except this report) |
| Scope | `apps/web/**` after DevLog-011 s.8 (pass 2) and DevLog-015 (V1) |
| Inputs read | CLAUDE.md; DevLog-001 s.1, s.4 (performance targets), s.6; DevLog-011 s.7-8; DevLog-015; DevLog-012 s.6.1; audits L5 and L9; source of `lib/post/accuracy.ts`, `play/heroes.ts`, `play/HeroHead.svelte`, `gfx/Graphics.svelte`, `post/revolve.ts`, `post/field2d.ts`, `post/post.worker.ts`, `workbench/session.svelte.ts`, `agent/*`, `vite.config.ts`, `static/_headers`; `packages/eval/src/metrics.ts` `richardsonRule`; `packages/physics/src/em-axisym/index.ts`; `packages/post/src/evaluate.ts` |
| Machine | M4 Pro shared; `nice -n 10`, Node heap 1536 MB; chrome-headless-shell 151 (SwiftShader WebGL) for FEM views, Google Chrome headless with WebGPU for RT |
| Builds | production build (`pnpm build`, 0 hook references) and a verification build (`VITE_AMP_HOOKS=1`), both copied to the scratchpad and served from there; `apps/web/build` left as the production build |
| Server | own static server applying `build/_headers` (same parser as `scripts/shots.ts`), 127.0.0.1:47829 / 47831 / 47833, each checked free with `lsof` first and closed after each run (checked) |
| Network | every non-127.0.0.1 request intercepted by playwright: `api.anthropic.com` fulfilled locally with a canned 401 (body echoing the fake key), everything else aborted. No request left the machine; no live LLM call. Only key used: `sk-ant-TEST-FAKE` |
| Evidence | `logs/audit-web2-{check,test,build,buildhooks,nodeprobe,axisym-midnodes}-20261106T181506.log`, `logs/audit-web2-run-20261106T181506.json` (all browser records), six PNGs `logs/audit-web2-*-20261106T181506.png` |

## 1. Gates rerun

| Gate | Result | Claim |
|---|---|---|
| `pnpm check` | 0 errors, 0 warnings, 1380 files | same (DevLog-015 s.6) |
| `pnpm test` | 9/9 pass, 803 ms | 9/9 |
| `pnpm build` | ok; CSP meta present on pages; 0 `__amp*` references in the production bundle | same |
| FCP, 5 fresh loads (prod) | `/` 37.2-38.9 ms (first browser load 475 ms, cold cache); kirsch 37.9-39.1; LBM 35.4-36.6; heat, box, helmholtz, cavity 37.7-42.0 (first browser load 391 ms) | 36-39 ms: reproduced |
| Load to gated accuracy, cold, 3 runs each | heat 2.80 / 2.34 / 2.32 s; cavity 2.99 / 2.57 / 2.56 s | heat 2.14 s, cavity 2.50 s: reproduced within 8-30 % (shared machine) |
| Load to gated accuracy, other heroes (one run each, 1440) | kirsch 2.86 s, helmholtz 2.24 s, box 3.96 s, rib N/A (1.3M DOF level above the 1M cap) | 2.22 / 2.17 / 3.99 / N/A |
| Drag preview, kirsch hole handle, 10 steps | 37.7-81.3 ms, median 54 ms; 0 long tasks during the drag and after release; 1 op | 53 / 83 ms, 0 long tasks |
| Mesh hash browser = Node | heat h 0.25 `f3aee322...`, helmholtz h 0.25 `246f90e1...`: equal to Node `prepareRun({hFactor: 0.25})` | 6/6 |
| B1 (helmholtz I 1 -> 2 A by exact field) | W_m 7.3894e-7 -> 2.9558e-6 J, ratio 4.000 on the same h 0.25 level, fresh; Undo restores W_m and the text byte for byte | pass |
| B2 (phone log pane) | 4/4 switcher buttons are the element under their own centre | pass |
| Page errors | none in any view; one CSP report per page load (`script-src`, blocked URI `eval`, see m1) | "none" |

## 2. Physics honesty of the new visuals

| Item | Result | Evidence |
|---|---|---|
| Kirsch mirroring, sxy | correct: sign flips across x = 0 and across y = 0, product sign in the opposite quadrant. Hover at (5.63, 5.04) mm: -2.51e5 Pa; Kirsch closed form at that point (a = 5 mm, sigma_inf = 1 MPa): -0.251 MPa. Mirror point (-6.16, 5.04) mm: +2.57e5 Pa; closed form at its image: +0.256 MPa | run JSON `kirsch.sxy` |
| Kirsch mirroring, u | u_x odd in x, even in y (+4.96e-8 / -5.25e-8 m; +5.56e-8 at y < 0); u_y odd in y, even in x (-1.06e-8 at y > 0, +8.40e-9 at y < 0, -9.27e-9 at x < 0, y > 0). sxx even in both. Colour range made symmetric when any copy is odd | `kirsch.u0`, `u1`, `sxx`; `Graphics.svelte` copies() and range |
| Helmholtz field lines | contours of psi = r A_phi (lattice of A_phi times r, post worker), 22 levels uniform in psi, so equal flux per tube and line density following abs(B); mirrored as even (psi is the same at phi = pi); Br and A_phi drawn odd (Cartesian x component on the section) | `post.worker.ts` lattice(psi), `Graphics.svelte` psi layer, screenshot |
| Cavity cutaway | section planes at phi 0 and 270 deg carry E(r, z) times the azimuthal factor at the tri6 nodes (split into 4); TM010 shows abs(E) max on the axis and zero at the side wall, as J0(2.405 r/a) requires; degenerate TE011 / TM111 pair listed at the same 5.983 GHz | screenshots; `revolve.ts` |
| em-axisym mid nodes | V1 report confirmed in Node: `E_rphiz` (H1P1) on the 169-cell tri6 mesh has 1146 = 3 x nNodes values and all 275 mid nodes are exactly 0. The web viewer is safe: `field2d.evalElement` uses corners for H1P1 and `revolvedValues` uses the corner mean at mid nodes (the P1 interpolant). Not safe outside the web: `@amp/post evaluateField` applies tri6 shape functions to the zero mid nodes: at a cell centroid it returns E_z = +38.07 against the P1 value -114.2 (sign and magnitude wrong). See S4 | `logs/audit-web2-axisym-midnodes-20261106T181506.log` |
| Accuracy badge rule | green only when `richardsonRule` is available (observed order within 25 % of the case's expected order) and GCI <= case tolerance: heat (p 3.65 vs 3, GCI 1.68e-7 <= 1e-3), cavity (p 4.02 vs 4, GCI 1.67e-8 <= 1e-5), box (p 3.87 vs 4, GCI 5.39e-7 <= 1e-4). Grey with "last change ... order N/A" for kirsch (oscillatory) and helmholtz (p 4.74 vs 2). Rib "accuracy N/A" (cap). Tested in `test/post.test.ts`. But the eigen badge is attached to the wrong mode (B1) | run JSON `play-*-1440.sess.acc`, `boxModes` |
| Interpolation | no tweened field: the eased camera moves the view only; headlines flash, no tweened numbers; eigen animation is u cos(phase) (exact for a real mode) or abs(E) abs(cos wt) (exact for a real lossless mode); finer accuracy levels replace the shown solution only with real solves; DG0 drawn per cell | `HeroHead.svelte`, `field-material.ts`, `field2d.ts` |
| Probe vs Node (same spec text, same h 0.25 level, exact FE evaluation) | heat T(0.3, 0.1) m: browser 353.22131430024143 K, Node 353.2213143002414 K; T(0.45, 0.35): 302.9890865751313 vs 302.98908657513135 K; T_E headline 18.253760259602245 degC vs Node 291.40376025960217 K = 18.25376026 degC. Helmholtz abs(B)(0, 0.01 m): 8.980018254269912e-6 T both; abs(B)(0.02, 0.03): 8.993371336407668e-6 vs ...666e-6 T; B_center 8.981455080869384 uT vs Node B_z(0, 0) 8.981455080869382e-6 T. Agreement to the last digit or one ulp | `logs/audit-web2-nodeprobe-20261106T181506.log` |
| Hero values vs case references | heat T_E 18.25376 vs HT-01 18.2537565 degC (2e-7 rel); cavity f0 2.9036361 vs RF-21 2.903636072 GHz; box f1 171.50007 vs AC-02 171.5 Hz. Helmholtz B_center 8.98146 uT vs EM-04 closed form 8.99176 uT: 1.15e-3 rel, above the case tolerance 1e-3 (finite winding section and the 1 m outer boundary; see S3) | run JSON |

## 3. Agent panel (mock provider for ops; key flow on the production build with all provider traffic intercepted)

| Check | Result |
|---|---|
| Key default | after Set: "key: in memory only"; localStorage keys: none; sessionStorage, OPFS (`amp-memory/`), IndexedDB (no databases): no key |
| Opt-in | ticking "remember" writes `amp.agent.provider-key.anthropic` to localStorage; unticking removes it (keys: none). "Clear key" present |
| DOM | key not in any attribute, not in any input value after Set (the password field is cleared), not in body text, outerHTML, URL or title; while typing, the password input has no `value` attribute |
| Console, logs, op log, memory | no console message contains the key; Timeline, Log, Memory, Messages text: no key; memory log JSONL and files: no key; an agent `memory_write` whose body held the key was refused ("[refused: contains a secret]") |
| Network | one request with the key: POST `https://api.anthropic.com/v1/messages?beta=true`, key in the `authorization` header (SDK 1.1.0 sends `Bearer <apiKey>`), not in the body. The canned 401 echoing the key is shown as `invalid x-api-key [redacted key]` |
| CSP (prod) | meta: `default-src 'self'; connect-src 'self' https://api.anthropic.com; worker-src 'self'; img-src 'self' data: blob:; script-src 'self' 'wasm-unsafe-eval' 'sha256-...'; object-src 'none'; base-uri 'self'; form-action 'none'`. Blocked with a violation report: fetch, sendBeacon and WebSocket to `example.com` (connect-src), image beacon (img-src), injected inline script (did not run), blob worker (worker-src). `/_app/*` responses carry the same script policy (workers) and `frame-ancestors 'none'` for all, as served by `_headers` locally; not yet seen on Cloudflare |
| Agent ops | mock "D 10 -> 15 mm, run": op #1 actor `agent:s-6f803f2acc74`, reason "audit: D 10 -> 15 mm"; "revert turn" appended op #2 actor `user`, kind undo, reason "revert agent turn 1", text byte-identical. Workbench `applyAgent`: Timeline row "agent audit", reason, amber marker, actor filter (all / user / agent (1)), revert -> `user` revert op, text byte-identical; `applyAgent` without a reason refused ("agent operations require a reason") |
| Memory ops | `memory_write heat-units`: file `amp-memory/heat-units.md` and a log line with actor `agent:s-...` and the reason; revert turn removed the file (log kept) |
| Cost caps | budget line: calls 3/12, tools 2/40, tokens in/out/cache, "turn N/A, session N/A (estimate)" (mock has no price); caps USD 1 / 5 editable in the panel |
| Hooks | production: `window.__ampWorkbench` and `__ampPlay` undefined |

## 4. Findings

### Blocking

**B1. The eigen accuracy badge reports the Richardson estimate of a different mode than the one shown (off by one in box-acoustics); "f0 = 0 Hz" gets a green badge.**
- Evidence (`boxModes` in the run JSON; `logs/audit-web2-play-box-badge-1440-*.png`): the solver's mode list is [0, 171.500, 214.375, 274.535] Hz; `levelValues` keeps only values > 0 (`accuracy.ts`: `filter((v) => v > 0)`), so level index 0 is 171.5 Hz, while `HeroHead` indexes the levels with the mode index `step`. Default view f1 = 171.5 Hz shows "est. err 1.3e-6 <= tol 1e-4 AC-02" and a tooltip listing 214.4232 / 214.3783 / 214.3752 Hz (the 214.4 Hz mode, GCI 1.32e-6; the 171.5 Hz GCI is 5.39e-7). Clicking "0 Hz" shows "f0 0 Hz, est. err 5.4e-7 <= tol 1e-4" in green with the 171.5 Hz levels. Clicking 214.4 Hz shows the 274.5 Hz estimate. Every mode's evidence is mislabelled; the 0 Hz (constant-pressure) mode, which has no discretization error estimate at all, is shown as verified. Violates "missing evidence shows as unavailable, never green" (DevLog-001 s.6).
- Cavity is not affected today (em-axisym drops near-zero modes before output), but the same index coupling breaks as soon as any solver returns a non-positive value or the mode order changes between levels.
- Fix: keep the full value list per level (no filter) and index by the solver's mode index; match modes across levels by nearest frequency (and m for axisym) rather than by index, and mark unmatched modes N/A; show N/A for a 0 Hz (rigid or constant) mode; the tooltip must list the shown mode's own values. Add a test with a leading 0 Hz mode. Also: the badge for a mode other than the case's metric (f_mode1, f_TM010) borrows that metric's tolerance; label it as such or show N/A for modes without a case metric.

### Significant

**S1. Play shows an invalid model as "not computed" and keeps drawing the previous geometry unmarked.**
- Evidence (`invalid` in the run JSON; `logs/audit-web2-play-kirsch-invalid-1440-*.png`): typing D = 15 mm in the kirsch exact field (spec range [1, 10]): `parsed.ok = false`, `status = 'error'`, `error = "spec does not validate: params.D.value: value 15 outside range [1, 10]"`. The canvas says "not computed: Compute runs the registered physics module", the aside says "not computed", and the D = 10 mm mesh (42,352 tri6) is still drawn as the geometry, with the drag handle at the D = 15 position outside the drawn hole. Play has no Messages pane, so the reason is shown nowhere. The same state follows an agent `apply_ops` out of range (mock run: "repair: validation_issues; run_failed").
- Cause: `Graphics.svelte`'s no-solution block has branches for running, unavailable and mesh-changed, none for `status === 'error'`; the mesh is not marked stale when the spec no longer builds.
- Fix: an error branch that shows `s.error` (first line) in the canvas and the aside; dim the geometry with "model invalid: earlier geometry" when `meshSpec !== specHash`; optionally clamp the exact field to the range or offer "widen range" (as the agent does).

**S2. Long main-thread tasks (300-500 ms) when accuracy levels land.**
- Evidence (PerformanceObserver longtask, 1440, SwiftShader): kirsch 446 ms at 490 ms (sequence 487-2857 ms), cavity 311 ms at 364 ms and 152 ms at 675 ms (sequence 343-2776), heat 444 ms at 502 ms (cold run 1), heat 273 ms at 2676 ms and helmholtz 500 ms at 2777 ms (right after the h 0.25 level, 240k DOF, is displayed). DevLog-015 s.6 reports "0 / 0" long tasks during drags / during the sequence; drags reproduce (0), the sequence does not. Under SwiftShader part of this is CPU rasterization and buffer upload of the near-1M-sub-triangle lattice, so a GPU browser will be better; not measured here. A drag that starts during such a task waits up to 0.5 s (DevLog-001 target < 100 ms).
- Fix: profile the level hand-over (setMesh, toMesh2D, refinedDisplay, psi and flux jobs, GL upload); build the display of a finer level off-screen in the worker and swap atomically; cap the lattice for levels below h 1 lower (r 1-2); split GL uploads across frames.

**S3. The badge text reads as "passes the case", while it only bounds this model's discretization error.**
- Evidence: the badge says "est. err X <= tol Y <case>" in green; only the tooltip says that hero-vs-case differences are excluded. Helmholtz shows the risk: its B_center (8.98146 uT) differs from the EM-04 closed form (8.99176 uT) by 1.15e-3 rel, above EM-04's 1e-3, while its discretization estimate is 3.1e-7. It is grey today only because the observed order (4.74) falls outside the band; with an in-band order it would show a green "<= tol 1e-3 EM-04" for a value outside that tolerance. Kirsch similar (3.0213 vs 3.0, finite plate).
- Fix: label it "disc. err" (or "mesh err"), and when the hero spec differs from the case spec show the reference comparison separately (value vs case reference, with the known model differences), or no case ID at all.

**S4. em-axisym `E_rphiz` zeros at tri6 mid nodes still poison every consumer outside the web viewer (cross-lane, L4 and @amp/post).**
- Evidence (Node, `sims/cylinder-cavity-axisym.yaml`, h 1): space H1P1, 1146 values = 3 x nNodes, 275/275 mid nodes exactly 0; `evaluateField` at a cell centroid gives E_z = +38.07 vs the P1 interpolant -114.2. The eval harness, `@amp/post sample`, CSV export and the agent's `summarizeSolution` read this field through the tri6 shape functions. The web views are safe (corner-only P1 in `field2d.evalElement` and `revolvedValues`).
- Fix (L4): fill mid nodes with the P1 interpolant (mean of the edge corners), or emit the field on corners with a P1 node map; add a test that `evaluateField` of E_rphiz equals the P1 interpolant. Until then, `@amp/post` should refuse H1P1 data on a quadratic mesh unless the mid nodes are consistent.

**S5. Workbench first view and overlays.**
- Evidence: the workbench opens in Mesh mode with ROI framing taken from the mirrored frame (a 5 D square centred on the hole); Mesh mode is not mirrored, so the computed quarter sits in the top-right quadrant, cut at the top, with three quarters of the canvas empty (`logs/audit-web2-wb-initial-mesh-1440-*.png`). Opening the Agent column does not re-fit the camera. In Results, the "kt 3.021" headline box covers the wrapped "r 3" smoothing select (`elementFromPoint` at its centre returns the headline row; `logs/audit-web2-wb-kirsch-results-1440-*.png`).
- Fix: in unmirrored modes, frame the ROI intersected with the model box (or All); re-fit on container resize; place the workbench headline below the toolbar's measured height.

### Minor

- **m1.** Every page load reports a CSP violation (`script-src`, blocked URI `eval`). Source: zod 4's JIT probe `try { return Function(''), !0 } catch { return !1 }` in `chunks/DN4kQm4R.js` and the runner worker. Harmless (falls back), but it pollutes violation reports once `report-to` is added. Fix: `z.config({ jitless: true })` at startup in the app and the workers.
- **m2.** CSP residuals: `connect-src` does not govern WebRTC (`RTCPeerConnection` ICE/STUN to any host) or top-level navigation, so an injected script could still exfiltrate an opted-in key that way. There is no third-party script today, which is the real control. Fix: keep the no-third-party rule; consider Trusted Types (`require-trusted-types-for 'script'`) and verify the headers on Cloudflare Pages.
- **m3.** The cutaway tooltip and `revolve.ts` header say "exact nodal values of the (r, z) solution"; E_rphiz is a vertex average of the Nedelec field over adjacent cells (`nodalFields`), not exact nodal values. Fix: "vertex-averaged (P1) projection of the Nedelec solution".
- **m4.** The 3D Nedelec cavity (`?solver=3d`) shows no accuracy badge at all (not even N/A). Fix: "accuracy N/A (no sequence for the 3D solve)".
- **m5.** RT layout shift unchanged from L5 M1: CLS FDTD 0.134, Gray-Scott 0.124 at 1440; Gray-Scott load has a 1.30 s long task (L5 S6). Workbench and Play CLS <= 0.012.
- **m6.** Rib: colorbar end label "2.58e-13" (normalized field floor); results list repeats `neff` after `neff_0`; DG0 cells visible in the substrate. Cavity colorbar end "6.74e-9". Fix: label normalized ranges 0..1 when the minimum is below 1e-6 of the maximum.
- **m7.** Helmholtz headline overlay sits on the field lines; with the translucent background the field lines run through "8.981". Fix: a more opaque backing (0.9) or reserve the corner in the ROI fit.
- **m8.** Agent panel: tool names wrap inside the 48 px column ("apply_o / ps", "run_stu / dy"); the budget line stays "no turn yet" after a provider error. Mesh-quality colorbar header shows the unit "1".
- **m9.** Mock run note: with D out of range the agent turn ended "run_failed", Play then showed "not computed" (S1).

## 5. Earlier L5 audit findings

| L5 # | Status now | Evidence |
|---|---|---|
| B1 stale result after exact-field edit | closed | W_m x 4.000 fresh, undo restores bytes (s.1) |
| B2 phone log trap | closed | 4/4 switcher reachable |
| S1 old field after unavailable | closed for unavailable (code: `handle()` clears the solution); the error state is still mislabelled "not computed" (new S1) | `session.svelte.ts`, run JSON `invalid` |
| S2 case credited wrongly | closed | aside "materials: from the model", case box off by default |
| S3 browser vs Node mesh | closed | h 0.25 hashes equal to Node for heat and helmholtz; FE values equal to the last digit |
| S4 eigen units | closed | colorbars "norm." in box, rib, cavity |
| S5 range hides the physics | closed | kirsch 0..3.02 MPa with peak marker; helmholtz p1-99 over the coil box, B_center visible |
| S6 long tasks | closed for drags (0); open for level hand-over (new S2) and Gray-Scott load (1.30 s) | s.1, m5 |
| S7 no live feedback for non-geometry params | closed per DevLog (coarse preview badge); not re-measured for the rib | - |
| S8 UI options with nothing behind them | closed | 3D cavity shows E_nodal controls only; colormap select reads "auto (balance)" |
| S9 no log toggle | closed (log only when > 2 decades) | rib, cavity toolbars |
| S10 security | closed | CSP present and enforced (s.3); hooks absent in production; `#log` private; `applyAgent` binds the actor and requires a reason |
| S11 agent rows | closed | amber marker, "agent" label, actor filter, revert |
| S12 stale DevLog | closed | DevLog-011 s.4 rerun; playwright-core 1.63.0 |
| M1 CLS | closed for workbench and Play (<= 0.012); open for RT (m5) | |
| M2 contrast | closed (active buttons white on #2462b5: 6.0:1 by my calculation; DevLog says 5.3:1) | |
| M3 touch targets | partly (Play 36 px; workbench 22 px by choice) | |
| M4 pending vs unavailable | closed | |
| M5 units | closed except the "1" unit header on the mesh-quality colorbar (m8) | |
| M6 helmholtz field | closed (normB) | |
| M7 colorbar ticks | closed | |
| M8 tooltip placement | closed in code (`offsetHeight`), not exercised | |
| M9 RT calm start, badge clipped | closed | "Run, or draw on the field to start"; badge visible at 390 |
| M10 timeline details | closed (amp-oplog/1, redo rows explained, Enter on tree and message rows) | |
| M11 preserveDrawingBuffer | closed (false in both renderers) | |
| M12 colorbar on phones | closed (horizontal strip) | |

## 6. Visual quality (10-point scale; screenshots at 1440x900 and 390x844 reviewed one by one)

| View | Rating | One line |
|---|---|---|
| kirsch-plate | 8 | full plate by mirroring, 13 contours, crisp 3.02 MPa peak, K_t large; the far-field sxx = 1 MPa contour X is real but busy |
| heat-plate-fin | 8.5 | isotherms plus equal-heat flux lines with arrows, T_E marked at E, green badge earned |
| helmholtz-coil | 8 | full section, 22 field lines at equal flux, amber 1 % band; headline overlay sits on the lines |
| si-rib-waveguide | 6 | ROI and n_eff fine; DG0 facets, "2.58e-13" colorbar end, no accuracy |
| cylinder-cavity (axisym) | 8 | 3/4 cutaway with filled sections, TM010 profile right, mode list with m; no field arrows |
| cylinder-cavity (3D) | 6 | plain shell, no cutaway, no badge |
| box-acoustics | 6 | lit box, clean edges; plain exterior only, and the badge belongs to the wrong mode (B1) |
| RT panels | 7.5 | crisp LBM, FDTD, Gray-Scott with colorbars and calm start; lots of empty canvas around LBM; CLS |
| workbench | 6.5 | proper structure and lit 3D; first view is a cropped quarter mesh in a corner, headline covers a control, empty Messages pane |
| phone (390) | 7.5 | bottom sheet, horizontal colorbars, readable headlines; handles crowd the rib |

Top 5 remaining improvements:
1. Fix the eigen badge mode mapping and the error-state display (B1, S1): honesty first.
2. Workbench first impression: frame the computed region in unmirrored modes, open on the solved Results view, collapse the empty Messages pane.
3. 3D body views: cutaway and default isosurfaces for the box and the 3D cavity, E/H arrows or Poynting particles for the cavity.
4. Remove the 300-500 ms hand-over stalls (S2) so the refine sequence is invisible to an interacting user.
5. Rib: smooth display (H1 projection of the DG0 field or contour bands), clean normalized colorbar ends, and E-vector arrows.

## 7. What was not checked

- A real GPU browser (all FEM views ran on SwiftShader), Safari, Firefox, OPFS in other browsers.
- The headers on Cloudflare Pages (only the local `_headers` parser).
- A live Anthropic call (by instruction); the CORS and COEP behaviour of the real endpoint.
- Rib drag previews and the coarse-preview badge (not re-measured).
