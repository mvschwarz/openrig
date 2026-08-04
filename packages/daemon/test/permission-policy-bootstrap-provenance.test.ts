import { describe, expect, it } from "vitest";
import {
  createFullTestDb,
  createTestApp,
} from "./helpers/test-app.js";
import type {
  NodeBinding,
  RuntimeAdapter,
} from "../src/domain/runtime-adapter.js";

const AGENT_YAML = `name: impl
version: "1.0.0"
resources:
  skills: []
profiles:
  default:
    uses:
      skills: []
`;

const RIG_YAML = `version: "0.2"
name: bootstrap-policy-probe
permission_policy: builtin:yolo
pods:
  - id: dev
    label: Dev
    members:
      - id: impl
        runtime: claude-code
        agent_ref: local:agents/impl
        profile: default
        permission_policy: builtin:locked
        cwd: .
    edges: []
edges: []
`;

describe("R2 bootstrap provenance fault probe", () => {
  it("happy path: bootstrap persists the MEMBER attachment (locked/floor) with the rig attachment (yolo) alongside — precedence + restart truth agree", async () => {
    const bindings: NodeBinding[] = [];
    const adapter: RuntimeAdapter = {
      runtime: "claude-code",
      listInstalled: async () => [],
      project: async () => ({ projected: [], skipped: [], failed: [] }),
      deliverStartup: async () => ({ delivered: 0, failed: [] }),
      launchHarness: async (binding) => { bindings.push(binding); return { ok: true }; },
      checkReady: async () => ({ ready: true }),
    } as unknown as RuntimeAdapter;
    const db = createFullTestDb();
    try {
      const setup = createTestApp(db, {
        adapters: { "claude-code": adapter },
        podInstantiatorFsOps: {
          exists: (path: string) => path.includes("agents/impl"),
          readFile: (path: string) => {
            if (path.includes("agents/impl")) return AGENT_YAML;
            throw new Error(`not found: ${path}`);
          },
        },
      });
      const outcome = await setup.podInstantiator.instantiate(RIG_YAML, "/rig");
      expect(outcome.ok).toBe(true);
      expect(bindings).toHaveLength(1);
      expect(bindings[0]!.launchPosture, "member override (locked) controls the live launch").toBe("floor");
      const node = db.prepare("SELECT id, rig_id FROM nodes WHERE logical_id = 'dev.impl'").get() as { id: string; rig_id: string };
      expect(setup.rigRepo.getNodePolicyProvenance(node.id)).toMatchObject({ origin: "builtin", launchPosture: "floor" });
      expect(setup.rigRepo.getRigPolicyProvenance(node.rig_id)).toMatchObject({ origin: "builtin", launchPosture: "full_bypass" });
    } finally {
      db.close();
    }
  });

  it("does not silently succeed when the member attachment cannot be persisted", async () => {
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
          exists: (path) => path.includes("agents/impl"),
          readFile: (path) => {
            if (path.includes("agents/impl")) return AGENT_YAML;
            throw new Error(`not found: ${path}`);
          },
        },
      });
      setup.rigRepo.setNodePolicyProvenance = () => {
        throw new Error("injected provenance write failure");
      };

      const outcome = await setup.podInstantiator.instantiate(RIG_YAML, "/rig");

      // CORRECTED contract (R2 terminal at 4c49c758): member provenance is LOAD-BEARING
      // restart truth on the bootstrap path — a real setter fault must be fail-visible.
      expect(outcome.ok, "bootstrap must not report success after losing restart truth").toBe(false);
      if (!outcome.ok) expect(JSON.stringify(outcome), "the failure names the injected fault").toContain("injected provenance write failure");
      expect(bindings, "a rejected bootstrap must not launch at an unpersisted posture").toHaveLength(0);
      // no invented provenance, and no half-committed node that restore could misread:
      const node = db.prepare("SELECT id FROM nodes WHERE logical_id = 'dev.impl'").get() as { id: string } | undefined;
      if (node) expect(setup.rigRepo.getNodePolicyProvenance(node.id)).toBeNull();
    } finally {
      db.close();
    }
  });
});
