import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { resolveExternalCliOccupant, resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";

// GHOST-STAGE (i-c) WIRING PIN. The fire-time target-generation gate in WatchdogPolicyEngine is INERT
// unless startup injects the REAL live-generation resolver — with resolveTargetGeneration absent the
// gate no-ops and a generation-bound wake fires at the successor (the dead-invalidator class). The
// engine is constructed deep in startup (not unit-constructable), so this pins the enable path at
// source: a drop of the wiring line fails HERE, before it can ship a silently-disabled gate.
describe("(i-c) wiring pin — startup injects the real target-generation resolver into the watchdog", () => {
  const src = readFileSync(
    fileURLToPath(new URL("../src/startup.ts", import.meta.url)),
    "utf-8",
  );

  it("passes resolveTargetGeneration to the WatchdogPolicyEngine, wired to the live occupant-generation", () => {
    expect(src).toMatch(/resolveTargetGeneration:\s*\(s\)\s*=>\s*\{\s*const target = resolveGuardTarget\(db,\s*s\);\s*return target \? target\.occupant \?\? null : resolveExternalCliOccupant\(db,\s*s\);\s*\}/);
    // Without it a context watch on an ambiguous name ends for good instead of measuring again once it resolves.
    expect(src).toMatch(/targetNameCarried:\s*\(s\)\s*=>\s*sessionRegistry\.carriesSessionName\(s\)/);
  });

  it("passes the queue's terminal-timer resolver to the pre-delivery seam", () => {
    expect(src).toMatch(
      /resolvePreDeliveryTerminalReason:\s*\(\{ jobId \}\)\s*=>\s*queueRepoInstance\.resolveWatchdogPreDeliveryTerminalReason\(jobId\)/,
    );
  });

  it("gives scheduled occurrence delivery the daemon's shared durable outbox", () => {
    expect(src).toMatch(/deliver:\s*makeWatchdogDeliver\(\{\s*sessionTransport,\s*outbox:\s*outboxHandlerInstance/);
  });
});

describe("the watchdog's target generation is the addressed seat's, not the newest row's with that name", () => {
  const SEAT = "dev-impl@seat-rig";
  function seed() {
    const db = createFullTestDb();
    const rigs = new RigRepository(db), sessions = new SessionRegistry(db);
    const start = (nodeId: string) => { const s = sessions.registerSession(nodeId, SEAT); sessions.updateStatus(s.id, "running");
      sessions.updateBinding(nodeId, { tmuxSession: SEAT, tmuxPane: "%1" }); return s.id; };
    const down = (nodeId: string, sessionId: string) => { sessions.markDetached(sessionId); sessions.clearBinding(nodeId); };
    const generation = (nodeId: string) => sessions.currentOccupantTenure(nodeId)!.generationUuid;
    return { db, rigs, sessions, start, down, generation };
  }

  it("reads the current seat while an archived generation of it holds a newer row under the name", async () => {
    const { db, rigs, sessions, start, down, generation } = seed();
    // rig up, rig down; rig up the same spec again (the stopped rig is archived); rig down.
    const old = rigs.createRig("seat-rig"), oldNode = rigs.addNode(old.id, "dev.impl", { runtime: "codex" });
    down(oldNode.id, start(oldNode.id));
    rigs.archiveRig(old.id);
    const current = rigs.createRig("seat-rig"), node = rigs.addNode(current.id, "dev.impl", { runtime: "codex" });
    down(node.id, start(node.id));
    // The old rig unarchived and restored, stopped and archived again: its row under the name is now the newest.
    rigs.unarchiveRig(old.id);
    await new Promise((resolve) => setTimeout(resolve, 2)); // a later millisecond, so its row sorts newer
    down(oldNode.id, start(oldNode.id));
    rigs.archiveRig(old.id);
    expect(sessions.currentOccupantGenerationForSession(SEAT)).toBe(generation(oldNode.id));

    expect(resolveGuardTarget(db, SEAT)?.occupant).toBe(generation(node.id));
    // Started again, the seat's new generation is the one read.
    start(node.id);
    expect(resolveGuardTarget(db, SEAT)?.occupant).toBe(generation(node.id));
    expect(sessions.currentOccupantGenerationForSession(SEAT)).toBe(generation(node.id));
    db.close();
  });

  it("reads an external-CLI seat's own generation when its watch names the external session", () => {
    const { db, rigs, sessions, generation } = seed();
    const NAME = "work-term@seat-rig";
    const rig = rigs.createRig("seat-rig");
    const node = rigs.addNode(rig.id, "dev.ext", { runtime: "codex" });
    // As self-attach records an external-CLI seat: the session and the binding carry the external name, no tmux session.
    sessions.updateStatus(sessions.registerSession(node.id, NAME).id, "running");
    sessions.updateBinding(node.id, { attachmentType: "external_cli", externalSessionName: NAME });
    // The guard's address rules don't match an external session name; the watchdog's fallback does.
    expect(resolveGuardTarget(db, NAME)).toBeNull();
    expect(resolveExternalCliOccupant(db, NAME)).toBe(generation(node.id));
    // A second unarchived external binding with that name: neither seat is read.
    const other = rigs.addNode(rig.id, "dev.ext2", { runtime: "codex" });
    sessions.updateBinding(other.id, { attachmentType: "external_cli", externalSessionName: NAME });
    expect(resolveExternalCliOccupant(db, NAME)).toBeNull();
    db.close();
  });

  it("reads a live seat's current generation, as before", () => {
    const { db, rigs, sessions, start, generation } = seed();
    const node = rigs.addNode(rigs.createRig("seat-rig").id, "dev.impl", { runtime: "codex" });
    start(node.id);
    expect(resolveGuardTarget(db, SEAT)?.occupant).toBe(generation(node.id));
    expect(resolveGuardTarget(db, SEAT)?.occupant).toBe(sessions.currentOccupantGenerationForSession(SEAT));
    db.close();
  });
});
