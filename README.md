# applied-multiphysics

Open-source (GPL-3.0-or-later), browser-native, agent-native multiphysics simulation. Heat, solid mechanics, electromagnetics, wave optics, acoustics and real-time GPU fluids/waves run client-side, in Web Workers and on WebGPU. Results are visualized interactively. Every edit, by a human or an AI agent, is an inspectable, reversible operation on a typed model spec.

## Current state (2026-11-06)

- **Plan, decisions, status:** `DevLog/DevLog-001-plan-poc-and-eval.md`. Interfaces: `DevLog/contracts/CONTRACTS-v0.md` and its changelog.
- **Engine** (`packages/`):
  - `core`: sparse direct with a WASM SIMD front kernel, multigrid, Krylov, AMG/AMS, Arnoldi, FEM spaces, deterministic math.
  - `geom`, `mesh`: 2D CSG with persistent entity IDs, CDT, structured / prism / curved tet10 meshers, nested refinement; meshes are bit-identical in Node and Chrome.
  - `spec`: the `amp-spec/0` schema and the hash-chained operation log `amp-oplog/1`, with undo / redo / revert.
  - `physics`: heat, elasticity, electro- and magnetostatics, vector modes, 3D and axisymmetric Maxwell eigen, acoustics.
  - `post`; `materials` (13 sourced materials).
  - `rt`: WebGPU LBM, FDTD and Gray-Scott, with CPU references.
  - `eval`: the harness.
  - `agent`: tool API, memory, bring-your-own-key Anthropic adapter.
- **Evaluation set** (`eval/`): 85 cases in three classes: (a) analytic, (b) papers, (c) other solvers and datasets. Generated references live in `validation/` (a uv project).
- **Heroes H1-H6** pass their eval gates on the real engine through the harness, and run in under 5 s cold end to end in Node. Class a: 11 pass, 0 fail, 18 pending (non-hero).
- **Web app** (`apps/web`): workbench, Play view per hero, real-time GPU panels, operation timeline, agent chat panel. Mock provider only so far; no live model run yet.
- **Live:** https://outside5sigma.com/applied-multiphysics/ (Cloudflare Pages behind a route Worker; `deploy/`, DevLog-017).
- **Not yet:** heroes H7-H13 (fluids NS, photonic crystal bands, coupled microheater).

## Run

```
pnpm install
pnpm test
node packages/eval/src/cli.ts --class a
cd apps/web && pnpm dev --port <free port>
```

## License

GPL-3.0-or-later (`LICENSE`). Some algorithms are adapted from Apache-2.0 sources, and the WASM meshers carry their own licences; see the `NOTICE` and `THIRD_PARTY_NOTICES.md` files in each package.
