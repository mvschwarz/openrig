import { describe, it, expect } from "vitest";
import { RigSpecSchema } from "../src/domain/rigspec-schema.js";

describe("RigSpec docs field", () => {
  function minimalSpec(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      version: "0.2",
      name: "test-rig",
      pods: [
        {
          id: "dev",
          label: "Development",
          members: [
            { id: "impl", agent_ref: "builtin:terminal", profile: "none", runtime: "terminal", cwd: "." },
          ],
          edges: [],
        },
      ],
      edges: [],
      ...overrides,
    };
  }

  it("accepts a spec with no docs field", () => {
    const result = RigSpecSchema.validate(minimalSpec());
    expect(result.valid).toBe(true);
  });

  it("accepts a spec with valid docs array", () => {
    const result = RigSpecSchema.validate(minimalSpec({
      docs: [{ path: "SETUP.md" }, { path: "README.md" }],
    }));
    expect(result.valid).toBe(true);
  });

  it("rejects docs that is not an array", () => {
    const result = RigSpecSchema.validate(minimalSpec({ docs: "SETUP.md" }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("docs: must be an array"))).toBe(true);
  });

  it("rejects doc entry without path", () => {
    const result = RigSpecSchema.validate(minimalSpec({ docs: [{}] }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("docs[0].path: required"))).toBe(true);
  });

  it("rejects doc entry with path traversal", () => {
    const result = RigSpecSchema.validate(minimalSpec({ docs: [{ path: "../../../etc/passwd" }] }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("path traversal"))).toBe(true);
  });

  it("normalizes docs into typed array", () => {
    const spec = RigSpecSchema.normalize(minimalSpec({
      docs: [{ path: "SETUP.md" }, { path: "README.md" }],
    }));
    expect(spec.docs).toEqual([{ path: "SETUP.md" }, { path: "README.md" }]);
  });

  it("normalizes to undefined when no docs field present", () => {
    const spec = RigSpecSchema.normalize(minimalSpec());
    expect(spec.docs).toBeUndefined();
  });
});
