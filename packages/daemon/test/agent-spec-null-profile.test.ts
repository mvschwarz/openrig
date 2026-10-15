// `profiles:\n  default:` (a bare key) parses to { default: null }. validateAgentSpec accepted
// it, then normalizeAgentSpec threw "Cannot read properties of null (reading 'uses')".
import { describe, it, expect } from "vitest";
import { parseAgentSpec, validateAgentSpec, normalizeAgentSpec } from "../src/domain/agent-manifest.js";

const spec = (profileLines: string) => parseAgentSpec(`version: "0.2"\nname: null-profile\nprofiles:\n${profileLines}`);

describe("agent spec profile entries must be maps", () => {
  it("rejects a bare `default:` instead of validating and then crashing normalize", () => {
    const raw = spec("  default:\n");
    const result = validateAgentSpec(raw);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("profiles.default: must be a map (an empty profile is {})");
  });

  it.each(["  default: 5\n", "  default: []\n", "  default: plain\n"])("rejects a non-map profile: %s", (lines) => {
    const result = validateAgentSpec(spec(lines));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.startsWith("profiles.default: must be a map"))).toBe(true);
  });

  it("still accepts an explicitly empty profile and normalizes it", () => {
    const raw = spec("  default: {}\n");
    expect(validateAgentSpec(raw).valid).toBe(true);
    expect(() => normalizeAgentSpec(raw)).not.toThrow();
    expect(Object.keys(normalizeAgentSpec(raw).profiles)).toEqual(["default"]);
  });
});
