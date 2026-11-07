// SPDX-License-Identifier: GPL-3.0-or-later
// Static SvelteKit build for Cloudflare Pages (DevLog-001 A13, DevLog-011 s.1.2). Pattern: eo-modulator-atlas DevLog-046.
import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../..', import.meta.url));
// @amp/physics prepareRun loads materials through @amp/materials/node (fs); in the browser the same documents come from
// import.meta.glob (src/lib/engine/materials-node-shim.ts)
const materialsShim = fileURLToPath(new URL('./src/lib/engine/materials-node-shim.ts', import.meta.url));

export default defineConfig({
	plugins: [
		sveltekit({
			adapter: adapter({ pages: 'build', assets: 'build', fallback: undefined, precompress: false, strict: true }),
			paths: { relative: false },
			prerender: { handleHttpError: 'fail' },
			// Content-Security-Policy (audit S10, before the BYO-key agent panel): hashes for the inline bootstrap script;
			// connect-src limited to this origin and the LLM provider (DevLog-012 s.6.1 item 7); WASM compile allowed for the opt-in
			// solvers and meshers ('wasm-unsafe-eval' permits WebAssembly compilation only, not eval)
			csp: {
				mode: 'hash',
				directives: {
					'default-src': ['self'],
					'script-src': ['self', 'wasm-unsafe-eval'],
					'style-src': ['self', 'unsafe-inline'],
					'img-src': ['self', 'data:', 'blob:'],
					'connect-src': ['self', 'https://api.anthropic.com'],
					'worker-src': ['self'],
					'font-src': ['self'],
					'object-src': ['none'],
					'base-uri': ['self'],
					'form-action': ['none']
				}
			},
			// CSS in the HTML: first paint needs no second request
			inlineStyleThreshold: 64 * 1024,
			// no service worker on the dev server: it would cache code under development
			...(process.argv.includes('dev') ? { serviceWorker: { register: false } } : {})
		})
	],
	// sims/*.yaml and the engine packages live outside the app
	server: { fs: { allow: [repo] }, headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' } },
	preview: { headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' } },
	resolve: { alias: [{ find: /^@amp\/materials\/node$/, replacement: materialsShim }] },
	worker: { format: 'es' },
	build: { target: 'es2023', chunkSizeWarningLimit: 1200, manifest: true }
});
