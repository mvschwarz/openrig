// Slice 16 (OPR.0.4.7.16) — product-team starter bootstrap hygiene.
// Content assertions on the SHIPPED starter source so the flagship rig works
// out of the box: (1) the claude-settings fragment carries the dev toolchain a
// TDD factory needs while rig up/down stays gated; (3) the QA agent carries the
// test-driven-development skill it enforces. (Item 2, culture seat-id staleness,
// is covered by the rig-spec-audit test in packages/cli/test/rig.test.ts.)
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const specs = fileURLToPath(new URL("../specs/", import.meta.url));

describe("Slice 16 — starter bootstrap hygiene", () => {
  it("item 1: shipped claude-settings fragment allows the dev toolchain; rig up/down stays gated", () => {
    const frag = JSON.parse(readFileSync(specs + "agents/shared/runtime/claude-settings.fragment.json", "utf8"));
    const allow: string[] = frag.permissions.allow;
    // acceptEdits + the toolchain a TDD factory needs (git / npm test / tsc / node) + edit tools
    expect(frag.permissions.defaultMode).toBe("acceptEdits");
    for (const perm of ["Bash(rig:*)", "Bash(git:*)", "Bash(npm:*)", "Bash(node:*)", "Bash(tsc:*)", "Read", "Edit", "Write"]) {
      expect(allow).toContain(perm);
    }
    // rig up/down remain behind the ask gate — NOT auto-allowed
    expect(frag.permissions.ask).toContain("Bash(rig up:*)");
    expect(frag.permissions.ask).toContain("Bash(rig down:*)");
    expect(allow).not.toContain("Bash(rig up:*)");
    expect(allow).not.toContain("Bash(rig down:*)");
  });

  it("item 3: the QA agent carries the test-driven-development skill it enforces", () => {
    const qa = readFileSync(specs + "agents/development/qa/agent.yaml", "utf8");
    // present in the skills array (not merely anywhere in the file)
    expect(qa).toMatch(/skills:\s*\[[^\]]*test-driven-development/);
  });
});
