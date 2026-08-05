// OPR.0.5.0.18 — CROSS-SURFACE PARITY PIN (guard-carried requirement; extraction landed).
//
// The amendment-lineage derivation now has ONE canonical source:
//   packages/cli/src/lib/scope/attestation-lineage.ts        (canonical, hand-edited)
//   packages/daemon/src/domain/scope/attestation-lineage.generated.ts
//     (GENERATED verbatim-body mirror — emitted by scripts/sync-scope-lineage.mjs;
//      the cli→daemon import direction is barred, so the repo's mirror/codegen
//      convention carries the body across the package boundary)
//
// This pin holds the whole chain: canonical == generated (function body byte-wise),
// AND both consuming surfaces import their package-local module rather than carrying
// a private copy — so a mutation of the canonical fn changes BOTH surfaces together
// (run `node scripts/sync-scope-lineage.mjs`), and the old silent-drift class is
// structurally dead. If generated drifts (hand-edit without the sync), this fails.
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

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", ".."); // packages/daemon/test -> repo root

it("canonical and generated attestationLineage bodies are byte-identical (the sync carried them)", () => {
  const canonical = readFileSync(join(root, "packages/cli/src/lib/scope/attestation-lineage.ts"), "utf8");
  const generated = readFileSync(join(root, "packages/daemon/src/domain/scope/attestation-lineage.generated.ts"), "utf8");

  const canonicalFn = extractAttestationLineage(canonical);
  const generatedFn = extractAttestationLineage(generated);
  expect(canonicalFn.length, "canonical attestationLineage not found").toBeGreaterThan(0);
  expect(generatedFn.length, "generated attestationLineage not found").toBeGreaterThan(0);
  expect(generatedFn).toBe(canonicalFn);

  // The generated file must declare its provenance loudly (the repo's generated-file rule).
  expect(generated).toMatch(/GENERATED[\s\S]*DO NOT EDIT/i);
  expect(generated).toContain("scripts/sync-scope-lineage.mjs");
});

it("both surfaces CONSUME the shared derivation — no private builder copies remain", () => {
  const cliSurface = readFileSync(join(root, "packages/cli/src/commands/scope.ts"), "utf8");
  const daemonSurface = readFileSync(join(root, "packages/daemon/src/routes/scope-audit.ts"), "utf8");

  // Neither surface defines its own copy any more…
  expect(cliSurface).not.toContain("function attestationLineage(");
  expect(daemonSurface).not.toContain("function attestationLineage(");
  // …both import their package-local module.
  expect(cliSurface).toMatch(/from "\.\.\/lib\/scope\/attestation-lineage\.js"/);
  expect(daemonSurface).toMatch(/from "\.\.\/domain\/scope\/attestation-lineage\.generated\.js"/);
});

it("the shared derivation behaves identically through BOTH package-local modules (behavioral belt)", async () => {
  const cli = await import(join(root, "packages/cli/src/lib/scope/attestation-lineage.ts"));
  const daemon = await import(join(root, "packages/daemon/src/domain/scope/attestation-lineage.generated.ts"));
  const fixtures = [
    null,
    "id: X",
    "approved-spec-by: a@r\napproved-spec-at: t1\napproved-spec-priors: 2",
    "approved-by: b@r\napproved-at: t2\napproved-priors: 1\napproved-spec-by: a@r\napproved-spec-at: t1\napproved-spec-priors: 3",
    "approved-spec-by: a@r\napproved-spec-at: t1\napproved-spec-priors: 0",
    'approved-spec-by: "q@r"\napproved-spec-at: t\napproved-spec-priors: not-a-number',
  ];
  for (const fm of fixtures) {
    expect(daemon.attestationLineage(fm)).toEqual(cli.attestationLineage(fm));
  }
});
