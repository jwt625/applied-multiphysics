// SPDX-License-Identifier: GPL-3.0-or-later
// demo/lib must equal the type-stripped src (run `node scripts/emit-browser.ts` after editing src).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { emitted } from "../scripts/emit-browser.ts";

test("demo/lib is in sync with src", () => {
  const lib = join(dirname(fileURLToPath(import.meta.url)), "..", "demo", "lib");
  for (const [rel, text] of emitted()) {
    const p = join(lib, rel);
    assert.ok(existsSync(p), `missing demo/lib/${rel}`);
    assert.equal(readFileSync(p, "utf8"), text, `stale demo/lib/${rel}`);
  }
});
