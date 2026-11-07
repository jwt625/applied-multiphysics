// SPDX-License-Identifier: GPL-3.0-or-later
// Stand-alone build of the TSL probe page (not part of the app): `vite build -c test/tsl-probe/vite.config.ts`.
import { defineConfig } from 'vite';
export default defineConfig({ root: import.meta.dirname, logLevel: 'warn', build: { outDir: process.env.TSL_OUT ?? 'dist', emptyOutDir: true, target: 'es2023' } });
