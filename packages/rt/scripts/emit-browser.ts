// SPDX-License-Identifier: GPL-3.0-or-later
// Emits browser ES modules for the no-bundler demo: src/**/*.ts -> demo/lib/**/*.js using Node's built-in
// module.stripTypeScriptTypes (erasable syntax only, so stripping is exact). Relative ".ts" import
// specifiers become ".js". node-gpu.ts (Dawn, Node only) is skipped. DevLog-005 L6-7.
// Usage: node scripts/emit-browser.ts [--check]   (--check exits 1 if demo/lib is stale)
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { stripTypeScriptTypes } from "node:module";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(pkg, "src");
const out = join(pkg, "demo", "lib");
const SKIP = new Set(["node-gpu.ts"]);

function walk(d: string): string[] {
  return readdirSync(d).flatMap((n) => {
    const p = join(d, n);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") && !SKIP.has(n) ? [p] : [];
  });
}

export function emitted(): Map<string, string> {
  const m = new Map<string, string>();
  for (const f of walk(src)) {
    const rel = relative(src, f);
    const js = stripTypeScriptTypes(readFileSync(f, "utf8"), { mode: "strip" }).replace(
      /(from\s+|import\s*\(\s*)(["'])(\.{1,2}\/[^"']+)\.ts\2/g,
      "$1$2$3.js$2",
    );
    m.set(rel.replace(/\.ts$/, ".js"), `// Generated from packages/rt/src/${rel} by scripts/emit-browser.ts; do not edit.\n${js}`);
  }
  return m;
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const check = process.argv.includes("--check");
  let stale = 0;
  for (const [rel, text] of emitted()) {
    const p = join(out, rel);
    const cur = existsSync(p) ? readFileSync(p, "utf8") : null;
    if (cur === text) continue;
    stale++;
    if (check) console.error(`stale: demo/lib/${rel}`);
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, text);
      console.log(`wrote demo/lib/${rel}`);
    }
  }
  if (check && stale > 0) process.exit(1);
}
