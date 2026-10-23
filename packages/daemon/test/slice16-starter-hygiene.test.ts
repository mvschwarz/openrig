// Slice 16 (OPR.0.4.7.16) — product-team starter bootstrap hygiene.
// Starter defaults do not select the optional test-driven-development skill.
// Seat-id culture coverage lives in the CLI rig-spec audit.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const specs = fileURLToPath(new URL("../specs/", import.meta.url));

describe("Slice 16 — starter bootstrap hygiene", () => {
  it("item 3: implementer and QA defaults do not select the optional TDD skill", () => {
    for (const agent of ["implementer", "qa"]) {
      const spec = readFileSync(specs + `agents/development/${agent}/agent.yaml`, "utf8");
      expect(spec).not.toContain("test-driven-development");
    }
  });
});
