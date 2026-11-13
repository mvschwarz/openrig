// Tier 1 schema/normalization/codec proof for #2829 slice 1: the `cold_start`
// opt-in on pod and member. validate accepts booleans and rejects anything else
// (and still rejects unknown keys, so a typo like `coldstart` can't silently
// disable the feature); normalize carries the flag; serialize round-trips it.
import { describe, it, expect } from "vitest";
import { RigSpecSchema } from "../src/domain/rigspec-schema.js";
import { RigSpecCodec } from "../src/domain/rigspec-codec.js";

function rigWithMember(memberOverrides: Record<string, unknown>, podOverrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: "0.2",
    name: "cold-start-test-rig",
    pods: [
      {
        id: "dev",
        label: "Dev",
        ...podOverrides,
        members: [
          {
            id: "impl",
            agent_ref: "local:agents/impl",
            profile: "default",
            runtime: "pi",
            cwd: ".",
            ...memberOverrides,
          },
        ],
        edges: [],
      },
    ],
    edges: [],
  };
}

describe("RigSpec cold_start schema (#2829 slice 1)", () => {
  // === Acceptance ===

  it("accepts member cold_start: true", () => {
    const result = RigSpecSchema.validate(rigWithMember({ cold_start: true }));
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("accepts member cold_start: false (explicit opt-out)", () => {
    const result = RigSpecSchema.validate(rigWithMember({ cold_start: false }));
    expect(result.valid).toBe(true);
  });

  it("accepts pod-level cold_start: true", () => {
    const result = RigSpecSchema.validate(rigWithMember({}, { cold_start: true }));
    expect(result.valid).toBe(true);
  });

  it("rejects non-boolean member cold_start", () => {
    const result = RigSpecSchema.validate(rigWithMember({ cold_start: "yes" }));
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("pods[0].members[0].cold_start: must be a boolean");
  });

  it("rejects non-boolean pod cold_start", () => {
    const result = RigSpecSchema.validate(rigWithMember({}, { cold_start: 1 }));
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("pods[0].cold_start: must be a boolean");
  });

  it("still rejects an unknown key (coldstart typo is not silently dropped)", () => {
    const result = RigSpecSchema.validate(rigWithMember({ coldstart: true }));
    expect(result.valid).toBe(false);
    expect(result.errors.some(err => err.includes('unknown key "coldstart"'))).toBe(true);
  });

  it("keeps a spec without cold_start valid (default off, no behavior change)", () => {
    const result = RigSpecSchema.validate(rigWithMember({}));
    expect(result.valid).toBe(true);
  });

  // === Normalization ===

  it("normalize carries member coldStart", () => {
    const normalized = RigSpecSchema.normalize(rigWithMember({ cold_start: true }) as Record<string, unknown>);
    expect(normalized.pods[0]!.members[0]!.coldStart).toBe(true);
  });

  it("normalize leaves member coldStart undefined when absent", () => {
    const normalized = RigSpecSchema.normalize(rigWithMember({}) as Record<string, unknown>);
    expect(normalized.pods[0]!.members[0]!.coldStart).toBeUndefined();
  });

  it("normalize carries pod coldStart", () => {
    const normalized = RigSpecSchema.normalize(rigWithMember({}, { cold_start: true }) as Record<string, unknown>);
    expect(normalized.pods[0]!.coldStart).toBe(true);
  });

  // === Codec round-trip ===

  it("serialize round-trips member cold_start", () => {
    const normalized = RigSpecSchema.normalize(rigWithMember({ cold_start: true }) as Record<string, unknown>);
    const yaml = RigSpecCodec.serialize(normalized);
    const reparsed = RigSpecSchema.normalize(RigSpecCodec.parse(yaml) as Record<string, unknown>);
    expect(reparsed.pods[0]!.members[0]!.coldStart).toBe(true);
  });

  it("serialize round-trips pod cold_start", () => {
    const normalized = RigSpecSchema.normalize(rigWithMember({}, { cold_start: false }) as Record<string, unknown>);
    const yaml = RigSpecCodec.serialize(normalized);
    const reparsed = RigSpecSchema.normalize(RigSpecCodec.parse(yaml) as Record<string, unknown>);
    expect(reparsed.pods[0]!.coldStart).toBe(false);
  });
});
