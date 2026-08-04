import { describe, expect, it } from "vitest";
import {
  resolvePermissionPolicyAttachment,
  validatePermissionPolicyRef,
} from "/private/tmp/openrig-slice03-80336ff0/packages/daemon/src/domain/permission-policy/policy-ref.ts";
import { validatePolicySpec } from "/private/tmp/openrig-slice03-80336ff0/packages/daemon/src/domain/permission-policy/policy-spec.ts";
import { RigSpecSchema } from "/private/tmp/openrig-slice03-80336ff0/packages/daemon/src/domain/rigspec-schema.ts";
import {
  createFullTestDb,
  createTestApp,
} from "/private/tmp/openrig-slice03-80336ff0/packages/daemon/test/helpers/test-app.ts";
import type { NodeBinding, RuntimeAdapter } from "/private/tmp/openrig-slice03-80336ff0/packages/daemon/src/domain/runtime-adapter.ts";

const INVALID_BUT_READABLE_CONFIG = `---
source: custom
name: incomplete-config
surface: config
policy_schema_version: 1
description: missing required config fields
---
body
`;

const AGENT_YAML = `name: impl
version: "1.0.0"
resources:
  skills: []
profiles:
  default:
    uses:
      skills: []
`;

function minimalSpec(permissionPolicy: unknown): Record<string, unknown> {
  return {
    version: "0.2",
    name: "r2-seamb-repro",
    permission_policy: permissionPolicy,
    pods: [{
      id: "dev",
      label: "Dev",
      members: [{
        id: "impl",
        runtime: "claude-code",
        agent_ref: "local:agents/impl",
        profile: "default",
        cwd: ".",
      }],
      edges: [],
    }],
    edges: [],
  };
}

describe("review50-r2 independent Seam-B adversarial branches", () => {
  it("rejects characters outside the required per-segment ref charset", () => {
    expect(validatePermissionPolicyRef("policies/team?.md", "permission_policy")).not.toBeNull();
  });

  it("rejects explicit null because attachment grammar permits only the two string forms or absence", () => {
    expect(RigSpecSchema.validate(minimalSpec(null)).valid).toBe(false);
  });

  it("does not mark readable-but-invalid config content as safely re-derived", () => {
    const attachment = resolvePermissionPolicyAttachment("policies/incomplete.md", "/rig", {
      readFile: () => INVALID_BUT_READABLE_CONFIG,
    });
    const validity = validatePolicySpec({
      source: "custom",
      name: "incomplete-config",
      surface: "config",
      policy_schema_version: 1,
      description: "missing required config fields",
    });
    expect(validity.ok).toBe(false);
    expect(attachment.contentResolved).toBe(false);
  });

  it("launches structured add-member at inherited rig posture", async () => {
    const bindings: NodeBinding[] = [];
    const adapter: RuntimeAdapter = {
      runtime: "claude-code",
      listInstalled: async () => [],
      project: async () => ({ projected: [], skipped: [], failed: [] }),
      deliverStartup: async () => ({ delivered: 0, failed: [] }),
      launchHarness: async (binding) => {
        bindings.push(binding);
        return { ok: true };
      },
      checkReady: async () => ({ ready: true }),
    };
    const db = createFullTestDb();
    try {
      const setup = createTestApp(db, {
        adapters: { "claude-code": adapter },
        podInstantiatorFsOps: {
          exists: (p) => p.includes("agents/impl"),
          readFile: (p) => {
            if (p.includes("agents/impl")) return AGENT_YAML;
            throw new Error(`not found: ${p}`);
          },
        },
      });
      const materialized = await setup.podInstantiator.materializeStructured(
        minimalSpec("builtin:yolo"),
        "/rig",
      );
      expect(materialized.ok).toBe(true);
      const rigId = (materialized as { ok: true; result: { rigId: string } }).result.rigId;
      const added = await setup.podInstantiator.addMemberToPod(
        rigId,
        "dev",
        {
          id: "late",
          runtime: "claude-code",
          agent_ref: "local:agents/impl",
          profile: "default",
          cwd: ".",
        },
        "/different-operation-root",
      );
      expect(added.ok).toBe(true);
      expect(bindings).toHaveLength(1);
      const lateId = (db.prepare("SELECT id FROM nodes WHERE logical_id = 'dev.late'").get() as { id: string }).id;
      expect(setup.rigRepo.getNodePolicyProvenance(lateId)?.launchPosture).toBe("full_bypass");
      expect.soft(bindings[0]?.launchPosture).toBe("full_bypass");
    } finally {
      db.close();
    }
  });

  it("launches structured pod expansion at inherited rig posture", async () => {
    const bindings: NodeBinding[] = [];
    const adapter: RuntimeAdapter = {
      runtime: "claude-code",
      listInstalled: async () => [],
      project: async () => ({ projected: [], skipped: [], failed: [] }),
      deliverStartup: async () => ({ delivered: 0, failed: [] }),
      launchHarness: async (binding) => {
        bindings.push(binding);
        return { ok: true };
      },
      checkReady: async () => ({ ready: true }),
    };
    const db = createFullTestDb();
    try {
      const setup = createTestApp(db, {
        adapters: { "claude-code": adapter },
        podInstantiatorFsOps: {
          exists: (p) => p.includes("agents/impl"),
          readFile: (p) => {
            if (p.includes("agents/impl")) return AGENT_YAML;
            throw new Error(`not found: ${p}`);
          },
        },
      });
      const materialized = await setup.podInstantiator.materializeStructured(
        minimalSpec("builtin:yolo"),
        "/rig",
      );
      expect(materialized.ok).toBe(true);
      const rigId = (materialized as { ok: true; result: { rigId: string } }).result.rigId;
      const expanded = await setup.rigExpansionService.expand({
        rigId,
        rigRoot: "/different-operation-root",
        pod: {
          id: "later",
          label: "Later",
          members: [{
            id: "worker",
            runtime: "claude-code",
            agentRef: "local:agents/impl",
            profile: "default",
            cwd: ".",
          }],
          edges: [],
        },
      });
      expect(expanded.ok).toBe(true);
      expect(bindings).toHaveLength(1);
      const workerId = (db.prepare("SELECT id FROM nodes WHERE logical_id = 'later.worker'").get() as { id: string }).id;
      expect.soft(bindings[0]?.launchPosture).toBe("full_bypass");
      expect.soft(setup.rigRepo.getNodePolicyProvenance(workerId)?.launchPosture).toBe("full_bypass");
    } finally {
      db.close();
    }
  });
});
