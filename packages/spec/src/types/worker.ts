// SPDX-License-Identifier: GPL-3.0-or-later
// C6 worker protocol (CONTRACTS-v0). Every message carries ts as an ISO string.

import type { Solution } from './solution.ts';

export type ToWorker =
  | { type: 'run'; id: string; specText: string; options?: Record<string, unknown>; ts: string }
  | { type: 'cancel'; id: string; ts: string };

export type FromWorker =
  | { type: 'progress'; id: string; stage: string; frac: number; msg?: string; ts: string }
  | { type: 'result'; id: string; solution: Solution; ts: string }
  | { type: 'error'; id: string; message: string; stage?: string; ts: string };
