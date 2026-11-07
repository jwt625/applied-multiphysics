// SPDX-License-Identifier: GPL-3.0-or-later
import { preloadFor } from '../../../../lib/shell/preload.server';
import { RT_KERNELS } from '../../../../lib/play/rt-kernels';
export const entries = () => RT_KERNELS.map((kernel) => ({ kernel }));
export const load = ({ params }: { params: { kernel: string } }) => ({ kernel: params.kernel, preload: preloadFor('src/lib/play/RtPanel.svelte') });
