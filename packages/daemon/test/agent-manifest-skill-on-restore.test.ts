import { describe, it, expect } from "vitest";
import { parseAgentSpec, validateAgentSpec, normalizeAgentSpec } from "../src/domain/agent-manifest.js";

const spec = (onRestore?: string) => parseAgentSpec(`
name: team
version: "1.0"
resources:
  skills:
    - id: house-style
      path: skills/house-style
${onRestore === undefined ? "" : `      on_restore: ${onRestore}\n`}`);

describe("a skill resource's on_restore says whether a restored seat keeps its saved copy or follows the source", () => {
  it("keeps the saved copy unless the skill says otherwise", () => {
    const raw = spec();
    expect(validateAgentSpec(raw).errors).toEqual([]);
    expect(normalizeAgentSpec(raw).resources.skills).toEqual([{ id: "house-style", path: "skills/house-style", onRestore: "keep_saved" }]);
  });

  it("accepts follow_source and keep_saved", () => {
    for (const value of ["follow_source", "keep_saved"]) {
      const raw = spec(value);
      expect(validateAgentSpec(raw).errors).toEqual([]);
      expect(normalizeAgentSpec(raw).resources.skills[0]!.onRestore).toBe(value);
    }
  });

  it("rejects any other value, naming the entry", () => {
    const result = validateAgentSpec(spec("refresh"));
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(`resources.skills[0].on_restore: must be "keep_saved" | "follow_source" (got "refresh")`);
  });
});
