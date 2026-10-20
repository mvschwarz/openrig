import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository, findLatestUsableSnapshot, findLatestUsableSnapshotsForAllRigs } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SnapshotRepository } from "../src/domain/snapshot-repository.js";
import { SnapshotCapture } from "../src/domain/snapshot-capture.js";
import { CheckpointStore } from "../src/domain/checkpoint-store.js";
import { EventBus } from "../src/domain/event-bus.js";
import { communityHarnessOf } from "../src/domain/built-in-runtimes.js";

describe("saved community-harness provenance", () => {
  let db: Database.Database;
  let snapshots: SnapshotRepository;
  let rigId: string;
  let snapshotId: string;

  beforeEach(() => {
    db = createFullTestDb();
    const rigRepo = new RigRepository(db);
    const sessionRegistry = new SessionRegistry(db);
    snapshots = new SnapshotRepository(db);
    const rig = rigRepo.createRig("snapshot-harness");
    rigId = rig.id;
    const node = rigRepo.addNode(rigId, "dev.test", { runtime: "synth-harness" });
    const session = sessionRegistry.registerSession(node.id, "dev-test@snapshot-harness");
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateResumeToken(session.id, "codex_id", "synthetic-former-runtime-token");
    sessionRegistry.recordCommunityHarnessSelection(session.id, "synth-harness");
    const capture = new SnapshotCapture({ db, rigRepo, sessionRegistry, snapshotRepo: snapshots,
      eventBus: new EventBus(db), checkpointStore: new CheckpointStore(db) });
    snapshotId = capture.captureSnapshot(rigId, "auto-pre-down").id;
  });
  afterEach(() => db.close());

  function storedData(): string {
    return (db.prepare("SELECT data FROM snapshots WHERE id = ?").get(snapshotId) as { data: string }).data;
  }

  function storeSession(fields: Record<string, unknown>): string {
    const data = JSON.parse(storedData());
    delete data.sessions[0].communityHarness;
    Object.assign(data.sessions[0], fields);
    const raw = JSON.stringify(data);
    db.prepare("UPDATE snapshots SET data = ? WHERE id = ?").run(raw, snapshotId);
    return raw;
  }

  it("decodes a legacy selection through every repository read without rewriting the saved JSON", () => {
    const raw = storeSession({ agentApp: "synth-harness" });
    const selected = snapshots.selectRestoreUsable(rigId, snapshotId);
    expect(selected.ok).toBe(true);
    const reads = [snapshots.getSnapshot(snapshotId), snapshots.getLatestSnapshot(rigId),
      snapshots.findLatestAutoPreDown(rigId), snapshots.findLatestRestoreUsable(rigId),
      snapshots.listSnapshots(rigId)[0], selected.ok ? selected.snapshot : null,
      findLatestUsableSnapshot(db, rigId), findLatestUsableSnapshotsForAllRigs(db).get(rigId)];
    for (const snapshot of reads) {
      expect(snapshot?.data.sessions[0]).toMatchObject({ communityHarness: "synth-harness" });
      expect(snapshot?.data.sessions[0]).not.toHaveProperty("agentApp");
    }
    expect(storedData()).toBe(raw);
  });

  it.each([
    { label: "new key wins", fields: { communityHarness: "new-harness", agentApp: "synth-harness" }, expected: "new-harness" },
    { label: "explicit new null wins", fields: { communityHarness: null, agentApp: "synth-harness" }, expected: null },
    { label: "new malformed value is not replaced", fields: { communityHarness: 12, agentApp: "synth-harness" }, expected: 12 },
    { label: "legacy null is not positive provenance", fields: { agentApp: null }, expected: undefined },
    { label: "invalid legacy value is not provenance", fields: { agentApp: { name: "synth-harness" } }, expected: undefined },
    { label: "legacy number is not provenance", fields: { agentApp: 12 }, expected: undefined },
    { label: "legacy boolean is not provenance", fields: { agentApp: true }, expected: undefined },
    { label: "legacy empty string is not provenance", fields: { agentApp: "" }, expected: undefined },
    { label: "legacy array is not provenance", fields: { agentApp: ["synth-harness"] }, expected: undefined },
    { label: "no selection is not inferred", fields: {}, expected: undefined },
  ])("$label", ({ fields, expected }) => {
    const raw = storeSession(fields);
    const session = snapshots.getSnapshot(snapshotId)!.data.sessions[0]!;
    expect(session.communityHarness).toBe(expected);
    expect(session).not.toHaveProperty("agentApp");
    expect(communityHarnessOf(session.communityHarness, "codex")).toBeNull();
    expect(storedData()).toBe(raw);
  });

  it("new captures and snapshots copied from decoded data write only the new key", () => {
    const fresh = JSON.parse(storedData()).sessions[0];
    expect(fresh.communityHarness).toBe("synth-harness");
    expect(fresh).not.toHaveProperty("agentApp");
    const raw = storeSession({ agentApp: "synth-harness" });
    const decoded = snapshots.getSnapshot(snapshotId)!;
    const copy = snapshots.createSnapshot(rigId, "manual", decoded.data);
    const copied = JSON.parse((db.prepare("SELECT data FROM snapshots WHERE id = ?").get(copy.id) as { data: string }).data);
    expect(copied.sessions[0].communityHarness).toBe("synth-harness");
    expect(copied.sessions[0]).not.toHaveProperty("agentApp");
    expect(storedData()).toBe(raw);
  });
});
