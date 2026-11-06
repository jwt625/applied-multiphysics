# DevLog-000: Scoping - open-source, agent-native multiphysics platform

| Field | Value |
|---|---|
| Date | 2026-09-28 |
| Status | Scoping (no code yet) |
| Scope | Project goal, decisions, architecture, first vertical, milestones, open items |
| Authors | Claude (Sonnet 5.5), at Wentao Jiang's request |
| Repo | applied-multiphysics (personal account), GPL-3.0-or-later |

## 1. Goal

An open-source, agent-native alternative to COMSOL Multiphysics. Local-first web app that can also be deployed for web users, plus a CLI and API for agents. First vertical: photonics, RF and thermal multiphysics for advanced packaging.

## 2. Decisions (Wentao, 2026-09-28)

| # | Decision |
|---|---|
| D1 | First vertical is photonics + RF + thermal, focused on advanced packaging (highly multiphysics). |
| D2 | Local-first web app, deployable as a hosted web service; CLI and API for agents. |
| D3 | Editing model: direct edits (user and agent) with rollback. No approval-gated typed proposals. |
| D4 | No COMSOL files or derived material in the repo (superseded by DevLog-001 Q5). |
| D5 | License: GPL-3.0-or-later. |
| D6 | Solver stack: whatever fits best; MOOSE is a candidate (see section 4). |
| D7 | New repo for the sim core (this one). Monorepo for code; materials properties as a package in it (see section 5). |
| D8 | Priority: 3D RF and package. |
| D9 | First demo: synthetic package, parameters as close to real-world as possible, each value sourced. |

## 3. Evidence from existing efforts (read 2026-09-28)

Findings from a read-only survey of the user's repos. Repo names, not local paths.

- **PlayGround/20260614_2d_eo_fem_solver**: browser-first 2D EO prototype. Geometry -> Mesh -> Results layers with staleness invalidation; Gmsh field-based sizing; Gmsh runs in an isolated subprocess (global native state, OpenMP abort on re-init). MFEM solve path never built; Tidy3D and COMSOL benchmarks never run; scalar optical mode only. Top technical risk named in its DevLog-006: selection recovery by bounding box against OCC entities; needs persistent IDs from OCC fragment history.
- **agentic-multiphysics-harness**: governance kernel (typed actions, revisioned snapshots, hash-chained events, validator gating). About 6.5k source lines, about 900 of them solver. A 100-case validation backlog with per-case independent validation hooks (tiers T0 13, T1 24, T2 46, T3 17). Carries unresolved rights and release blockers, so it is not used as the base of a GPL release.
- **InP-Modulator**: 2D quasistatic EQS and MQS models (scikit-fem P2, Gmsh OCC, complex128), 55 analytic and consistency gates. No 3D, no full-wave, no thermal.
- **Other**: BPM (2D scalar, explicit RK4, dz capped near 0.1 um), 1D slab full-vector FDE and sparse 2D scalar FEM in mode_overlap, Meep/MPB pipeline (edge-coupling reproduction, blocked on port identity and provenance), MOOSE/Peacock install (about two days on macOS: Qt5/Qt6, RPATH, version pinning), OpenFOAM via Docker, Palace outputs inspected in ParaView only.
- **Recurring pain**: macOS install cost of existing tools, mode and port definition, validation and provenance costing more than solving, no vector mode solver with PML/ports, no 3D anywhere in own code.

## 4. Architecture (proposal)

The core owns: geometry, meshing, typed model spec, result format, run records, UI, CLI/API. Solvers are backends behind it. A backend is: spec-to-native-input compiler + runner + result reader.

| Layer | Choice | Notes |
|---|---|---|
| Geometry / mesh | Gmsh + OpenCASCADE | Persistent geometry IDs from OCC fragment history from day one. Layer stack + GDS-style layout extrusion as the packaging input. |
| Model spec | Typed schema (Pydantic), text-diffable | One source of truth for GUI, CLI and agent. Explicit domain/boundary/selection assignment; no overlap-order semantics. Revisioned edits with rollback (D3). |
| 3D RF backend | Palace (Apache-2.0, MFEM-based) | Driven and eigenmode EM, electro/magnetostatics, lumped and numeric wave ports, GPU support. JSON config input. |
| Thermal / mechanical / coupled | MOOSE (candidate; possibly MFEM-in-MOOSE) | HIT text input. Precedent: multichip thermal/electrical/mechanical as separate MOOSE apps. |
| Reference / light backend | scikit-fem | 2D, analytic gates, anything browser-runnable. |
| Coupling | One-way via files first (EM loss -> heat -> thermal strain -> stress) | Two-way through MOOSE MultiApps later. |
| Results | Binary/typed arrays, VTU or equivalent | Not nested JSON. |
| Frontend | Svelte 5 + TS + Vite + pnpm; canvas/WebGL viewer | Pixi proven in gdsjam; 3D field viewer (e.g. vtk.js) untested by the user. |
| Agent surface | CLI + HTTP API + MCP tools on the same API | Deterministic run records; GUI screenshot access for agents. |
| Deployment | Same UI against localhost backend or hosted API | Hosted needs job queue, quotas, sandbox (OCI containers; the harness Podman spec is a starting point, no executor exists). Local Docker is present on the dev machine; Podman is not. |

