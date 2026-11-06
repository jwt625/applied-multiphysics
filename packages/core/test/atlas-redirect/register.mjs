// SPDX-License-Identifier: GPL-3.0-or-later
// Usage (from the atlas engine directory, read only):
//   AMP_EO_ATLAS=<eo>/engine node --import <core>/test/atlas-redirect/register.mjs --test tests/<file>.test.mjs
//   AMP_APA_ATLAS=<apa>/engine ... (either or both)
import { register } from 'node:module';
import { fileURLToPath } from 'node:url';

const core = fileURLToPath(new URL('../../src', import.meta.url));
register('./hooks.mjs', import.meta.url, { data: { eo: process.env.AMP_EO_ATLAS ?? null, apa: process.env.AMP_APA_ATLAS ?? null, core } });
