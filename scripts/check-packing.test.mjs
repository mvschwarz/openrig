import { execSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";

test("npm pack of @openrig/cli includes scripts/check-abi.mjs in tarball", () => {
  const output = execSync("npm pack --dry-run --json 2>/dev/null", {
    cwd: "packages/cli",
    encoding: "utf-8",
  });
  const entries = JSON.parse(output);
  const files = entries[0]?.files?.map((f) => f.path) ?? [];

  assert.ok(
    files.some((f) => f.includes("scripts/check-abi.mjs")),
    `scripts/check-abi.mjs missing from npm pack output. Published tarball will fail postinstall.\nFiles found: ${files.filter((f) => f.includes("scripts")).join(", ") || "(none under scripts/)"}`
  );
});
