// SPDX-License-Identifier: GPL-3.0-or-later
// Lazy page code: the shell paints first, then imports this (a failed import is retried on the next call).
let wb: Promise<typeof import('../workbench/Workbench.svelte').default> | null = null;
let play: Promise<typeof import('../play/Play.svelte').default> | null = null;
let rt: Promise<typeof import('../play/RtPanel.svelte').default> | null = null;
const retry = <T>(p: Promise<T>, reset: () => void) => p.catch((e) => { reset(); throw e; });
export const loadWorkbench = () => (wb ??= retry(import('../workbench/Workbench.svelte').then((m) => m.default), () => (wb = null)));
export const loadPlay = () => (play ??= retry(import('../play/Play.svelte').then((m) => m.default), () => (play = null)));
export const loadRt = () => (rt ??= retry(import('../play/RtPanel.svelte').then((m) => m.default), () => (rt = null)));
