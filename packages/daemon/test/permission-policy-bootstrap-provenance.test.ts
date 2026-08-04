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

const TWO_MEMBER_RIG_YAML = `version: "0.2"
name: bootstrap-policy-probe-2
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
      - id: qa
        runtime: claude-code
        agent_ref: local:agents/impl
        profile: default
        permission_policy: builtin:locked
        cwd: .
    edges: []
edges: []
`;

describe("R2 bootstrap provenance fault probe", () => {
  it("SELECTIVE first-setter fault in a TWO-member bootstrap: the sibling may launch (partial-success semantics), but the failed member must NOT survive as a resumable node whose restore posture widens to the rig full_bypass (Guard multi-seat probe at 16e853a7)", async () => {
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
      // selective fault: FIRST provenance write throws, later ones delegate normally
      const original = setup.rigRepo.setNodePolicyProvenance.bind(setup.rigRepo);
      let calls = 0;
      setup.rigRepo.setNodePolicyProvenance = (nodeId, prov) => {
        calls += 1;
        if (calls === 1) throw new Error("injected selective provenance fault");
        return original(nodeId, prov);
      };

      const outcome = await setup.podInstantiator.instantiate(TWO_MEMBER_RIG_YAML, "/rig");

      // partial-success semantics: the UNAFFECTED sibling may launch and the rig may report ok
      expect(bindings.length, "exactly the unaffected sibling launches").toBe(1);
      void outcome; // ok may be true under partial-success — that is the preserved contract

      // the load-bearing invariant: NO resumable node lacking required provenance survives.
      const rows = db.prepare("SELECT logical_id FROM nodes WHERE logical_id LIKE 'dev.%'").all() as { logical_id: string }[];
      const survivors = rows.map((r) => r.logical_id).sort();
      expect(survivors, "the failed member must not survive as a half-created node").toHaveLength(1);
      // the surviving sibling carries its member provenance (locked/floor), never the rig widening
      const survivor = db.prepare("SELECT id, rig_id FROM nodes WHERE logical_id = ?").get(survivors[0]!) as { id: string; rig_id: string };
      expect(setup.rigRepo.getNodePolicyProvenance(survivor.id)).toMatchObject({ origin: "builtin", launchPosture: "floor" });
    } finally {
      db.close();
    }
  });

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
