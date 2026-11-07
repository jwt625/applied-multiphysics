// SPDX-License-Identifier: GPL-3.0-or-later
import { preloadFor } from '../../../lib/shell/preload.server';
import { SIM_IDS } from '../../../lib/sims';
export const entries = () => SIM_IDS.map((sim) => ({ sim }));
export const load = ({ params }: { params: { sim: string } }) => ({ sim: params.sim, preload: preloadFor('src/lib/play/Play.svelte') });
