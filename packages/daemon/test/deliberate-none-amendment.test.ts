// DELIBERATE-NONE AMENDMENT (Lane-A hop 2) — pins for the RULED FORM OF RECORD
// `RULED-FORM-deliberate-none-2026-08-04.md` sha256
// 5f37e40fbcdcf220dd103783d64fcac2e52945e96f736918abc2d8e84c768dc0 (PM-confirmed):
// `permission_policy: none` = the recorded deliberate choice; third origin
// `deliberate_none`; NEVER resolves to any file; posture IDENTICAL to absent
// (zero privilege delta — the change is record/provenance only).
// P1 (HONESTY CRUX) and P2 (POSTURE-IDENTITY) are the ruled form's pin-required
// invariants for this lane; P3 (write-on-explicit-selection-only) is Lane-B's.
import { describe, expect, it } from "vitest";
import {
  resolvePermissionPolicyAttachment,
  validatePermissionPolicyRef,
} from "../src/domain/permission-policy/policy-ref.js";
import { rigPreflight } from "../src/domain/rigspec-preflight.js";
import type { AgentResolverFsOps } from "../src/domain/agent-resolver.js";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";

const AGENT_YAML = `name: impl
version: "1.0.0"
resources:
  skills: []
profiles:
  default:
    uses:
      skills: []
`;

function fsOps(): AgentResolverFsOps {
  return {
    exists: (p) => p.includes("agents/impl"),
    readFile: (p) => {
      if (p.includes("agents/impl")) return AGENT_YAML;
      throw new Error(`not found: ${p}`);
    },
  };
}

function rigYaml(policyLine: string): string {
  return `version: "0.2"
name: deliberate-none-probe
${policyLine}pods:
  - id: dev
    label: Dev
    members:
      - id: impl
        runtime: claude-code
        agent_ref: local:agents/impl
        profile: default
        cwd: .
    edges: []
`;
}

describe("deliberate-none resolution (ruled form 5f37e40f)", () => {
  it("resolves 'none' to origin=deliberate_none, floor posture, and NEVER touches any file (reader that throws proves never-resolves-by-construction)", () => {
    const att = resolvePermissionPolicyAttachment("none", "/any/declaring/dir", {
      readFile: () => {
        throw new Error("deliberate_none must never read a file");
      },
    });
    expect(att.ref).toBe("none");
    expect(att.origin).toBe("deliberate_none");
    expect(att.launchPosture).toBe("floor");
    expect(att.resolvedTarget).toBeUndefined(); // unreferenceable — the A3 no-squatting fence holds
    expect(att.declaringDir).toBeUndefined();
  });

  it("EXACTLY the literal 'none' is the token — near-miss spellings remain ordinary CUSTOM refs (valid paths, never deliberate_none)", () => {
    expect(validatePermissionPolicyRef("none", "permission_policy")).toBeNull();
    // 'None' and 'none.md' pass the A2 path charset as they always did — they
    // are custom FILE refs, not the token; resolution proves the distinction:
    for (const nearMiss of ["None", "none.md"]) {
      expect(validatePermissionPolicyRef(nearMiss, "permission_policy")).toBeNull();
      const att = resolvePermissionPolicyAttachment(nearMiss, "/x", { readFile: () => { throw new Error("missing"); } });
      expect(att.origin).toBe("custom"); // never the recorded-choice origin
      expect(att.origin).not.toBe("deliberate_none");
    }
  });
});

describe("P1 HONESTY CRUX — an ABSENT spec is NEVER rewritten, upgraded, or reported as deliberate_none", () => {
  it("preflight discovery on an ABSENT-policy spec reports absence verbatim — no deliberate_none anywhere", async () => {
    const result = await rigPreflight({
      rigSpecYaml: rigYaml(""),
      rigRoot: "/probe/root",
      fsOps: fsOps(),
    });
    expect(result.ready).toBe(true);
    const joined = result.warnings.join("\n");
    expect(joined).toContain("dev.impl: permission_policy absent; launch_posture=floor");
    expect(joined).not.toContain("deliberate_none");
    expect(joined).not.toContain("(deliberate choice");
  });

  it("materialize of an ABSENT-policy spec persists NO policy provenance (null rows, never a fabricated 'none' record)", async () => {
    const db = createFullTestDb();
    try {
      const setup = createTestApp(db, { podInstantiatorFsOps: fsOps() });
      const outcome = await setup.podInstantiator.materialize(rigYaml(""), "/probe/root");
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      const row = db.prepare(
        "SELECT policy_origin, policy_launch_posture FROM nodes WHERE logical_id = 'dev.impl'",
      ).get() as { policy_origin: string | null; policy_launch_posture: string | null };
      expect(row.policy_origin).toBeNull(); // absent means absent — a legacy spec never claims a choice nobody made
      expect(row.policy_launch_posture).toBeNull();
      const rig = db.prepare("SELECT permission_policy FROM rigs LIMIT 1").get() as { permission_policy: string | null };
      expect(rig.permission_policy).toBeNull();
    } finally {
      db.close();
    }
  });
});

describe("P2 POSTURE-IDENTITY — absent and none differ ONLY in the record", () => {
  it("discovery: both report launch_posture=floor; only the record wording differs; materialize succeeds identically (201-class outcome both)", async () => {
    const absent = await rigPreflight({ rigSpecYaml: rigYaml(""), rigRoot: "/probe/root", fsOps: fsOps() });
    const none = await rigPreflight({ rigSpecYaml: rigYaml("permission_policy: none\n"), rigRoot: "/probe/root", fsOps: fsOps() });
    expect(absent.ready).toBe(true);
    expect(none.ready).toBe(true);
    const a = absent.warnings.find((w) => w.startsWith("dev.impl: permission_policy"))!;
    const n = none.warnings.find((w) => w.startsWith("dev.impl: permission_policy"))!;
    expect(a).toMatch(/launch_posture=floor$/);
    expect(n).toMatch(/launch_posture=floor$/); // BYTE-IDENTICAL posture claim
    expect(n).toContain("deliberate choice — recorded"); // the record is the ONLY difference
    expect(a).toContain("absent");
  });

  it("attachment posture equality: resolve('none') posture === the absent floor; persisted provenance carries the deliberate_none record", async () => {
    const att = resolvePermissionPolicyAttachment("none", "/x", { readFile: () => { throw new Error("no read"); } });
    expect(att.launchPosture).toBe("floor"); // identical privilege to absent — zero delta
    const db = createFullTestDb();
    try {
      const setup = createTestApp(db, { podInstantiatorFsOps: fsOps() });
      const outcome = await setup.podInstantiator.materialize(rigYaml("permission_policy: none\n"), "/probe/root");
      expect(outcome.ok).toBe(true);
      const row = db.prepare(
        "SELECT policy_origin, policy_launch_posture FROM nodes WHERE logical_id = 'dev.impl'",
      ).get() as { policy_origin: string | null; policy_launch_posture: string | null };
      expect(row.policy_origin).toBe("deliberate_none"); // the recorded thought IS provenance
      expect(row.policy_launch_posture).toBe("floor");
    } finally {
      db.close();
    }
  });
});
