# DevLog-042: driven complex Helmholtz in 2D with PML, ports and plane-wave excitation (lane S1)

| Field | Value |
|---|---|
| Date | 2026-11-18 |
| Lane | S1 (DevLog-037 s.3, B1), chunk 1 |
| Owns | `packages/physics/src/wave2d/**` (new), `packages/physics/test/wave2d*.test.ts` (new), `validation/wave2d/**` (new), this file. Shared, named lines only: `packages/physics/src/registrations.ts` (one import, one spread, RESULT_NAMES entries), `packages/physics/src/driver.ts` (step-label lines), `packages/spec/src/provisional/wave1.ts` (the `frequency` study line), `packages/physics/src/acoustics/index.ts` (frequency-domain dispatch) |
| Read | CLAUDE.md; DevLog-037, -010, -031; CONTRACTS-v0 C1-C5, C11; `packages/physics/src/{index,registrations,driver,prepare}.ts`, `common/{ctx,mesh,scalar,lagrange}.ts`, `acoustics/index.ts`; `packages/core/src/la/{ldlt,ldlt-select,sparse,dense,types}.d.mts`; `packages/spec/src/{provisional/wave1,core-types,schema}.ts`; eval cases WO-03, AC-01, AC-03, EM-05, RF-04 |
| Status | done (gates s.4); audit fixes s.7 (2026-11-18); open items and requests s.6, s.7.7 |

Conventions: F = fact read from code or a run; D = decision of this lane (reason given); E = estimate; O = open item.

## 1. Plan (2026-11-18 08:57 PST, before coding)

### 1.1 Facts
- F: no driven frequency-domain solve exists; the `frequency` study is registered (`values` in Hz) but no module accepts it. `acoustics` readiness rejects any non-eigen study.
- F: the module registry (`modules`, `NEEDS`, `wrap`) lives in `packages/physics/src/index.ts`, which this lane does not own; `prepare.ts` (lane S3) resolves library (`ref:`) material properties only for the property list `NEEDS[type]`; `override` values are always resolved.
- F: core has `ComplexSupernodalLDLT` (complex-symmetric, static pivot perturbation, `solveRefined`) and `makeFactor(kind, sym)` ('blocked' default, 'wasm' opt-in), `analyze(pat, {ordering: 'nd', x, y})`, `elementSlots`, dense complex `cluFactor`/`cluSolve`/`cmatEig`.
- F: C5 has no complex field type and scalars carry one value each (no per-step scalars).

### 1.2 Formulation (time convention exp(+j omega t), as in Balanis)
One complex scalar kernel on Lagrange P2 (tri6; P1 tri3 accepted):

  -div(Lambda a grad u) - m s_x s_y u = 0 in Omega,   Lambda = diag(s_y / s_x, s_x / s_y) (= I outside PML)

| Use | u | a | m |
|---|---|---|---|
| `emw-2d`, polarization TM | E_z (V/m) | 1 / mu_r | k0^2 eps_r |
| `emw-2d`, polarization TE | H_z (A/m) | 1 / eps_r | k0^2 mu_r |
| `acoustics`, frequency study | p (Pa) | 1 / rho | omega^2 / (rho c^2) |

- Loss: eps_r = eps' (1 - j tan_delta) (exp(+j omega t): passive loss = negative imaginary part). Without eps_r: N = n - j kappa, eps_r = N^2 (lane T4 `kappa`, defined with exp(-i omega t) and kappa >= 0 for loss, DevLog-041 s.5; same physics). mu_r absent = 1 with a Solution note.
- k0 = omega / c0 with c0 = 299792458 m/s (SI defining constant), mu0 from `EPS0`/`MU0` of the electrostatics module (CODATA, already cited there).
- Weak form: sum over cells int (Lambda a grad u . grad v - m s_x s_y u v) dA + boundary terms = RHS; unconjugated bilinear form, complex symmetric matrix -> complex supernodal LDL^T (nested dissection on node coordinates), iterative refinement, residual reported.
- Dirichlet values by symmetric elimination (identity rows, RHS lifting); nodes outside the physics selection are inactive (identity rows, value 0).

### 1.3 PML (complex coordinate stretching)
- `pml` condition on domains (`select: [dom:...]`), registered as a domain condition (kind bc, select dom) like `heat-source`. Inner box = bounding box of the nodes of the non-PML cells of the physics; outer box = bounding box of all physics cells. For a PML point, d_x = distance beyond the inner box along x (0 inside the x range), L_x = PML thickness on that side; same for y; corners get both.
- s_xi(d) = 1 - j f_max (d / L)^p, f_max = -(p + 1) ln(R0) / (2 k_PML L): the continuum round-trip normal-incidence reflection of a PML backed by a reflecting wall is R0 (attenuation exp(-2 k int_0^L f dxi)); k_PML = k0 sqrt(Re(eps_r mu_r)) (EM) or omega / c (acoustics) of the PML cell. Settings: `R0` (default 1e-6, D: to be confirmed by gate c), `order` p (default 2). Outer PML boundary: whatever BC the user puts there (default natural = PMC for TM, PEC for TE, sound-hard).
- Requirement checked at run time: inner region non-empty, every PML cell outside the inner box (a PML cell inside the inner box is an error: geometry not box-like).

