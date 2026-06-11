import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import type { ExpansionRequest } from "../src/domain/types.js";
import {
  diffTopology,
  convergeOp,
  isSupportedOpKind,
  SUPPORTED_OP_KINDS,
  DEFERRED_OP_REASON,
  type DeclaredMember,
  type LiveMember,
  type TopologyOp,
} from "../src/domain/topology-converge.js";

// OPR.0.3.3.24 Chunk 2b — the converge spine (AC-6 scaffold).
// Covers the complete-shaped Op classification (differ) and the converge
// boundary: add_member implemented, every other kind honestly detected-deferred.
describe("topology-converge", () => {
  function declared(pod: string, id: string, runtime = "terminal"): DeclaredMember {
    return {
      pod,
      id,
      runtime,
      fragment: { id, runtime, agent_ref: "builtin:terminal", profile: "none", cwd: "/tmp" },
    };
  }
  function live(logicalId: string, runtime = "terminal"): LiveMember {
    return { logicalId, runtime };
  }

  describe("diffTopology classification", () => {
    it("classifies a declared-but-not-live member as add_member (implemented)", () => {
      // Declare the existing member too so the only delta is the new one.
      const ops = diffTopology(
        [declared("infra", "server"), declared("infra", "server2")],
        [live("infra.server")],
      );
      expect(ops).toEqual([{ kind: "add_member", pod: "infra", member: declared("infra", "server2").fragment }]);
    });

    it("classifies a live-but-not-declared member as remove_member (deferred)", () => {
      const ops = diffTopology([declared("infra", "server")], [live("infra.server"), live("infra.gone")]);
      expect(ops).toContainEqual({ kind: "remove_member", logicalId: "infra.gone" });
    });

    it("classifies a runtime change on a present member as change_runtime (deferred)", () => {
      const ops = diffTopology([declared("infra", "server", "codex")], [live("infra.server", "terminal")]);
      expect(ops).toContainEqual({ kind: "change_runtime", logicalId: "infra.server", runtime: "codex" });
    });

    it("emits no ops when declared and live match exactly", () => {
      const ops = diffTopology([declared("infra", "server")], [live("infra.server")]);
      expect(ops).toEqual([]);
    });

    it("does not synthesize move_member / fork_member from a flat membership diff", () => {
      // A member removed from one pod + added to another reads as remove + add,
      // not a move — move/fork need the 0.4.0 stable-identity model.
      const ops = diffTopology([declared("dev", "impl")], [live("infra.impl")]);
      const kinds = ops.map((o) => o.kind).sort();
      expect(kinds).toEqual(["add_member", "remove_member"]);
      expect(ops.some((o) => o.kind === "move_member" || o.kind === "fork_member")).toBe(false);
    });
  });

  describe("supported-op-kind set", () => {
    it("supports only add_member this release", () => {
      expect(SUPPORTED_OP_KINDS).toEqual(["add_member"]);
      expect(isSupportedOpKind("add_member")).toBe(true);
      for (const k of ["remove_member", "move_member", "fork_member", "change_runtime"] as const) {
        expect(isSupportedOpKind(k)).toBe(false);
      }
    });
  });

  describe("convergeOp", () => {
    let db: Database.Database;
    let setup: ReturnType<typeof createTestApp>;

    beforeEach(() => {
      db = createFullTestDb();
      setup = createTestApp(db);
    });
    afterEach(() => { db.close(); });

    function terminalPodFragment(id = "infra", memberId = "server"): ExpansionRequest["pod"] {
      return {
        id,
        label: "Infrastructure",
        members: [{ id: memberId, runtime: "terminal", agentRef: "builtin:terminal", profile: "none", cwd: "/tmp" }],
        edges: [],
      };
    }

    async function seedRigWithPod() {
      const rig = setup.rigRepo.createRig("test-rig");
      const expanded = await setup.rigExpansionService.expand({ rigId: rig.id, pod: terminalPodFragment() });
      expect(expanded.ok).toBe(true);
      return rig;
    }

    it("converges an add_member op via addMemberToPod", async () => {
      const rig = await seedRigWithPod();
      const op: TopologyOp = {
        kind: "add_member",
        pod: "infra",
        member: { id: "server2", runtime: "terminal", agent_ref: "builtin:terminal", profile: "none", cwd: "/tmp" },
      };

      const result = await convergeOp(setup.podInstantiator, rig.id, op, ".");

      expect(result.kind).toBe("add_member");
      expect(result.supported).toBe(true);
      if (result.kind !== "add_member" || !result.supported) return;
      expect(result.outcome.ok).toBe(true);
      if (!result.outcome.ok) return;
      expect(result.outcome.result.node.logicalId).toBe("infra.server2");
      expect(result.outcome.result.node.status).toBe("launched");
    });

    it("surfaces add_member failures honestly through the converge outcome", async () => {
      const rig = await seedRigWithPod();
      // Duplicate member id -> the converge outcome carries the member_conflict.
      const op: TopologyOp = {
        kind: "add_member",
        pod: "infra",
        member: { id: "server", runtime: "terminal", agent_ref: "builtin:terminal", profile: "none", cwd: "/tmp" },
      };

      const result = await convergeOp(setup.podInstantiator, rig.id, op, ".");
      expect(result.kind).toBe("add_member");
      if (result.kind !== "add_member" || !result.supported) return;
      expect(result.outcome.ok).toBe(false);
      if (result.outcome.ok) return;
      expect(result.outcome.code).toBe("member_conflict");
    });

    it("reports every unsupported op-kind as detected-not-supported (never silently skipped)", async () => {
      const rig = await seedRigWithPod();
      const unsupported: TopologyOp[] = [
        { kind: "remove_member", logicalId: "infra.server" },
        { kind: "move_member", logicalId: "infra.server", toPod: "dev" },
        { kind: "fork_member", logicalId: "infra.server", toMember: "server-fork" },
        { kind: "change_runtime", logicalId: "infra.server", runtime: "codex" },
      ];

      for (const op of unsupported) {
        const result = await convergeOp(setup.podInstantiator, rig.id, op, ".");
        expect(result.supported).toBe(false);
        if (result.supported) continue;
        expect(result.detected).toBe(true);
        expect(result.reason).toBe(DEFERRED_OP_REASON);
        expect(result.kind).toBe(op.kind);
      }
    });
  });
});
