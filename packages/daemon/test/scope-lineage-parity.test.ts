// OPR.0.5.0.18 — CROSS-SURFACE PARITY PIN (guard-carried requirement).
//
// The CLI (`packages/cli/src/commands/scope.ts`) and the daemon audit route
// (`packages/daemon/src/routes/scope-audit.ts`) each carry a `attestationLineage`
// builder that reads the amendment lineage (current attestation + prior-count) from a
// spec's frontmatter. They are DUPLICATED and byte-identical today — but were UNPINNED,
// so a fix to one surface could silently drift from the other. This pin fails loudly the
// moment the two builders diverge, until the durable fix (extract to ONE shared builder)
// lands. It is TEST-ONLY: no production change, no extraction this cycle.
import { it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/** Extract the `attestationLineage(...)` function source (signature through its matching
 *  closing brace) via brace matching — robust to the nested for/if blocks inside it. */
function extractAttestationLineage(src: string): string {
  const start = src.indexOf("function attestationLineage(");
  if (start < 0) return "";
  const open = src.indexOf("{", start);
  if (open < 0) return "";
  let depth = 0;
  let i = open;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) { i++; break; }
    }
  }
  return src.slice(start, i).replace(/\r\n/g, "\n").trim();
}

it("the CLI and daemon attestationLineage builders stay byte-identical (drift pin)", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = join(here, "..", "..", ".."); // packages/daemon/test -> repo root
  const cliSrc = readFileSync(join(root, "packages/cli/src/commands/scope.ts"), "utf8");
  const daemonSrc = readFileSync(join(root, "packages/daemon/src/routes/scope-audit.ts"), "utf8");

  const cliFn = extractAttestationLineage(cliSrc);
  const daemonFn = extractAttestationLineage(daemonSrc);

  // Both builders must be present…
  expect(cliFn.length, "CLI attestationLineage not found").toBeGreaterThan(0);
  expect(daemonFn.length, "daemon attestationLineage not found").toBeGreaterThan(0);
  // …and byte-identical. If this fails, one surface changed without the other — reconcile
  // them (or extract to a single shared builder, which is the durable fix).
  expect(daemonFn).toBe(cliFn);
});