### Backend licenses (checked 2026-09-28)

| Component | License | Source of check |
|---|---|---|
| MOOSE | LGPL-2.1 | idaholab/moose repository page |
| MFEM | BSD-3-Clause | mfem/mfem repository page |
| Palace | Apache-2.0 | awslabs/palace repository page |
| Gmsh | GPL; exact linking terms not confirmed | Not confirmed; read the Gmsh license text before release |
| libMesh, PETSc | Not confirmed | Not confirmed |

Backends run as separate processes invoked through their CLIs and files, so linking terms do not propagate into the core. Redistribution of container images still carries each component's own license and notice obligations; needs a real review before any image is published. Apache-2.0 is compatible with GPLv3 (not GPLv2-only).

### Known risks

- MOOSE install cost on macOS (logged about two days). The core must ship a pinned, reproducible install (container) and report missing backends explicitly.
- MOOSE's own EM module is Helmholtz-form and is not a substitute for Palace on 3D packages. Maturity of the MFEM-based EM apps in MOOSE not verified.
- Selection/ID persistence across geometry edits (see section 3).
- Hosted mode: abuse and compute cost; needs quotas and sandboxing before any public deployment.

## 5. Repositories and data

- **Monorepo (this repo)**: core, backends, web app, CLI/API, validation harness, materials package.
- **Materials package (inside monorepo)**: text (YAML) files, one per material, each value with source citation, ISO date and uncertainty range. Units explicit. N/A where unknown.
- **Real-world test data**: separate repo or Hugging Face dataset, referenced from the monorepo by manifest and content hash. Reasons: size, third-party rights, different citation lifecycle.
- **Harness repo**: not expanded. Clean pieces (contracts, hash-chained events, validator gating) copied over deliberately after a rights check per file. No third-party-derived material without a rights check.

## 6. First vertical: synthetic advanced-package stack

Synthetic package, real-world parameter ranges, every number sourced (no invented values). Candidate scope: 2.5D interposer carrying a photonic IC and an electronic IC, with microbumps, TSVs, RDL, underfill/TIM, lid and heat sink.

Build order:

1. Geometry from layer stack + layout, stable geometry IDs.
2. Steady-state thermal: power maps, TIM layers, convective boundary. Cheapest end-to-end path; exercises spec, mesh, backend, results, UI, agent API.
3. 3D RF S-parameters via Palace: bump, TSV and RDL transitions, ports.
4. Thermo-mechanical stress and warpage.
5. Coupling: EM loss to heat; thermo-optic shift of photonic devices.
6. Validation throughout.

Validation ladder: analytic and manufactured-solution and convergence gates, then a public reference solver or published numbers. The harness 100-case backlog is a candidate benchmark spec, to be re-derived independently from open sources.

## 7. UI/UX requirements (from prior stated preferences)

- Dark by default, sharp corners everywhere (fixed per style, no global override), dense, minimal text, details in hover tooltips. Spinners exempt.
- COMSOL-style Model Builder tree, node Settings panel, Graphics tabs, Messages/Log/Progress tabs. Geometry / Mesh / Results viewer modes.
- Resizable panes, panels fit viewport with internal scroll, canvas never shifts, WIP state while solving.
- Log rows start with a timestamp.
- Hover shows x, y, value and expression. Directional drag-zoom. Single-key mode toggles.
- Instant loads with concrete targets. Missing evidence shows as unavailable, never green. No UI option the backend does not implement.
- Agent can drive the UI and backend itself and inspect screenshots.
- Not yet stated: font size and row height; 3D viewer choice.

## 8. Milestones (draft)

- M0: repo skeleton, license, DevLog process, install of Gmsh + Palace + MOOSE in containers with version pins.
- M1: spec schema v0, layer-stack geometry, persistent IDs, mesh sequence, Gmsh in subprocess.
- M2: thermal steady state end-to-end on a simple stack with an analytic gate; CLI and API; minimal Model Builder UI.
- M3: Palace backend: single transition with wave ports; analytic transmission-line gate.
- M4: synthetic package demo: thermal + RF, sourced parameters.
- M5: thermo-mechanical and one-way coupling.
- M6: hosted deployment design (queue, quotas, sandbox).

## 9. TODO

- [ ] Wentao creates the GitHub repo and hands over the URL (`git init` and remote not done here)
- [ ] Confirm Gmsh, libMesh and PETSc license terms from primary text
- [ ] Verify MFEM-based EM apps in MOOSE (maturity, license) before relying on them
- [ ] Research real-world package parameters (materials, bump/TSV/RDL dimensions, TIM conductivity, power maps) with citations for the synthetic demo
- [ ] Decide font size and row height targets; decide 3D viewer library
- [ ] Decide whether MOOSE runs as containerized backend only or also as a local install
- [ ] Re-derive validation cases independently from open sources
- [ ] Rights check per file before any copy from the harness repo
- [ ] Fresh-context audit of this scoping doc

## 10. Progress log

- 2026-09-28: Surveyed repos with five parallel read-only research agents; decisions D1-D9 recorded; backend licenses checked for MOOSE, MFEM, Palace; this document written. No code, no git init, no installs.
