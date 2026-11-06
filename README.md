# applied-multiphysics

Open-source (GPL-3.0-or-later), browser-native, agent-native multiphysics simulation. Heat, solid mechanics, electromagnetics, wave optics, acoustics, fluids and their couplings run client-side in Web Workers and on WebGPU. Results are visualized interactively, and every edit (by a human or an AI agent) is an inspectable, reversible operation on a typed model spec.

## Current state (2026-11-06)

- Planning done: `DevLog/DevLog-001-plan-poc-and-eval.md` (decisions, guidelines, lanes, milestones).
- Interfaces: `DevLog/contracts/CONTRACTS-v0.md`.
- Wave 1 lanes started: core extraction, spec and operation log, geometry and meshing, real-time GPU kernels, evaluation set (classes a, b, c), and the evaluation harness.

## License

GPL-3.0-or-later (`LICENSE`). Some algorithms are adapted from Apache-2.0 sources; see the `NOTICE` files in each package.
