// SPDX-License-Identifier: GPL-3.0-or-later
// Test and agent-debug hooks on `window` (`__ampWorkbench`, `__ampPlay`) exist only in dev servers and in builds made
// with AMP_HOOKS=1 (verification runs); production builds have none (audit S10).
export const HOOKS: boolean = import.meta.env.DEV || import.meta.env.VITE_AMP_HOOKS === '1';
