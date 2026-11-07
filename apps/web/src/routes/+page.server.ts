// SPDX-License-Identifier: GPL-3.0-or-later
import { preloadFor } from '../lib/shell/preload.server';
export const load = () => ({ preload: preloadFor('src/lib/workbench/Workbench.svelte') });
