// PL-016 Item 4 — session_source: mode: agent_image schema +
// normalization tests.
//
// Pins:
//   - validateRigSpec accepts mode: agent_image with image_name kind
//   - rejects malformed (missing value, wrong kind)
//   - rejects mode: agent_image on terminal runtime (parallel to fork/rebuild)
//   - normalize round-trips the typed shape
//   - back-compat: existing fork + rebuild modes still parse cleanly

import { describe, it, expect } from "vitest";
import { RigSpecSchema } from "../src/domain/rigspec-schema.js";

const baseRig = {
  format: "pod_aware",
  version: "0.2",
  name: "test-rig",
  pods: [{
    id: "dev",
    label: "Dev pod",
    members: [{
      id: "impl",
      agent_ref: "local:agents/impl",
      profile: "default",
      runtime: "claude-code",
      cwd: "/tmp",
      session_source: {
        mode: "agent_image",
        ref: {
          kind: "image_name",
          value: "driver-release-primed",
        },
      },
    }],
    edges: [],
  }],
  edges: [],
};

describe("RigSpec validation — session_source: mode: agent_image (PL-016 Item 4)", () => {
  it("accepts well-formed agent_image session source", () => {
    const result = RigSpecSchema.validate(baseRig);
    expect(result.valid).toBe(true);
  });

  it("rejects mode: agent_image with missing ref.value", () => {
    const broken = {
      ...baseRig,
      pods: [{
        ...baseRig.pods[0],
        members: [{
          ...baseRig.pods[0]!.members[0]!,
          session_source: { mode: "agent_image", ref: { kind: "image_name" } },
        }],
      }],
    };
    const result = RigSpecSchema.validate(broken);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("ref.value"))).toBe(true);
  });

  it("rejects mode: agent_image with non-image_name ref.kind", () => {
    const broken = {
      ...baseRig,
      pods: [{
        ...baseRig.pods[0],
        members: [{
          ...baseRig.pods[0]!.members[0]!,
          session_source: { mode: "agent_image", ref: { kind: "image_id", value: "x" } },
        }],
      }],
    };
    const result = RigSpecSchema.validate(broken);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("image_name"))).toBe(true);
  });

  it("rejects mode: agent_image on terminal runtime (parallel to fork rejection)", () => {
    const broken = {
      ...baseRig,
      pods: [{
        ...baseRig.pods[0],
        members: [{
          ...baseRig.pods[0]!.members[0]!,
          runtime: "terminal",
        }],
      }],
    };
    const result = RigSpecSchema.validate(broken);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("terminal"))).toBe(true);
  });

  it("normalize round-trips the typed shape", () => {
    const normalized = RigSpecSchema.normalize(baseRig as Record<string, unknown>);
    const member = normalized.pods[0]!.members[0]!;
    expect(member.sessionSource).toEqual({
      mode: "agent_image",
      ref: {
        kind: "image_name",
        value: "driver-release-primed",
      },
    });
  });

  it("normalize accepts optional version coerced to string", () => {
    const withVersion = {
      ...baseRig,
      pods: [{
        ...baseRig.pods[0],
        members: [{
          ...baseRig.pods[0]!.members[0]!,
          session_source: {
            mode: "agent_image",
            ref: { kind: "image_name", value: "p", version: 2 },
          },
        }],
      }],
    };
    const normalized = RigSpecSchema.normalize(withVersion as Record<string, unknown>);
    const member = normalized.pods[0]!.members[0]!;
    expect(member.sessionSource).toMatchObject({
      mode: "agent_image",
      ref: { kind: "image_name", value: "p", version: "2" },
    });
  });

  it("back-compat: existing mode: fork still parses", () => {
    const forkRig = {
      ...baseRig,
      pods: [{
        ...baseRig.pods[0],
        members: [{
          ...baseRig.pods[0]!.members[0]!,
          session_source: { mode: "fork", ref: { kind: "native_id", value: "abc" } },
        }],
      }],
    };
    const result = RigSpecSchema.validate(forkRig);
    expect(result.valid).toBe(true);
  });
});
