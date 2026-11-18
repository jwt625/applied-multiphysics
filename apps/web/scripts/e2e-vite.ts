// SPDX-License-Identifier: GPL-3.0-or-later
// Dev server for the e2e smoke (lane T1, DevLog-038): `vite dev` with this app's vite.config.ts and HMR switched off,
// so edits made by other lanes during a run do not reload the page under test; the file watcher still invalidates
// changed modules, so every new page load gets the current code. The `dev` argument keeps vite.config.ts on its dev
// branch (no service worker registration). Started by scripts/e2e-smoke.ts.
// Usage: node scripts/e2e-vite.ts dev --port <n>
import { createServer } from 'vite';

const i = process.argv.indexOf('--port');
const port = Number(i >= 0 ? process.argv[i + 1] : NaN);
if (!Number.isInteger(port) || port <= 0) { console.error('usage: node scripts/e2e-vite.ts dev --port <n>'); process.exit(2); }
const root = new URL('..', import.meta.url).pathname;
const server = await createServer({ root, configFile: `${root}vite.config.ts`, server: { port, strictPort: true, host: '127.0.0.1', hmr: false }, clearScreen: false });
await server.listen();
console.log(`e2e-vite ready http://127.0.0.1:${port}/`);
const stop = () => { void server.close().finally(() => process.exit(0)); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
