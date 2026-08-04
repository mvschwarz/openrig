// Slice-03 (OPR.0.4.8.3) Seam B — RED pins for the permission_policy REF resolver:
// validate/classify (builtin vs custom vs reserved vs invalid), the flag-surface launch-posture
// resolution (README v4 d65afe67: YOLO/Operator = full_bypass, everything else = floor), and the
// member > rig > floor precedence. Grounds the ref/none semantics from README v4 A1/A2/A3.
import { describe, it, expect } from "vitest";
import {
  validatePermissionPolicyRef,
  classifyPermissionPolicyRef,
  resolvePermissionPolicyAttachment,
  resolvePermissionPolicyRefValue,
  builtinPackageTarget,
  BUILTIN_POLICY_NAMES,
} from "../src/domain/permission-policy/policy-ref.js";

const FLAG_FULL_BYPASS = `---\nsource: custom\nname: operator-clone\nsurface: flag\nlaunch_posture: full_bypass\npolicy_schema_version: 1\ndescription: a custom operator-style flag policy\n---\nbody\n`;
const CONFIG_POLICY = `---\nsource: custom\nname: my-config\nsurface: config\ndefault_posture: ask\nallow: []\nask: []\ndeny: []\ndestructive_class: []\npolicy_schema_version: 1\ndescription: a custom config policy\n---\nbody\n`;

describe("permission_policy ref — validate (A1/A2/A3)", () => {
  it("accepts every packaged built-in via the mandatory builtin: prefix", () => {
    for (const name of BUILTIN_POLICY_NAMES) {
      expect(validatePermissionPolicyRef(`builtin:${name}`, "permission_policy")).toBeNull();
    }
  });

  it("rejects an unknown built-in name with a structured error listing the known set", () => {
    const err = validatePermissionPolicyRef("builtin:bogus", "permission_policy");
    expect(err).toBeTruthy();
    expect(err).toMatch(/unknown built-in/i);
    // lists the known set so the error is actionable
    for (const name of BUILTIN_POLICY_NAMES) expect(err).toContain(name);
  });

  it("rejects a bare canonical name (builtin: prefix is mandatory — no shadowing)", () => {
    expect(validatePermissionPolicyRef("standard", "permission_policy")).toBeTruthy();
  });

  it("accepts a relative custom ref (resolved relative to the declaring RigSpec dir)", () => {
    expect(validatePermissionPolicyRef("policies/team.md", "permission_policy")).toBeNull();
    expect(validatePermissionPolicyRef("team.md", "permission_policy")).toBeNull();
  });

  it("rejects absolute / .. traversal / empty-segment refs as STRUCTURED errors (never floor)", () => {
    expect(validatePermissionPolicyRef("/etc/policy.md", "permission_policy")).toMatch(/absolute/i);
    expect(validatePermissionPolicyRef("../secret.md", "permission_policy")).toMatch(/traversal|\.\./);
    expect(validatePermissionPolicyRef("a//b.md", "permission_policy")).toMatch(/empty|segment/i);
  });

  it("'none' is the recorded DELIBERATE choice — VALID per the ruled amendment (RULED-FORM-deliberate-none-2026-08-04, sha256 5f37e40f; supersedes the A3 reservation error, the amendment's ONE sanctioned sealed-surface change)", () => {
    expect(validatePermissionPolicyRef("none", "permission_policy")).toBeNull();
  });

  it("rejects empty / whitespace-only", () => {
    expect(validatePermissionPolicyRef("", "permission_policy")).toBeTruthy();
    expect(validatePermissionPolicyRef("   ", "permission_policy")).toBeTruthy();
  });
});

describe("permission_policy ref — classify origin (origin honesty)", () => {
  it("classifies a builtin ref with origin=builtin + the validated name", () => {
    expect(classifyPermissionPolicyRef("builtin:yolo")).toEqual({ ref: "builtin:yolo", origin: "builtin", builtinName: "yolo" });
  });
  it("classifies a custom ref with origin=custom", () => {
    expect(classifyPermissionPolicyRef("policies/team.md")).toEqual({ ref: "policies/team.md", origin: "custom" });
  });
});

