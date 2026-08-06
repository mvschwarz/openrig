import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// P9 — repo build-order encoding. The cli tsc resolves `@openrig/daemon/crash-cart` via the daemon's
// BUILT dist .d.ts (packaging ruling A + the paths mapping). So the typecheck-all path must build the
// daemon dist BEFORE it runs the cli tsc — else a clean checkout fails cli tsc with TS2307. This guard
// pins that ordering in the repo (self-carrying, not only desk-side).

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

test("lint builds the daemon dist BEFORE the cli tsc", () => {
  const lint = pkg.scripts.lint;
  const prepAt = lint.indexOf("typecheck:prep");
  const cliTscAt = lint.indexOf("packages/cli/tsconfig");
  assert.ok(prepAt >= 0, "lint must build the daemon dist (typecheck:prep) first");
  assert.ok(cliTscAt >= 0, "lint must typecheck the cli");
  assert.ok(prepAt < cliTscAt, "the daemon-dist build must precede the cli tsc (clean-checkout safety)");
});

test("typecheck:prep builds the daemon (emitting the dist the cli tsc consumes)", () => {
  assert.match(pkg.scripts["typecheck:prep"], /build\b.*packages\/daemon|build -w packages\/daemon/);
});
