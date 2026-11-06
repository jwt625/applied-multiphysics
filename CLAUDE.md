# applied-multiphysics: agent guide

Browser-native, agent-native multiphysics simulation (GPL-3.0-or-later). Plan and decisions: `DevLog/DevLog-001-plan-poc-and-eval.md`. Interfaces between packages: `DevLog/contracts/CONTRACTS-v0.md`. Research: `DevLog/research/`.

## Layout
- `packages/*`: engine packages (`@amp/core`, `geom`, `mesh`, `spec`, `physics`, `post`, `rt`, `eval`, `agent`). Pure ES modules that run in a Web Worker and in Node.
- `apps/web`: SvelteKit static workbench + Play views.
- `eval/cases/{a,b,c}`: evaluation cases (`amp-eval/0`). `eval/expected/`: generated reference values.
- `validation/`: uv Python project with open reference solvers and generators.
- `materials/`: one YAML per material; each value has unit, basis, source, ISO date.
- `DevLog/`: `DevLog-NNN-title.md` per workstream; `lanes/`, `audits/`, `research/`, `contracts/`.

## Rules
- No emoji anywhere. ISO dates (`YYYY-MM-DD`).
- Never invent numbers. Every physical value is sourced or `N/A`; estimates are labelled.
- Write your plan into your DevLog before coding; log progress with timestamps; edit only the paths your lane owns.
- New code: TypeScript, erasable syntax only. Ported atlas code: `.mjs` + `.d.mts` with a port header (contracts C1).
- Python: `uv` only (never pip). Node: pnpm.
- No COMSOL files, runs or COMSOL-generated values (DevLog-001 Q5).
- Rights check per file before porting or citing; keep Apache-2.0 NOTICE files intact.
- Machine etiquette: `nice -n 10` for heavy runs, Node `--max-old-space-size=1536`, Python BLAS threads <= 2, one heavy process per lane. Check a port is free before binding; use uncommon ports. Logs go to `logs/` with a timestamp in the filename.
- Do not run git (the coordinator commits). Do not edit sibling repos (eo-modulator-atlas, advanced-packaging-atlas): read only.
- UI: dark by default, sharp corners, dense, minimal text with details in tooltips; plots show data only, in absolute units.
