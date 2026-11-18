import { describe, it, expect } from "vitest";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SeatPoolSlotsRepository } from "../src/domain/seat-pool-slots.js";

const AT = "2026-11-18T10:00:00.000Z";

function setup() {
  const db = createFullTestDb();
  const rigRepo = new RigRepository(db);
  const slots = new SeatPoolSlotsRepository(db);
  const rig = rigRepo.createRig("pool-rig");
  const model = rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code" });
  return { db, rigRepo, slots, rig, model };
}

describe("seat pool slots (#3395 Piece 1)", () => {
  it("The first slot of a model is number 1, named after the model's logical id.", () => {
    const { db, slots, model } = setup();
    try {
      expect(slots.nextSlot(model.id)).toEqual({ slotNumber: 1, logicalId: "dev.impl-s1" });
    } finally {
      db.close();
    }
  });

  it("The next number is one more than the highest recorded for the model, even when a lower slot is drained.", () => {
    const { db, rigRepo, slots, rig, model } = setup();
    try {
      for (const n of [1, 2, 3]) {
        const agent = rigRepo.addNode(rig.id, `dev.impl-s${n}`, { runtime: "claude-code" });
        slots.insert({ modelNodeId: model.id, slotNumber: n, nodeId: agent.id, phase: n === 1 ? "drained" : "live", at: AT });
      }
      expect(slots.nextSlot(model.id)).toEqual({ slotNumber: 4, logicalId: "dev.impl-s4" });
    } finally {
      db.close();
    }
  });

  it("The next number skips a logical id the rig already has, so creating the agent never meets an existing member.", () => {
    const { db, rigRepo, slots, rig, model } = setup();
    try {
      rigRepo.addNode(rig.id, "dev.impl-s1", { runtime: "claude-code" });
      rigRepo.addNode(rig.id, "dev.impl-s2", { runtime: "codex" });
      expect(slots.nextSlot(model.id)).toEqual({ slotNumber: 3, logicalId: "dev.impl-s3" });
    } finally {
      db.close();
    }
  });

  it("Deleting an agent's node by hand takes its slot row with it and frees the number.", () => {
    const { db, rigRepo, slots, rig, model } = setup();
    try {
      const agent = rigRepo.addNode(rig.id, "dev.impl-s1", { runtime: "claude-code" });
      slots.insert({ modelNodeId: model.id, slotNumber: 1, nodeId: agent.id, phase: "live", at: AT });
      db.prepare("DELETE FROM nodes WHERE id = ?").run(agent.id);
      expect(slots.forModel(model.id)).toEqual([]);
      expect(slots.nextSlot(model.id)).toEqual({ slotNumber: 1, logicalId: "dev.impl-s1" });
    } finally {
      db.close();
    }
  });

  it("Deleting the model's node by hand takes every slot row of that model with it, and the agents stay as plain nodes.", () => {
    const { db, rigRepo, slots, rig, model } = setup();
    try {
      const agent = rigRepo.addNode(rig.id, "dev.impl-s1", { runtime: "claude-code" });
      slots.insert({ modelNodeId: model.id, slotNumber: 1, nodeId: agent.id, phase: "live", at: AT });
      db.prepare("DELETE FROM nodes WHERE id = ?").run(model.id);
      expect(db.prepare("SELECT COUNT(*) AS n FROM seat_pool_slots").get()).toEqual({ n: 0 });
      expect(rigRepo.getRig(rig.id)!.nodes.map((n) => n.logicalId)).toEqual(["dev.impl-s1"]);
      expect(slots.poolAgentNodeIds(rig.id)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("poolAgentNodeIds returns the agents' nodes in every phase, drained included, and not the model or a slot with no node yet.", () => {
    const { db, rigRepo, slots, rig, model } = setup();
    try {
      const phases = ["adding", "live", "draining", "drained"] as const;
      const ids = phases.map((phase, i) => {
        const agent = rigRepo.addNode(rig.id, `dev.impl-s${i + 1}`, { runtime: "claude-code" });
        slots.insert({ modelNodeId: model.id, slotNumber: i + 1, nodeId: agent.id, phase, at: AT });
        return agent.id;
      });
      slots.insert({ modelNodeId: model.id, slotNumber: 5, nodeId: null, phase: "adding", at: AT });
      const other = rigRepo.createRig("other-rig");
      const otherModel = rigRepo.addNode(other.id, "dev.impl", { runtime: "claude-code" });
      const otherAgent = rigRepo.addNode(other.id, "dev.impl-s1", { runtime: "claude-code" });
      slots.insert({ modelNodeId: otherModel.id, slotNumber: 1, nodeId: otherAgent.id, phase: "live", at: AT });

      expect(slots.poolAgentNodeIds(rig.id)).toEqual(ids);
      expect(slots.forModel(model.id).map((s) => s.phase)).toEqual([...phases, "adding"]);
    } finally {
      db.close();
    }
  });

  it("A slot number is unique per model, and one node is the agent of one slot at most.", () => {
    const { db, rigRepo, slots, rig, model } = setup();
    try {
      const agent = rigRepo.addNode(rig.id, "dev.impl-s1", { runtime: "claude-code" });
      slots.insert({ modelNodeId: model.id, slotNumber: 1, nodeId: agent.id, phase: "live", at: AT });
      expect(() => slots.insert({ modelNodeId: model.id, slotNumber: 1, nodeId: null, phase: "adding", at: AT })).toThrow(/UNIQUE/);
      expect(() => slots.insert({ modelNodeId: model.id, slotNumber: 2, nodeId: agent.id, phase: "adding", at: AT })).toThrow(/UNIQUE/);
    } finally {
      db.close();
    }
  });
});
