// Synthetic registry transitions exercise the real SQLite boot timestamp.
// The positive control waits beyond its ambiguous second; no live provider is run.
import { describe, it, expect, vi } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SeatIdentityStore } from "../src/domain/seat-identity-store.js";
import { readCodexPromptBinding } from "../src/domain/codex-prompt-observation.js";
import { SeatActivityService } from "../src/domain/seat-activity-service.js";
import { SeatStructuralActivityService } from "../src/domain/seat-structural-activity-service.js";
import { CODEX_ACTIVITY_RUNG_INVENTORY } from "../src/domain/activity-taxonomy.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

const name = "worker@tenure-fixture";
const clearFrame = ["  >_ OpenAI Codex (v0.160.0)", "     /tmp/tenure-fixture", "  permissions: bypass", "",
  "  Ready to work", "", "› Ask Codex to do anything", "", "  gpt-test · /tmp/tenure-fixture", "  ? for shortcuts"].join("\n");

async function successorWithRetainedIdentity() {
  const db = createFullTestDb();
  const rigs = new RigRepository(db);
  const registry = new SessionRegistry(db);
  const rig = rigs.createRig("tenure-fixture");
  const node = rigs.addNode(rig.id, "dev.builder", { runtime: "codex" });
  const first = registry.registerSession(node.id, name);
  registry.updateStartupStatus(first.id, "ready");
  registry.updateBinding(node.id, { tmuxSession: name, tmuxPane: "%42", attachmentType: "tmux" });
  registry.updateResumeToken(first.id, "codex", "native-predecessor", "scrape");
  const generationBefore = registry.currentOccupantTenure(node.id)!.generationUuid;
  const identities = new SeatIdentityStore(db);
  const oldObservation = new Date().toISOString();
  const identity = { nodeId: node.id, sessionName: name, verdict: "verified" as const,
    evidenceSource: null, reason: null, observedAt: oldObservation,
    evidence: { registeredPane: "%42", observedPid: 10, observedPanePid: 5,
      observedCommand: "codex", matchedLayer: 1 } };
  identities.upsert(identity);
  // Real register verbs and their real SQLite clock. Cross its one-second boot_at resolution;
  // no direct tenure/identity-table edit manufactures the transition.
  await delay(1100);
  registry.updateStatus(first.id, "superseded");
  registry.updateBinding(node.id, { tmuxSession: name, tmuxPane: "%42", attachmentType: "tmux" });
  const successor = registry.registerClaimedSession(node.id, name, "handover");
  registry.updateResumeToken(successor.id, "codex", "native-successor", "scrape");
  const tenure = registry.currentOccupantTenure(node.id)!;
  expect(tenure.generationUuid).not.toBe(generationBefore);
  expect(tenure.nativeSessionIdAtBoot).toBeNull();
  expect(Date.parse(oldObservation)).toBeLessThan(Date.parse(tenure.bootAt.replace(" ", "T") + "Z"));
  expect(Date.now() - Date.parse(oldObservation)).toBeLessThan(5000);
  expect(identities.getForNode(node.id)!.observedAt).toBe(oldObservation);
  const read = () => readCodexPromptBinding(db, registry, identities, name, new Date());
  const capture = vi.fn(async () => clearFrame);
  const tmux = { capturePaneContent: capture, readPaneLastActivity: vi.fn(async () => null) } as unknown as TmuxAdapter;
  const oracle = new SeatActivityService({ tmux, defaultWindowSeconds: 3, codexPromptBindingReader: read });
  // Match the actual handover oracle reset and next normal inventory declaration.
  oracle.declareRungInventory({ seatNodeId: node.id, sessionName: name }, CODEX_ACTIVITY_RUNG_INVENTORY);
  oracle.declareOccupantSwap(node.id, tenure.generationUuid);
  oracle.declareRungInventory({ seatNodeId: node.id, sessionName: name }, CODEX_ACTIVITY_RUNG_INVENTORY);
  const structural = new SeatStructuralActivityService(tmux);
  structural.attachPromptObserver((session, runtime) => oracle.beginCodexPromptCapture(session, runtime));
  return { db, node, read, oracle, structural, identities, identity, oldObservation, tenure };
}

describe("current-generation native prompt authority", () => {
  it("new same-name generation cannot use the predecessor's still-fresh verified PID verdict", async () => {
    const f = await successorWithRetainedIdentity();
    try {
      const binding = f.read();
      await f.structural.pollSeat(name, undefined, "codex");
      const state = f.oracle.getSeatState(f.node.id)!;
      expect.soft(binding, "current binding must wait for current-generation process evidence").toBeNull();
      expect.soft(state.needsInputEvidence, "existing oracle must preserve unknown for this unverified successor").toBeNull();
    } finally { f.db.close(); }
  });

  it("a later current-generation verified observation permits the same qualified bytes", async () => {
    const f = await successorWithRetainedIdentity();
    try {
      // migration060 records only the boot second; a valid control must be beyond that entire interval.
      const bootUpper = Date.parse(f.tenure.bootAt.replace(" ", "T") + "Z") + 1000;
      await delay(Math.max(0, bootUpper - Date.now()));
      f.identities.upsert({ ...f.identity, observedAt: new Date().toISOString(),
        evidence: { ...f.identity.evidence, observedPid: 11, observedPanePid: 6 } });
      expect(f.read()).not.toBeNull();
      await f.structural.pollSeat(name, undefined, "codex");
      const state = f.oracle.getSeatState(f.node.id)!;
      expect(state.needsInput).toEqual({ count: 0, reason: null });
      expect(state.needsInputEvidence?.rung).toBe("needs-input-chrome");
    } finally { f.db.close(); }
  });
});