### 1.4 Excitations and boundary conditions
- `plane-wave` (scattered-field formulation): settings `direction` (angle from +x, deg or rad), `amplitude` (V/m for TM, A/m for TE, Pa for acoustics); `select` = background domains (one material, homogeneous; PML domains must have it too). u_inc = U0 exp(-j k_b (x cos phi + y sin phi)), k_b^2 = m_b / a_b. Unknown = scattered field u_s; RHS f(v) = -int_{cells with (a, m) != (a_b, m_b)} [(a - a_b) grad u_inc . grad v - (m - m_b) u_inc v] dA (derivation: total-field weak form minus the background equation satisfied by u_inc; the outer boundary term of u_inc cancels). Dirichlet boundaries (TM PEC, TE PMC, sound-soft): u_s = -u_inc; Neumann walls (TE PEC, sound-hard, TM PMC) add -int_Gamma a_b dn(u_inc) v ds (background a_b; corrected 2026-11-18, s.7.2). Outputs: total u = u_s + u_inc and the scattered u_s.
- `port` (boundary): straight boundary; 1D mode problem on the port nodes (line3 P2): -(a phi')' - m phi = -beta^2 a phi, generalized eigenproblem (M_m - K_a) phi = beta^2 M_a phi, real symmetric (Cholesky + tridiagonal QL) when a, m are real on the port, else complex (`cmatEig` on M_a^-1 (M_m - K_a)). Modes sorted by Re(beta^2) descending, normalised phi^T M_a phi = 1 (unconjugated). Port Dirichlet nodes (port ends on PEC walls in TM) are removed from the 1D problem. Boundary operator: exact discrete DtN with ALL port modes, -int_Gamma a dn u v = sum_k j beta_k (M_a phi_k)(M_a phi_k)^T u - 2 j beta_q A (M_a phi_q) for an incident mode q of amplitude A (derivation s.1.6). beta_k = sqrt(beta_k^2) with Im <= 0 (outgoing / decaying). Settings: `excite` (one port excited for the fields; default the first port), `nModes` (modes reported in the S matrix, default 1), `power` (incident power per unit depth, default 1 W/m; a normalization, stated in the Solution).
- S-parameters: all (port, mode) columns from one factorization (one RHS per reported mode). b_k = phi_k^T M_a (u - A phi_q delta) per mode; power-normalised S_ik = (b_i sqrt(Re beta_i)) / (A sqrt(Re beta_q)) for real-a ports (power per unit depth P = Re(beta) |b|^2 / (2 omega C), C = mu0 (TM), eps0 (TE), 1 (acoustics), with phi^T M_a phi = 1 for real modes). Evanescent modes are not reported.
- `scattering` (first-order absorbing): -int a dn u v -> + j k a int u v with k = sqrt(m / a) of the adjacent cell.
- `pec` / `pmc` (EM): TM: pec = Dirichlet 0, pmc = natural; TE: pec = natural, pmc = Dirichlet 0. Acoustics: `sound-hard` natural, `pressure` Dirichlet p (value; sound-soft = 0).
- `impedance`: EM Leontovich, settings R, X (ohm) or `sigma` (good conductor, Zs = (1 + j) sqrt(omega mu0 / (2 sigma))): TM: + j omega mu0 / Zs int u v; TE: + j omega eps0 Zs int u v (derivation s.1.6). Acoustics: specific impedance Z (Pa s/m): + j omega / Z int p q.
- `normal-velocity` (acoustics, cheap): v_n into the domain: (1/rho) dn p = j omega v_n (n outward) -> RHS int j omega v_n q... sign fixed in s.1.6.

### 1.5 Study, outputs
- Study `frequency`: `values` (Hz) or `wavelengths` (vacuum, m; EM only), exactly one (edit of the wave1.ts `frequency` line). Parametric sweeps re-run the study per param point (existing mechanism); frequencies may be param expressions.
- Fields per frequency step (C5 `step` = index, `steps: {kind: 'freq', values: Hz}`): TM `Ez_re`, `Ez_im`, `Ez_abs` (H1P2), `H_re`, `H_im` (DG0, 2 components, A/m), `normH`; TE `Hz_re/_im/_abs`, `E_re`, `E_im` (V/m), `normE`; acoustics `p_re/_im/_abs`, `v_re`, `v_im` (m/s), `normV`. Plane-wave runs add the scattered field `<u>_sc_re/_im/_abs`.
- Scalars (single frequency: bare names; several: suffix `_<step>`): ports `S<i><j>_re/_im/_abs/_dB/_phase` (fundamental modes; higher modes `S<i><j>_<p><q>_...`), `P_in`, `P_out_<i>` (W/m); plane wave: `sigma2d_back`, `sigma2d_fwd` (m), `sigma2d_total` (integrated over 360 angles, m), `beta_<i>_<k>` port propagation constants (1/m). Extra (non-C5) property `wave2d` with arrays for chunk 2 plots (S matrices per frequency, far-field sigma(phi)).
- Scattering width: far-field amplitude from Green's identity evaluated as a band integral (no contour derivatives): I(phi) = -int_B grad psi . (u_s grad g - g grad u_s) dA, g = exp(j k_b xhat . y), psi a C1 taper from 1 around the scatterers to 0 before the PML; sigma_2D(phi) = |I|^2 / (4 k_b |U0|^2) (derivation s.1.6; band must lie in the background).

### 1.6 Derivations (each one is checked by a gate in s.4)
- Weak form with PML: (lap_s + k^2) u = 0 in stretched coordinates d/dx -> (1/s_x) d/dx; multiplying by s_x s_y gives div(diag(s_y/s_x, s_x/s_y) a grad u) + m s_x s_y u = 0 (Cartesian stretch, s_x = s_x(x), s_y = s_y(y)); the integration by parts is the usual one, so the matrix stays complex symmetric.
- Scattered field: total u = u_inc + u_s, u_inc solves the background equation (a_b, m_b). Subtracting the background weak form from the total one leaves f(v) = -int [(a - a_b) grad u_inc . grad v - (m - m_b) u_inc v] over the cells whose medium differs; the boundary term of u_inc on the outer boundary is the background one and cancels. Physical walls act on the total field: Dirichlet u_s = g - u_inc; Neumann / Robin (a dn u_t + c u_t = 0) -> a dn u_s + c u_s = -(a dn u_inc + c u_inc), a boundary RHS; in the weak form this is -int (a_b dn u_inc + c u_inc) v with the background a_b, because the volume source already implies + int (a - a_b) dn u_inc v (corrected 2026-11-18, s.7.2). Boundaries without a condition and walls that touch PML cells act on u_s (transparent / PML backing).
- Port DtN (exp(+j omega t), s = distance into the domain from the port, n outward): u = A phi_q e^{-j beta_q s} + sum_k b_k phi_k e^{+j beta_k s}; with phi^T M_a phi = 1, b_k = phi_k^T M_a u - A delta_kq; a dn u = -a ds u gives -int_Gamma a dn u v = sum_k j beta_k (M_a phi_k . u)(M_a phi_k . v) - 2 j beta_q A (M_a phi_q . v). Evanescent: beta = -j |beta| (decays away from the domain). With all port modes this is the exact DtN of the semi-discrete (transversally discretised) waveguide.
- Power per unit depth of a port mode: TM P = Re(beta) / (2 omega mu0) int (1/mu_r)|phi|^2, TE: eps0 and 1/eps_r, acoustics: I = Re(p v*)/2 with v = beta p / (omega rho) -> P = Re(beta) / (2 omega) int (1/rho)|p|^2. Hence P = Re(beta) |b|^2 / (2 omega C) with C = mu0, eps0, 1 and S_ik = b_i sqrt(Re beta_i) / (A sqrt(Re beta_k)).
- Interface reflection (G-b1, G-b2): continuity of u and a du/dx with u = e^{-j b1 x} + r e^{j b1 x}, t e^{-j b2 x}: r = (a1 b1 - a2 b2)/(a1 b1 + a2 b2), b = k cos(theta); TM (a = 1/mu_r) gives the s-polarised Fresnel r for E, TE (a = 1/eps_r) the p-polarised r for H (Born and Wolf, Principles of Optics, 7th ed., sec. 1.5.2; equation numbers not checked offline, the derivation is the reference). A parallel-plate port mode cos(q pi y / H) is a pair of plane waves at sin(theta) = q pi / (H k1), and the interface is uniform in y, so its modal S11 is the oblique Fresnel r.
- Impedance (Leontovich, TM, wall normal +x): Ez = -Zs H_y and H_y = (1/(j omega mu)) dEz/dx -> a dn Ez = -(j omega mu0 / Zs) Ez -> + (j omega mu0 / Zs) int u v. TE: E_y = Zs H_z, E_y = -(1/(j omega eps)) dHz/dx -> + j omega eps0 Zs int u v. Zs = eta (matched) reproduces the first-order ABC j k a. 1D: Gamma_E = (Zs - eta0)/(Zs + eta0), Gamma_H = -Gamma_E. Good conductor: Zs = sqrt(j omega mu0 / sigma) = (1 + j) sqrt(omega mu0 / (2 sigma)) (exp(+j omega t)). First-order ABC at oblique incidence: r = (cos theta - 1)/(cos theta + 1).
- Acoustics: Euler j omega rho v = -grad p. normal-velocity v_in (into the domain): (1/rho) dn p = j omega v_in -> RHS + int j omega v_in q. Impedance Z = p / v_n (outward): + j omega / Z int p q (Z = rho c = first-order ABC).
- Scattering width: s.1.5 and the header of `wave2d/farfield.ts`; sigma_2D = 2 pi rho |u_s|^2 / |U0|^2 in the far field = |I|^2 / (4 k |U0|^2). Total W_s = (1/2 pi) int sigma_2D dphi (scattered power per unit depth / incident intensity). I(phi) is band-limited (|n| <= k r_max), so it is evaluated directly at 2 ceil(k r_max + 16) + 1 angles and trigonometrically interpolated to the 360-angle output grid and the exact forward / back angles.

### 1.7 Gates (>= 2 mesh levels each; references cited; tests in `packages/physics/test/wave2d*.test.ts`)
| Id | Case | Reference | Target |
|---|---|---|---|
| G-a1 | PEC cylinder, TM and TE, plane wave, ka ~ pi | Bessel/Hankel series, Balanis AEE 2nd ed. (2012) sec. 11.5 (TM^z, TE^z); scattered field and sigma_2D; script `validation/wave2d/cylinder_series.py`, scipy vs mpmath, optical theorem check | near-field |u| at probe points rel <= 1e-2 at the finest level and decreasing; sigma_2D(back) rel <= 1e-2 |
| G-a2 | dielectric cylinder (eps_r 4), TM and TE | series (continuity of u and a du/drho), same script | same |
| G-b1 | half-space interface, ports, normal and oblique incidence (higher parallel-plate mode = two oblique plane waves), s and p | Fresnel r = (a1 b1 - a2 b2)/(a1 b1 + a2 b2) (Born and Wolf, Principles of Optics, sec. 1.5.2; derivation s.1.6) | complex r error <= 2e-5 (h = lambda/20), <= 1e-6 (lambda/40); abs(abs(S21)^2 - T) same |
| G-b2 | dielectric slab, plane wave (scattered field), normal incidence | Airy slab formula (Born and Wolf sec. 1.6.4) | r, t rel <= 1e-3 |
| G-c | PML reflection vs thickness and angle (port + PML) | 0 (ideal) | |S11| below a stated bound per thickness, decreasing with thickness |
| G-d | straight slab waveguide S21 = exp(-j beta L), symmetric step reciprocity, energy | beta from the port mode; slab dispersion (Marcuse / Okamoto) root as independent check | abs(abs(S21) - 1) <= 1e-6; phase error <= 1e-4 rad; S12 = S21 to 1e-8; sum |S|^2 = 1 to 1e-8 |
| G-e | acoustics: duct (normal velocity in, matched impedance out, AC-01 setup in 2D), rigid cylinder scattering | closed form p = rho c v exp(-j k x); series (Neumann, same as TE PEC) | |p|/(rho c v) rel <= 1e-3; sigma_2D rel <= 1e-2 |

### 1.8 Performance
Record DOF, assemble / factor / solve ms per gate; one case near 1e5 complex DOF (target a few seconds in Node), blocked vs wasm complex kernel.

### 1.9 Requests to the coordinator
See s.6.

## 2. TODO
- [x] wave2d kernel: complex assembly (P1/P2, PML Lambda), boundary terms, Dirichlet elimination, complex LDL^T solve
- [x] PML geometry detection and stretch
- [x] plane-wave scattered field, NTFF sigma_2D
- [x] port modes (real and complex), DtN, S-parameters, power
- [x] scattering, pec/pmc, impedance, normal-velocity BCs
- [x] `emw-2d` module + registrations; acoustics frequency dispatch; frequency study wavelengths
- [x] reference scripts (validation/wave2d) with cross-checks
- [x] gates a-e, tests, DevLog numbers, example YAMLs
- [x] performance table
- [x] `pnpm --filter @amp/physics test`, `pnpm -r check`
- [x] hand-off
- [ ] (coordinator) index.ts module registration and prepare.ts property list (s.6 R1, R2)

## 3. Progress log
- 2026-11-18 08:47 PST: read CLAUDE.md, DevLog-037, -010, -031, CONTRACTS C1-C5; physics registrations, driver, index, prepare, acoustics, common helpers; core LA declarations.
- 2026-11-18 08:57 PST: plan written (this section).
- 2026-11-18 09:00-09:10 PST: `wave2d/{dense,pml,kernel,farfield,index,spec,probe}.ts`; shared lines (registrations import + spread + RESULT_NAMES, driver step labels, wave1 `frequency` line, acoustics dispatch). `tsc` clean.
- 2026-11-18 09:05 PST: `validation/wave2d/cylinder_series.py` (scipy vs mpmath <= 1.5e-15, optical theorem <= 5.2e-16) and first PEC cylinder run: sigma_back rel 1.8e-4 at h = lambda/10 on the first try.
- 2026-11-18 09:10 PST: far field made band-limited (direct sum at 2 ceil(k r + 16) + 1 angles, trigonometric interpolation): post 1.8 s -> 0.35 s at 62k nodes, values unchanged within quadrature error. Cell rule degree 2p (9 points) for assembly; band rule 2p + 2 (lower degree doubled the sigma error at h = lambda/10).
- 2026-11-18 09:12 PST: ports: straight guide |S21| - 1 = 2.4e-10, step reciprocity / energy at round-off; Fresnel normal + oblique, TM + TE; PML sweep. `validation/wave2d/planar_refs.py` (Airy closed form vs transfer matrix 1.6e-16; slab dispersion brentq vs mpmath 0).
- 2026-11-18 09:15 PST: fixes: `Math.max(...array)` on port matrices overflowed the call stack at 241 port nodes (loops now); port DtN assembly and projections without temporaries (ports stage 6.8 s -> 1.1 s at 97k nodes); `symGenEig` row-oriented solves and contiguous QL rotations (n = 241: 450 -> 63 ms).
- 2026-11-18 09:20 PST: coordinator note (lane T4 done): `kappa` bound in wave2d (eps = (n - j kappa)^2 with exp(+j omega t), consistent with DevLog-041 s.5); test added. The modes/** binding in that note is lane S2's scope (not edited here).
- 2026-11-18 09:20 PST: wave2d tests 16/16 (`logs/S1-wave2d-gates-20261118T092006.log`, 14.9 s; the n / kappa test added after it, 17 in total); physics suite 154/154 incl. all 17 wave2d tests (`logs/S1-physics-test-20261118T092041.log`); `pnpm -r check`: all packages Done, apps/web 1 error in `src/lib/shell/preload.server.ts` (`$app/environment`, not a file of this lane; `logs/S1-check-*.log`).

## 4. Results (Node v23.7.0, Apple M4 Pro, nice 10, machine load average 6-10 from the other lanes; DOF = mesh nodes = complex unknowns)

### 4.1 Gates
| Gate | Case | Level (h, DOF) | Value | Error | Tolerance | Result |
|---|---|---|---|---|---|---|
| G-a1 | PEC cylinder TM, k a = pi | lambda/10, 15,947 / lambda/20, 62,413 | sigma_back 1.639542 / 1.639881 m (ref 1.639875) | 2.0e-4 / 3.9e-6; fwd 1.4e-5 / 9.2e-6; total 9.2e-5 / 7.6e-6; near field 2.5e-4 / 4.8e-5 | 1e-3 / 1e-4; probes 1e-3 / 2e-4 | pass |
| G-a1 | PEC cylinder TE | same | sigma_back 1.682813 / 1.683037 m (ref 1.683029) | 1.3e-4 / 4.8e-6; fwd 2.7e-4 / 2.1e-5; total 1.4e-4 / 1.0e-5; near field 2.5e-4 / 1.5e-5 | same | pass |
| G-a2 | dielectric eps_r 4, TM (h/2 inside) | lambda/10, 26,950 / lambda/20, 81,160 | sigma_back 2.880401 m (ref 2.880350) | 2.1e-4 / 1.8e-5; fwd 3.3e-4 / 4.1e-5; total 2.0e-4 / 2.6e-5; near field incl. interior 6.4e-4 / 1.1e-4 | 1e-3 / 1e-4; 1e-3 / 3e-4 | pass |
| G-a2 | dielectric eps_r 4, TE | same | sigma_back 3.621165 m (ref 3.621218) | 4.5e-5 / 1.4e-5; fwd 3.2e-4 / 2.1e-5; total 2.5e-5 / 3.8e-6; near field 5.6e-4 / 1.1e-4 | same | pass |
| G-a | incidence along +y (probes rotated 90 deg), PEC TM | lambda/10 | | near field < 1e-3, sigma_back < 1e-3 | | pass |
| G-b1 | interface eps 1 / 2.25, ports, TM (s) | lambda/20, 3,780 / lambda/40, 15,021 | r(0 deg) -0.2000004, r(33.75 deg) -0.2525376 (ref -0.2, -0.2525375) | complex r 7.0e-6 / 3.7e-7 (0 deg), 3.9e-6 / 2.5e-7 (33.75 deg); abs(abs(S21)^2 - T) 2.4e-6 / 1.4e-7 | 2e-5 / 1e-6 | pass |
| G-b1 | same, TE (p) | same | r 0.1999997, 0.1462866 (ref 0.2, 0.1462867) | 6.0e-6 / 3.6e-7 ; 1.0e-6 / 1.5e-7 | same | pass |
| G-b2 | slab eps 4, t 0.3 lambda, plane wave, TM and TE | lambda/20, 2,224 / lambda/40, 8,355 | r, tau (ref closed form = transfer matrix) | max complex error 1.2e-4 / 7.8e-6 (TM), 1.4e-4 / 7.8e-6 (TE) | 1e-3 / 1e-4 | pass |
| G-c | PML, vacuum channel, h = lambda/20, order 2, R0 1e-8 | d = lambda/4, lambda/2, lambda | abs(S11) normal 1.1e-4, 4.4e-6, 1.1e-6; 33.75 deg 1.2e-4, 4.8e-6, 7.0e-8 | | 2e-4, 1e-5, 2e-6; decreasing in d | pass |
| G-c | default R0 1e-6, d = lambda/2 | | normal 3.7e-6; 33.75 deg 9.7e-6 (continuum R0^cos(theta) = 1.03e-5) | | 1e-5; 2 R0^cos | pass |
| G-d | straight slab guide (core eps 4, w 0.5, PEC walls at +-1.5), L = 2 | lambda/20, 24,638 / lambda/40, 97,205 | beta 11.7115488 / 11.7115546 1/m (ref 11.7115549, dispersion root) | abs(S21) - 1: 2.4e-10 / 3.4e-13; phase vs -beta L: 4.8e-4 / 3.2e-5 rad; beta 5.3e-7 / 3.2e-8; abs(S11) 1.9e-5 / 7.7e-7 | 1e-6; 1e-3 / 1e-4 rad; 1e-5 / 1e-6 | pass |
| G-d | symmetric step w -> 2 w, 13 propagating (port, mode) pairs | lambda/20 | abs(S21) 0.91953 | max abs(S_ij - S_ji) 1.8e-14; max abs(sum abs(S)^2 - 1) 7.2e-15 | 1e-10 | pass |
| G-d | lossy uniform guide eps 2.25, tan_delta 0.01 (complex port path) | lambda/40 | abs(S21) 0.953970 | S21 complex error 3.4e-6 vs exp(-j k0 sqrt(eps (1 - j tan_delta)) L) | 1e-4 | pass |
| G-d | n 1.5, kappa 0.002 (TE) | lambda/40 | abs(S21) 0.987512 (ref 0.987512) | 3.6e-6 | 1e-4 | pass |
| G-e | rigid / soft cylinder (acoustics, c 343, rho 1.2, f 343 Hz) | lambda/10, lambda/20 | identical to TE / TM PEC rows to 1e-14 (same discrete problem) | | | pass |
| G-e | duct 3.4 x 0.2 m, v 1 m/s in, Z = rho c out, 100 / 250 / 500 Hz | h 0.05 m, 3,056 | | max abs(p - rho c v exp(-j k x)) / (rho c v) 1.9e-4 | 1e-3 | pass |
| G-e | duct with two ports, 500 Hz | h 0.04 m | | S21 error 2.0e-5, abs(S11) 4.9e-7 | 1e-4 | pass |
| BC | impedance, good conductor sigma 5.8e7 S/m (test input), TM / TE | lambda/20 | 1 - abs(S11) 2.3981e-5 (ref 2.3981e-5) | complex Gamma 1.1e-5 / 9.0e-6 | 1e-4; loss 1 % | pass |
| BC | matched Zs = eta0, and `scattering` (first order) | lambda/20 | normal abs(S11) 6.9e-7; ABC at 33.75 deg r -0.0920135 (ref (cos - 1)/(cos + 1) = -0.0920134) | 1.4e-7 | 1e-5; 1e-4 | pass |

References: `validation/wave2d/cylinder_reference.json` (series; Balanis AEE 2nd ed. 2012 sec. 11.5 for the PEC TM / TE forms; penetrable coefficients from the continuity conditions in the script header; scipy vs mpmath <= 1.5e-15, optical theorem <= 5.2e-16), `validation/wave2d/planar_reference.json` (Airy slab, closed form vs transfer matrix 1.6e-16; slab dispersion root, brentq vs mpmath). Fresnel, ABC, impedance and duct references are closed forms derived in s.1.6.

### 4.2 Performance (PEC cylinder TM at h = lambda/28.6, 123,552 complex DOF, nnz 1.41e6, single frequency, Node)
| Front kernel | assemble | analyze (pattern + ND symbolic) | factor | solve + refine | post (fields, far field) | run total | RSS |
|---|---|---|---|---|---|---|---|
| blocked (JS) | 132 ms | 449 ms | 822 ms | 59 ms | 529 ms | 2.0 s | 0.60 GB |
| wasm | 135 ms | 483 ms | 493 ms | 56 ms | 520 ms | 1.7 s | 0.60 GB |
Same sigma_back to 2.4e-14. Mesh (prepareRun) 0.32 s extra. The analyze stage is shared across the frequencies of one study; a sweep of n frequencies costs about analyze + n (assemble + factor + solve + post). Ports: two ports of 241 nodes add 0.1 s (dense eigen) + DtN blocks; the dense port block enlarges the top front.

## 5. Example specs (for chunk 2 library sims; lane T3 owns sims/)

G-a1 (G-a2: `keepTools: true` on `air`, add `{id: core, override: {eps_r: 4, mu_r: 1}, select: ["dom:cyl"]}`, add `dom:cyl` to the physics, drop `wall`; acoustics G-e: `type: acoustics`, material `c`, `rho`, wall `sound-hard`, study `values` in Hz) (checked: prepareRun + run, 2026-11-18 09:2x PST):
```yaml
# G-a1 / G-a2: plane wave on a circular cylinder (PEC hole; dielectric: keepTools + eps_r 4 material on dom:cyl)
schema: amp-spec/0
id: cylinder-scattering-tm
title: PEC cylinder, TM plane wave
params:
  lam: {value: 1, unit: m}
  a: {value: 0.5, unit: m}
geometry:
  dim: 2
  features:
    - {id: outer, type: rect, settings: {center: {value: [0, 0], unit: m}, size: {value: [4, 4], unit: m}}}
    - {id: inner, type: rect, settings: {center: {value: [0, 0], unit: m}, size: {value: [3, 3], unit: m}}}
    - {id: inner2, type: rect, settings: {center: {value: [0, 0], unit: m}, size: {value: [3, 3], unit: m}}}
    - {id: cyl, type: circle, settings: {center: {value: [0, 0], unit: m}, radius: "a"}}
    - {id: pml, type: difference, settings: {base: outer, tools: [inner2]}}
    - {id: air, type: difference, settings: {base: inner, tools: [cyl]}}
materials:
  - {id: vac, override: {eps_r: 1, mu_r: 1}, select: ["dom:pml", "dom:air"]}
physics:
  - id: w
    type: emw-2d
    select: ["dom:pml", "dom:air"]
    settings: {polarization: TM}
    bcs:
      - {id: absorb, type: pml, select: ["dom:pml"]}
      - {id: inc, type: plane-wave, select: ["dom:air"], settings: {direction: {value: 0, unit: deg}, amplitude: {value: 1, unit: V/m}}}
      - {id: wall, type: pec, select: ["bnd:cyl.edge"]}
mesh:
  size: {hmax: "lam/20"}
studies:
  - {id: s, type: frequency, physics: [w], settings: {wavelengths: ["lam"]}}
```

G-b1 (checked: prepareRun + run, 2026-11-18 09:2x PST):
```yaml
# G-b1: planar interface between two ports; channel height H with natural walls; S11 mode 0 = normal, mode 1 = oblique Fresnel r
schema: amp-spec/0
id: interface-fresnel-ports
title: Interface reflection via port modes
params:
  H: {value: 0.9, unit: m}
geometry:
  dim: 2
  features:
    - {id: a, type: rect, settings: {center: {value: [0.25, 0.45], unit: m}, size: {value: [0.5, 0.9], unit: m}}}
    - {id: b, type: rect, settings: {center: {value: [0.75, 0.45], unit: m}, size: {value: [0.5, 0.9], unit: m}}}
materials:
  - {id: m1, override: {eps_r: 1, mu_r: 1}, select: ["dom:a"]}
  - {id: m2, override: {eps_r: 2.25, mu_r: 1}, select: ["dom:b"]}
physics:
  - id: w
    type: emw-2d
    select: ["dom:a", "dom:b"]
    settings: {polarization: TM}
    bcs:
      - {id: p1, type: port, select: ["bnd:a.left"], settings: {nModes: 2}}
      - {id: p2, type: port, select: ["bnd:b.right"], settings: {nModes: 2}}
mesh:
  size: {hmax: {value: 0.025, unit: m}}
studies:
  - {id: s, type: frequency, physics: [w], settings: {wavelengths: [{value: 1, unit: m}]}}
```

G-c (checked: prepareRun + run, 2026-11-18 09:2x PST):
```yaml
# G-c: port + PML slab (thickness d) terminating a vacuum channel; |S11| = PML reflection (mode 1 = 33.75 deg)
schema: amp-spec/0
id: pml-reflection
title: PML reflection
params:
  d: {value: 0.5, unit: m}
  L: {value: 1, unit: m}
geometry:
  dim: 2
  features:
    - {id: a, type: rect, settings: {center: {value: [0.5, 0.45], unit: m}, size: {value: [1, 0.9], unit: m}}}
    - {id: b, type: rect, settings: {center: ["L + d/2", {value: 0.45, unit: m}], size: ["d", {value: 0.9, unit: m}]}}
materials:
  - {id: vac, override: {eps_r: 1, mu_r: 1}, select: ["dom:a", "dom:b"]}
physics:
  - id: w
    type: emw-2d
    select: ["dom:a", "dom:b"]
    settings: {polarization: TM}
    bcs:
      - {id: p1, type: port, select: ["bnd:a.left"], settings: {nModes: 2}}
      - {id: absorb, type: pml, select: ["dom:b"], settings: {R0: 1.0e-8, order: 2}}
mesh:
  size: {hmax: {value: 0.05, unit: m}}
studies:
  - {id: s, type: frequency, physics: [w], settings: {wavelengths: [{value: 1, unit: m}]}}
  - {id: sweep, type: parametric, physics: [w], settings: {study: s, sweep: [{param: d, values: [{value: 0.25, unit: m}, {value: 0.5, unit: m}, {value: 1, unit: m}]}]}}
```

G-d (checked: prepareRun + run, 2026-11-18 09:2x PST):
```yaml
# G-d: slab waveguide (core eps 4, width w -> 2 w at x = 1 m) between PEC walls, two ports; drop c1/c2 for the straight guide
schema: amp-spec/0
id: waveguide-step-sparams
title: Slab waveguide step S-parameters
geometry:
  dim: 2
  features:
    - {id: box, type: rect, settings: {center: {value: [1, 0], unit: m}, size: {value: [2, 3], unit: m}}}
    - {id: c1, type: rect, settings: {center: {value: [0.5, 0], unit: m}, size: {value: [1, 0.5], unit: m}}}
    - {id: c2, type: rect, settings: {center: {value: [1.5, 0], unit: m}, size: {value: [1, 1], unit: m}}}
    - {id: core, type: union, settings: {inputs: [c1, c2]}}
    - {id: clad, type: difference, settings: {base: box, tools: [core], keepTools: true}}
materials:
  - {id: m_clad, override: {eps_r: 1, mu_r: 1}, select: ["dom:clad"]}
  - {id: m_core, override: {eps_r: 4, mu_r: 1}, select: ["dom:core"]}
physics:
  - id: w
    type: emw-2d
    select: ["dom:clad", "dom:core"]
    settings: {polarization: TM}
    bcs:
      - {id: p1, type: port, select: ["bnd:box.left", "bnd:c1.left"], settings: {nModes: 32}}
      - {id: p2, type: port, select: ["bnd:box.right", "bnd:c2.right"], settings: {nModes: 32}}
      - {id: walls, type: pec, select: ["bnd:box.top", "bnd:box.bottom"]}
mesh:
  size: {hmax: {value: 0.05, unit: m}}
studies:
  - {id: s, type: frequency, physics: [w], settings: {wavelengths: [{value: 1, unit: m}]}}
```

G-e duct (checked: prepareRun + run, 2026-11-18 09:2x PST):
```yaml
# G-e: rigid duct (AC-01 setup in 2D): normal velocity in, rho c impedance out; p = rho c v exp(-j k x)
schema: amp-spec/0
id: acoustic-duct-2d
title: Acoustic duct, matched end
geometry:
  dim: 2
  features:
    - {id: duct, type: rect, settings: {center: {value: [1.7, 0.1], unit: m}, size: {value: [3.4, 0.2], unit: m}}}
materials:
  - {id: air, override: {c: {value: 343, unit: m/s}, rho: {value: 1.2, unit: kg/m^3}}, select: ["dom:duct"]}
physics:
  - id: ac
    type: acoustics
    select: ["dom:duct"]
    bcs:
      - {id: in, type: normal-velocity, select: ["bnd:duct.left"], settings: {v: {value: 1, unit: m/s}}}
      - {id: out, type: impedance, select: ["bnd:duct.right"], settings: {Z: {expr: "1.2 * 343", unit: Pa*s/m}}}
      - {id: walls, type: sound-hard, select: ["bnd:duct.top", "bnd:duct.bottom"]}
mesh:
  size: {hmax: {value: 0.05, unit: m}}
studies:
  - {id: s, type: frequency, physics: [ac], settings: {values: [{value: 100, unit: Hz}, {value: 250, unit: Hz}, {value: 500, unit: Hz}]}}
```

## 6. Open items and requests

Requests to the coordinator (shared files not owned by this lane):
- R1 `packages/physics/src/index.ts`: register the module. Exact lines: `import { emw2dModule as emw2d0 } from './wave2d/index.ts';`, NEEDS entry `'emw-2d': { props: [] },` (eps_r or n is checked by the module), `export const emw2dModule = wrap(emw2d0);`, add `emw2dModule` to `modules`, `NORMALIZATION['emw-2d'] = WAVE2D_NORMALIZATION` (and the acoustics entry should say that frequency runs use WAVE2D_NORMALIZATION), and re-exports `export { solveWave2D, studyFrequencies, WAVE2D_REGISTRATIONS, RESULT_NAMES_WAVE2D, C0 } from './wave2d/index.ts';`. Until then the harness / web runner cannot dispatch `emw-2d` (tests use `emw2dModule` directly and `runStudy(prep, {modules: {...registry, 'emw-2d': emw2dModule}})`). The acoustics frequency path already works through the existing acoustics module.
- R2 `packages/physics/src/prepare.ts` (lane S3): `NEEDS['emw-2d'] = ['eps_r', 'tan_delta', 'mu_r', 'n', 'kappa']` so `ref:` materials resolve (overrides already work); `couplingMaterialContext`: for a frequency study with one frequency / wavelength pass `lambda = c0 / f` so dispersive library n, kappa are read at the study wavelength (several frequencies need per-frequency material evaluation: O4).
- R3 CONTRACTS-v0 changelog: physics type `emw-2d`; conditions `pml`, `plane-wave`, `port`, `scattering`, `impedance` (EM and acoustic forms), `normal-velocity`, `pec` / `pmc` for emw-2d; `frequency` study `wavelengths`; steps kind `freq`; complex fields as `<u>_re`, `<u>_im`, `<u>_abs` (+ `_sc_` for scattered), DG0 derived vectors; per-step scalars suffixed `_<step>` when a study has more than one frequency; extra Solution property `wave2d` (per frequency S matrix with keys, port betas, far field sigma(phi)); `normalization` text.
- R4 web (chunk 2, lane E6 / E1): (a) complex field display: Re / Im / abs / phase from the `_re`, `_im` pair and a phase-animation slider (Re(u e^{j phi})); field list grouping of `<u>_re/_im/_abs`; (b) frequency steps: the step selector already handles `steps`; label `freq` in Hz; (c) S-parameter plots: abs(S) in dB and phase vs frequency from `S<i><j>_dB_<k>` or better from `sol.wave2d.perFrequency[k].S` (keys, re, im); (d) polar / Cartesian plot of `perFrequency[k].farField` (phi, sigma2d); (e) PML region outline from `wave2d.pml` (inner / outer boxes); (f) the runner should pass `wave2d` and `notes` through the worker protocol (structured clone of plain arrays: fine).
- R5 eval (lane T2 / chunk 2): AC-01 is runnable in 2D with the duct spec above (1D plane-wave field); AC-03 and WO-03 are 3D / axisym (not covered by this 2D solver).

Open items:
- O1 Ports whose cross-section crosses a PML that stretches along the port normal are rejected (by design); transverse PML across a port works (complex modes, `cplxGenEig`), tested only through the lossy / complex path, not with an open slab + transverse PML case. Power normalisation of lossy / leaky modes uses Re(beta) (noted in the Solution).
- O2 Plane wave: homogeneous background only (layered backgrounds, e.g. a substrate, need the layered-medium incident field); oblique incidence on infinite layers needs Floquet BCs (chunk 2 E4); then the Fresnel oblique check can also run through the plane-wave path.
- O3 Axisymmetric frequency-domain acoustics (AC-03 rigid sphere) is not implemented (wave2d rejects axisym meshes); the kernel would need the r weight and axis handling.
- O4 Material dispersion over a frequency sweep: values are resolved once by prepareRun; a multi-wavelength study with library n(lambda) uses one n (R2).
- O5 Point / line sources and lumped ports (RF-04) are not implemented; a `surface-current` Neumann source is cheap if needed.
- O6 Assembly uses the binary-search scatter of `elementSlots` from core; when lane S4 lands precomputed scatter maps the cell part can switch to them (no request needed; local code).

## 7. Audit fixes (2026-11-18)

Lane F1 (fix lane of the fresh-context audit). Owns `packages/physics/src/wave2d/**`, `packages/physics/test/wave2d*.ts`, `validation/wave2d/**`, this section. Other fix lanes (modes/**, geom stack) run concurrently; no other files touched.

### 7.1 Findings, verification and plan (2026-11-18 09:53 PST, before coding)
| # | Finding | Verified (F, from the code) | Plan |
|---|---|---|---|
| 1 MAJOR | `kernel.ts` wall / Robin source of the plane wave uses the adjacent cell's `a` | F: true. The volume source integrates only (a - a_b) grad u_inc . grad v; integrating the background part a_b grad u_inc . grad v by parts per cell leaves the closed boundary integral of a_b dn u_inc v (a_b constant, u_inc smooth, interior faces cancel). With the total-field wall condition a dn u_t + c u_t = 0 the boundary RHS is therefore -int (a_b dn u_inc + c u_inc) v, not -int (a dn u_inc + c u_inc) v (derivation s.7.2). Wrong only where the wall cell has a != a_b. Also F: a `neumann` (normal-velocity) facet under a plane wave gets no u_inc term at all, so it acts on u_s (the boundary is transparent to the incident wave): same family, fixed the same way (physical boundaries act on the total field, s.1.6). | use pw.aB in the wall term; add the term for `neumann` facets; gate G-f (s.7.3) |
| 2 MINOR | base RHS (sources, Dirichlet values) added only to the excited port's solve | F: true (`isExc` branch): that S column contains the source response. | S columns from port solves with all sources off; one extra solve with the sources only (when the base RHS or a Dirichlet value is non-zero); field output = excited-port field + source field (unchanged meaning); source response reported per port as outgoing power `P_src_<i>` (W/m, all propagating modes); test with a closed form |
| 3 MINOR | impedance gate tolerance 1e-4 cannot see the reactance (Im Gamma_ref 2.4e-5) | F: true (good conductor: Re Zs = Im Zs = 0.0145 ohm vs eta0) | add Zs = R +- j X cases with X comparable to eta0 (Im Gamma ~ 0.4), tolerance 1e-4, check the sign of Im Gamma for both signs of X, TM and TE |
| 4 MINOR | test labelled "unsupported BC" tests a supported one | F: true (`impedance` is supported) | relabel; add readiness and run rejection of an unsupported type |

### 7.2 Derivation of the corrected wall term (finding 1)
Total field u_t = u_s + u_inc; u_inc solves -div(a_b grad u_inc) - m_b u_inc = 0 (a_b, m_b constant). The scattered field satisfies -div(a grad u_s) - m u_s = div((a - a_b) grad u_inc) + (m - m_b) u_inc. Weak form of the right side, cell by cell: -int (a - a_b) grad u_inc . grad v + int (m - m_b) u_inc v + closed-int (a - a_b) dn u_inc v (the code assembles the first two terms; the third, on the exterior boundary, is implied). Weak form of the left side: int (a grad u_s . grad v - m u_s v) - closed-int a dn u_s v. On a physical wall with a dn u_t + c u_t = 0: a dn u_s = -c u_s - a dn u_inc - c u_inc. Collecting the boundary terms: + int c u_s v on the left; right side -int (a dn u_inc + c u_inc) v + int (a - a_b) dn u_inc v = -int (a_b dn u_inc + c u_inc) v. Neumann source a dn u_t = g: right side + int (g - a_b dn u_inc) v. Dirichlet walls (u_s = g - u_inc) are unaffected.

### 7.3 Gate G-f (finding 1): plane wave at normal incidence on a slab backed by a wall
Geometry: PML [-1.25, -0.75] m | background [-0.75, 0] | slab [0, t], t = 0.3 m | wall at x = t; channel height 0.2 m with unlisted top / bottom (dn u_inc = 0 there). r = u_s(x) exp(-j k1 x) at x = -0.5 m. Two mesh levels h = lambda/20, lambda/40 (lambda in the background). Cases (material values are test inputs):
| Case | a in the slab (a_b = 1 or 1/rho_b) | wall |
|---|---|---|
| TE, eps_r 4 | 1/4 | `pec` (natural for H_z) |
| TM, eps_r 2, mu_r 4 | 1/4 | `pmc` (natural for E_z) |
| TM, eps_r 4 | 1 | `pec` (Dirichlet; not affected, control) |
| acoustics, background rho 1.2, c 343; slab rho 3.6, c 200 | 1/3.6 | `sound-hard` |
| same | | `impedance` Z = 1000 Pa s/m (Robin) |
| same | | `normal-velocity` v = 1e-3 m/s (Neumann source + incident wave) |
Reference (1D, exact for this geometry): background u = e^{-j k1 x} + r e^{j k1 x}, state (u, q = a du/dx) continuous; slab transfer matrix M = [[cos k2 t, sin(k2 t)/(a2 k2)], [-a2 k2 sin k2 t, cos k2 t]] from x = 0 to t; termination q(t) + c u(t) = g (natural c = g = 0; Robin c = j omega / Z; Neumann c = 0, g = j omega v; Dirichlet u(t) = 0). Route 1: impedance (admittance) recursion gamma = q / u transported from the wall to x = 0, gamma(0) = a2 k2 (a2 k2 tan(k2 t) + gamma_t) / (a2 k2 - gamma_t tan(k2 t)) (the lossless-line input-impedance relation, Pozar, Microwave Engineering, 4th ed., sec. 2.3; equation number not checked offline, the derivation here is the reference), r = (gamma0 + j a1 k1) / (j a1 k1 - gamma0) for g = 0; route 2: the 2 x 2 linear system of the transfer matrix (handles g != 0). Both in `validation/wave2d/backed_slab_refs.py`, agreement required <= 1e-13; lossless natural walls also |r| = 1. Target: complex r error <= 1e-3 (lambda/20), <= 1e-4 (lambda/40), decreasing (same as G-b2).

### 7.4 TODO
- [x] reference script + JSON (G-f), run before the fix (record the error), fix, run after
- [x] finding 2: source solve separate, `P_src_<i>`, RESULT_NAMES, test
- [x] finding 3: R +- j X impedance gate
- [x] finding 4: label, rejection test
- [x] full physics suite, `pnpm -r check`, previous gate numbers unchanged

### 7.5 Progress log
- 2026-11-18 09:53 PST: findings verified against the code (s.7.1), plan and derivation written.
- 2026-11-18 09:54 PST: `validation/wave2d/backed_slab_refs.py` -> `backed_slab_reference.json` (6 cases; route 1 vs route 2 <= 2.2e-16; natural / Dirichlet walls |r| = 1 to 1e-14). Cross-check: TE eps 4 + PEC (H_z, natural) gives r = -(TM eps 4 + PEC (E_z, Dirichlet)) exactly, as it must at normal incidence (same tangential E, r_H = -r_E).
- 2026-11-18 09:55 PST: G-f before the fix (`logs/F1-wave2d-Gf-prefix-20261118T095540.log`): complex r error 0.871 (TE pec), 0.918 (TM mu_r 4 pmc), 0.669 (sound-hard), 0.473 (impedance), 1.00 (normal velocity), at both levels (no convergence); TM pec (Dirichlet control) 1.05e-4 / 1.73e-5. Finding 1 confirmed (auditor's 0.87 reproduced for TE).
- 2026-11-18 09:55 PST: fix in `kernel.ts`: wall / Robin term uses pw.aB; `neumann` facets get the same total-field term (they were transparent to u_inc). Port branch: S columns from source-free solves, one extra source solve, field = excited port + sources, `srcPower` -> scalars `P_src_<i>` (`index.ts`, `spec.ts` RESULT_NAMES).
- 2026-11-18 09:56 PST: G-f after the fix: TM mu_r 4 at h = lambda/20 was 1.1e-3 (slab local wavelength 0.354 m = 7 h); the slab is now meshed at h/2 as in G-a2. All pass (`logs/F1-wave2d-walls-20261118T095640.log`).
- 2026-11-18 09:57 PST: findings 3, 4 in `wave2d-ports.test.ts`. wave2d tests 19/19 (`logs/F1-wave2d-gates-20261118T095716.log`, peak RSS 0.79 GB); every earlier wave2d number identical to s.4 to the printed digits.
- 2026-11-18 09:59 PST: `pnpm --filter @amp/physics test` 164/164 (`logs/F1-physics-test-20261118T095737.log`); `pnpm -r check`: all packages Done, apps/web 0 errors (`logs/F1-check-20261118T095921.log`).

### 7.6 Results
| Gate | Case | Level h (DOF) | Complex error (h = lambda/20 / lambda/40) | Tolerance | Result |
|---|---|---|---|---|---|
| G-f | TE eps_r 4 slab, `pec` (natural) | 0.05 (2,170) / 0.025 (8,380), slab h/2 | r 8.6e-5 / 1.3e-5 (before the fix 0.871 / 0.871) | 1e-3 / 1e-4, decreasing | pass |
| G-f | TM eps_r 2, mu_r 4, `pmc` (natural) | same | 9.9e-5 / 1.2e-5 (before 0.918 / 0.917) | same | pass |
| G-f | TM eps_r 4, `pec` (Dirichlet, control) | same | 9.0e-5 / 1.5e-5 (before, without slab refinement: 1.05e-4 / 1.73e-5) | same | pass |
| G-f | acoustics rho 3.6, c 200 slab, `sound-hard` | same | 9.2e-5 / 1.4e-5 (before 0.669) | same | pass |
| G-f | same, `impedance` Z = 1000 Pa s/m (Robin) | same | 3.9e-5 / 5.8e-6 (before 0.473) | same | pass |
| G-f | same, `normal-velocity` v = 1e-3 m/s + plane wave | same | 5.3e-5 / 8.1e-6 (before 1.00) | same | pass |
| ports + source | rigid-end duct 1 x 0.2 m, port at x = 1, velocity piston v = 0.01 m/s at x = 0, 500 Hz, h 0.04 | 0.04 | S11 vs exp(-2 j k L) 3.9e-5; S11 with vs without source 0 (bitwise); P_src_1 rel 7.5e-7 vs rho c v^2 H / 2; field(with) - field(without) vs rho c v exp(-j k x) 1.8e-4 | 1e-4; 1e-12; 1e-4; 1e-3 (as G-e duct) | pass |
| impedance | Zs = eta0 (0.5 +- 0.8 j), TM / TE, h lambda/20 | 0.05 | Gamma: TM 5.2e-6 (+X), 6.2e-6 (-X); TE 6.1e-6, 5.1e-6; Im Gamma_ref = +-0.5536, sign checked (TM sign X, TE -sign X) | 1e-4 | pass |
| readiness | `temperature` BC on emw-2d | | readiness false with "BC 'hot': type 'temperature' is not supported by the frequency-domain solver"; run rejects "unsupported BC types ...: hot (temperature)" | | pass |

"Before" values were run with a uniform mesh (no slab refinement); their error does not depend on h (0.871 at both levels), so the comparison is not affected.

New gate references: `validation/wave2d/backed_slab_reference.json` (s.7.3; two routes, 2.2e-16). Ports-with-sources and impedance references are closed forms in the test headers (rigid-end reflection, plane-wave intensity |p|^2 / (2 rho c), Gamma = (Zs - eta0)/(Zs + eta0), s.1.6).

### 7.7 Behaviour changes and open items
- Plane wave + `normal-velocity`: the velocity condition now acts on the total field (was: on the scattered field, i.e. the boundary was transparent to the incident wave). Plane wave + wall / impedance next to a non-background cell: results change (were wrong); next to the background (all earlier gates): unchanged.
- Ports + sources: S-parameters no longer contain the source response (were contaminated in the excited column); new scalars `P_src_<i>` (W/m, per frequency suffix as other scalars), `wave2d.perFrequency[k].srcPower`; Solution note states the convention. When the excited fundamental is not propagating the field output is the source response (was: zero, sources dropped).
- R3 addition (CONTRACTS changelog, coordinator): scalar `P_src_<i>` (W/m) for ports with sources.
- O7 (closed 2026-11-18 10:03 PST, coordinator decision: reject): under a plane wave, an exterior boundary without a condition next to a non-background, non-PML cell now fails the run with a plain message naming the boundaries and their domains and asking for a PML, a scattering condition or a wall / impedance condition (`checkOpenBoundaries` in `wave2d/index.ts`); open boundaries next to background or PML cells are unchanged. Spec-level readiness cannot see it (readiness gets no mesh), so the check runs at the start of the run, before assembly. G-b2 and G-f now list the channel walls next to the slab (natural type: pmc TM, pec TE, sound-hard); their numbers are unchanged (dn u_inc = 0 there). Test: `wave2d-walls.test.ts` (slab top / bottom open, slab back face open). wave2d 20/20 (`logs/F1-wave2d-gates-20261118T100158.log`), physics 165/165 (`logs/F1-physics-test-20261118T100216.log`), physics check clean.
