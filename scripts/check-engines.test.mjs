import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const EXPECTED_ENGINE = "^20 || ^22 || ^24";

const PACKAGE_PATHS = [
  "package.json",
  "packages/cli/package.json",
  "packages/daemon/package.json",
];

for (const pkgPath of PACKAGE_PATHS) {
  test(`${pkgPath} has engines.node set to LTS-only constraint`, () => {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    assert.ok(pkg.engines, `${pkgPath} is missing an "engines" field`);
    assert.ok(pkg.engines.node, `${pkgPath} is missing "engines.node"`);
    assert.equal(
      pkg.engines.node,
      EXPECTED_ENGINE,
      `${pkgPath} engines.node should be "${EXPECTED_ENGINE}" (even-numbered LTS only) but got "${pkg.engines.node}"`
    );
  });
}