describe("permission_policy — restart-stable attachment resolution (Guard ruling 2026-08-04)", () => {
  const noFile = { readFile: () => { throw new Error("no file"); } };

  it("builtin:yolo → full_bypass, origin=builtin, PM-ruled package-copy target (never a builtin:<name> echo)", () => {
    const a = resolvePermissionPolicyAttachment("builtin:yolo", "/rig", noFile);
    expect(a).toMatchObject({ ref: "builtin:yolo", origin: "builtin", builtinName: "yolo", launchPosture: "full_bypass" });
    // PM inline ruling (via dev-guard NOT-CLEAR at 9e94c274): the resolved target is the
    // package-relative canonical copy — NOT the raw ref echoed.
    expect(a.resolvedTarget).toBe("policies/builtin/yolo.policy.md");
  });

  it("Policy-Mode built-ins resolve to the floor with the PM-ruled package-copy target", () => {
    for (const name of ["locked", "standard", "open"]) {
      const a = resolvePermissionPolicyAttachment(`builtin:${name}`, "/rig", noFile);
      expect(a.origin).toBe("builtin");
      expect(a.launchPosture).toBe("floor");
      expect(a.resolvedTarget).toBe(`policies/builtin/${name}.policy.md`);
    }
  });

  it("builtinPackageTarget pins EXACTLY the four ruled names to package-relative copies", () => {
    for (const name of ["locked", "standard", "open", "yolo"] as const) {
      expect(builtinPackageTarget(name)).toBe(`policies/builtin/${name}.policy.md`);
    }
  });

  it("CUSTOM flag policy CAN be full_bypass — content resolved relative to the declaring dir (core-owned)", () => {
    const a = resolvePermissionPolicyAttachment("policies/operator.md", "/rig/spec", { readFile: () => FLAG_FULL_BYPASS });
    expect(a.origin).toBe("custom");
    expect(a.surface).toBe("flag");
    expect(a.launchPosture).toBe("full_bypass"); // NOT floor — the ruling's crux
    expect(a.resolvedTarget).toBe("/rig/spec/policies/operator.md"); // restart-stable absolute target
    expect(a.declaringDir).toBe("/rig/spec"); // restart-stable provenance
    expect(a.ref).toBe("policies/operator.md"); // raw ref preserved for export
  });

  it("CUSTOM config policy resolves to the floor (config-surface content deferred; no config write)", () => {
    const a = resolvePermissionPolicyAttachment("policies/team.md", "/rig", { readFile: () => CONFIG_POLICY });
    expect(a.origin).toBe("custom");
    expect(a.surface).toBe("config");
    expect(a.launchPosture).toBe("floor");
  });

  it("CUSTOM ref that is unreadable → advisory floor, but ref + provenance are still preserved", () => {
    const a = resolvePermissionPolicyAttachment("policies/missing.md", "/rig", noFile);
    expect(a.launchPosture).toBe("floor");
    expect(a.ref).toBe("policies/missing.md");
    expect(a.resolvedTarget).toBe("/rig/policies/missing.md");
    expect(a.origin).toBe("custom");
  });
});

describe("permission_policy — precedence (member > rig > floor)", () => {
  it("member ref overrides the rig ref", () => {
    expect(resolvePermissionPolicyRefValue("builtin:yolo", "builtin:locked")).toBe("builtin:yolo");
  });
  it("falls back to the rig ref when the member has none", () => {
    expect(resolvePermissionPolicyRefValue(undefined, "builtin:standard")).toBe("builtin:standard");
  });
  it("absent at both levels resolves to undefined (= floor)", () => {
    expect(resolvePermissionPolicyRefValue(undefined, undefined)).toBeUndefined();
    expect(resolvePermissionPolicyRefValue(null, null)).toBeUndefined();
  });
});
