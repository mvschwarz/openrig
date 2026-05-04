import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const LTS_ENGINE = "^20 || ^22 || ^24";
const CLI_ENGINE = ">=20";

const LTS_PACKAGE_PATHS = [
  "package.json",
  "packages/daemon/package.json",
];

for (const pkgPath of LTS_PACKAGE_PATHS) {
  test(`${pkgPath} has engines.node set to LTS-only constraint`, () => {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    assert.ok(pkg.engines, `${pkgPath} is missing an "engines" field`);
    assert.ok(pkg.engines.node, `${pkgPath} is missing "engines.node"`);
    assert.equal(
      pkg.engines.node,
      LTS_ENGINE,
      `${pkgPath} engines.node should be "${LTS_ENGINE}" (even-numbered LTS only) but got "${pkg.engines.node}"`
    );
  });
}

test("published CLI allows odd Node majors to reach the postinstall ABI guard", () => {
  const pkgPath = "packages/cli/package.json";
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  assert.ok(pkg.engines, `${pkgPath} is missing an "engines" field`);
  assert.equal(
    pkg.engines.node,
    CLI_ENGINE,
    `${pkgPath} engines.node should be "${CLI_ENGINE}" so npm selects the latest package and check-abi.mjs prints the supported-Node fix`
  );
});
