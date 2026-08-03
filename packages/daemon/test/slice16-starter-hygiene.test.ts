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
  it("item 1 (OPR.0.4.8.2 agnostic rip-out): fragment keeps ONLY the acceptEdits floor — no allow/ask/deny", () => {
    const frag = JSON.parse(readFileSync(specs + "agents/shared/runtime/claude-settings.fragment.json", "utf8"));
    // The 13-entry allow-list (assessment C1b) and the rig up/down ask gates (C1c) are RIPPED —
    // OpenRig no longer bakes any config-file permission policy. The floor (acceptEdits) stays.
    expect(frag.permissions.defaultMode).toBe("acceptEdits");
    expect(frag.permissions.allow).toBeUndefined();
    expect(frag.permissions.ask).toBeUndefined();
    expect(frag.permissions.deny).toBeUndefined();
  });

  it("item 3: the QA agent carries the test-driven-development skill it enforces", () => {
    const qa = readFileSync(specs + "agents/development/qa/agent.yaml", "utf8");
    // present in the skills array (not merely anywhere in the file)
    expect(qa).toMatch(/skills:\s*\[[^\]]*test-driven-development/);
  });
});
