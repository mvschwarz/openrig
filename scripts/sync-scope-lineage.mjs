// OPR.0.5.0.18 — sync the CANONICAL attestation-lineage derivation into the daemon's
// generated mirror (the repo's mirror/codegen convention: the CLI→daemon import
// direction is barred, so the body crosses the package boundary by generation).
//
//   node scripts/sync-scope-lineage.mjs           # (re)write the generated mirror
//   node scripts/sync-scope-lineage.mjs --check   # exit 1 on drift, write nothing
//
// Canonical:  packages/cli/src/lib/scope/attestation-lineage.ts   (EDIT THIS ONE)
// Generated:  packages/daemon/src/domain/scope/attestation-lineage.generated.ts
//
// The vitest-level scope-lineage-parity pin enforces the same invariant on every
// test run; this script is the WRITE path (and the CI-style --check).

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = process.env.SYNC_LINEAGE_ROOT
  ? resolve(process.env.SYNC_LINEAGE_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const CANONICAL = "packages/cli/src/lib/scope/attestation-lineage.ts";
export const GENERATED = "packages/daemon/src/domain/scope/attestation-lineage.generated.ts";

const HEADER = `// GENERATED FILE — DO NOT EDIT.
// Emitted by scripts/sync-scope-lineage.mjs from the canonical source:
//   ${CANONICAL}
// Edit the canonical file, then run: node scripts/sync-scope-lineage.mjs
// The scope-lineage-parity vitest pin fails if this mirror drifts.

`;

export function renderGenerated(canonicalContent) {
  return HEADER + canonicalContent;
}

function main() {
  const check = process.argv.includes("--check");
  const canonicalPath = join(REPO_ROOT, CANONICAL);
  const generatedPath = join(REPO_ROOT, GENERATED);

  const canonical = readFileSync(canonicalPath, "utf8");
  const expected = renderGenerated(canonical);

  if (check) {
    const actual = existsSync(generatedPath) ? readFileSync(generatedPath, "utf8") : null;
    if (actual !== expected) {
      console.error(
        `DRIFT: ${GENERATED} does not match the canonical derivation.\n` +
          `Re-run: node scripts/sync-scope-lineage.mjs`,
      );
      process.exit(1);
    }
    console.log("sync-scope-lineage: in sync.");
    return;
  }

  mkdirSync(dirname(generatedPath), { recursive: true });
  writeFileSync(generatedPath, expected, "utf8");
  console.log(`sync-scope-lineage: wrote ${GENERATED}`);
}

main();
