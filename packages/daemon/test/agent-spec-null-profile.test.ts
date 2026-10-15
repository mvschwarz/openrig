// `profiles:\n  default:` (a bare key) parses to { default: null }. It validates, and used to make
// normalizeAgentSpec throw "Cannot read properties of null (reading 'uses')". A bare key is now
// normalized as an empty profile, the same as `default: {}`. Scalar and list profiles keep their
// existing handling (they validate and normalize to an empty profile).
import { describe, it, expect } from "vitest";
import { parseAgentSpec, validateAgentSpec, normalizeAgentSpec } from "../src/domain/agent-manifest.js";

const spec = (profileLines: string) => parseAgentSpec(`version: "0.2"\nname: null-profile\nprofiles:\n${profileLines}`);

describe("agent spec profile normalization", () => {
  it("normalizes a bare `default:` as an empty profile, identical to `default: {}`", () => {
    const bare = spec("  default:\n");
    expect(validateAgentSpec(bare).valid).toBe(true);
    expect(() => normalizeAgentSpec(bare)).not.toThrow();
    const normalizedBare = normalizeAgentSpec(bare);
    expect(Object.keys(normalizedBare.profiles)).toEqual(["default"]);
    expect(normalizedBare.profiles["default"]).toEqual(normalizeAgentSpec(spec("  default: {}\n")).profiles["default"]);
  });

  it("normalizes an explicitly empty profile", () => {
    const raw = spec("  default: {}\n");
    expect(validateAgentSpec(raw).valid).toBe(true);
    expect(Object.keys(normalizeAgentSpec(raw).profiles)).toEqual(["default"]);
  });

  it.each(["  default: 5\n", "  default: []\n"])("keeps the existing handling of a scalar or list profile: %s", (lines) => {
    const raw = spec(lines);
    expect(validateAgentSpec(raw).valid).toBe(true);
    expect(normalizeAgentSpec(raw).profiles["default"]).toEqual(normalizeAgentSpec(spec("  default: {}\n")).profiles["default"]);
  });

  it("still normalizes a named profile with content", () => {
    const raw = spec("  default:\n    summary: hello\n    uses:\n      skills: [a]\n");
    expect(validateAgentSpec(raw).valid).toBe(true);
    const profile = normalizeAgentSpec(raw).profiles["default"];
    expect(profile?.summary).toBe("hello");
    expect(profile?.uses.skills).toEqual(["a"]);
  });
});
