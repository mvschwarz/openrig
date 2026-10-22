import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { snapshotsSchema } from "../src/db/migrations/004_snapshots.js";
import { SnapshotRepository } from "../src/domain/snapshot-repository.js";
import { findLatestUsableSnapshot, findLatestUsableSnapshotsForAllRigs } from "../src/domain/rig-repository.js";
import { communityHarnessOf } from "../src/domain/built-in-runtimes.js";
import type { Snapshot, SnapshotData } from "../src/domain/types.js";

// Synthetic stored inputs. These are reader/serialization controls, not native
// execution or an actual restore-orchestrator result.
const dbs: Database.Database[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

type Case = {
  name: string;
  runtime: string;
  selection: Record<string, unknown>;
  expected: string | null | undefined;
  positive: string | null;
};
const cases: Case[] = [
  { name: "recorded legacy selection", runtime: "synth-qa", selection: { agentApp: "synth-qa" }, expected: "synth-qa", positive: "synth-qa" },
  { name: "same free-text runtime without provenance", runtime: "synth-qa", selection: {}, expected: undefined, positive: null },
  { name: "recorded selection after runtime changed", runtime: "codex", selection: { agentApp: "synth-qa" }, expected: "synth-qa", positive: null },
  { name: "legacy null supplies no selection", runtime: "synth-qa", selection: { agentApp: null }, expected: undefined, positive: null },
  { name: "explicit new selection wins conflicting legacy", runtime: "synth-qa", selection: { agentApp: "synth-qa", communityHarness: "other-qa" }, expected: "other-qa", positive: null },
  { name: "explicit new null wins positive legacy", runtime: "synth-qa", selection: { agentApp: "synth-qa", communityHarness: null }, expected: null, positive: null },
  ...[0, false, { name: "synth-qa" }, ["synth-qa"], ""].map((value, index): Case => ({
    name: `malformed legacy value ${index} supplies no selection`, runtime: "synth-qa",
    selection: { agentApp: value }, expected: undefined, positive: null,
  })),
];

function fixture(test: Case): SnapshotData {
  // Persisted old/unknown fields deliberately cross the JSON storage boundary;
  // the cast does not turn them into an authored new-format Session.
  return {
    rig: { id: "qa-rig", name: "qa-rename", createdAt: "2026-10-19", updatedAt: "2026-10-19" },
    nodes: [{ id: "qa-node", logicalId: "qa-worker", runtime: test.runtime }],
    edges: [], checkpoints: { marker: "preserve-checkpoint" },
    sessions: [{
      id: "qa-session", nodeId: "qa-node", sessionName: "qa-worker@qa-rename",
      status: "running", createdAt: "2026-10-19T00:00:00.000Z", lastSeenAt: null,
      resumeType: "codex_id", resumeToken: "synthetic-old-token-never-contacted",
      restorePolicy: "resume_if_possible", origin: "launched", startupStatus: "ready",
      startupCompletedAt: "2026-10-19T00:00:00.000Z", extension: { marker: "preserve-extension" },
      ...test.selection,
    }],
    activeSessionIdByNode: { "qa-node": "qa-session" },
    activeOccupantsByNode: { "qa-node": { kind: "resolved", sessionId: "qa-session" } },
  } as unknown as SnapshotData;
}

describe("independent saved-snapshot harness compatibility boundary", () => {
  it.each(cases)("$name: every reader preserves raw bytes and emits only the new session key", (test) => {
    const db = createDb(); dbs.push(db); migrate(db, [coreSchema, snapshotsSchema]);
    const repo = new SnapshotRepository(db);
    const raw = JSON.stringify(fixture(test), null, 2) + "\n";
    db.prepare("INSERT INTO snapshots(id, rig_id, kind, data, created_at) VALUES (?, ?, ?, ?, ?)")
      .run("qa-snapshot", "qa-rig", "auto-pre-down", raw, "2026-10-19 00:00:00");

    const exact = repo.selectRestoreUsable("qa-rig", "qa-snapshot");
    const automatic = repo.selectRestoreUsable("qa-rig");
    expect(exact.ok).toBe(true); expect(automatic.ok).toBe(true);
    const snapshots: Array<Snapshot | null | undefined> = [
      repo.getSnapshot("qa-snapshot"), repo.getLatestSnapshot("qa-rig"),
      repo.findLatestAutoPreDown("qa-rig"), repo.findLatestRestoreUsable("qa-rig"),
      ...repo.listSnapshots("qa-rig"),
      exact.ok ? exact.snapshot : null, automatic.ok ? automatic.snapshot : null,
      findLatestUsableSnapshot(db, "qa-rig"), findLatestUsableSnapshotsForAllRigs(db).get("qa-rig"),
    ];
    expect(snapshots).toHaveLength(9);
    for (const snapshot of snapshots) {
      expect(snapshot).toBeTruthy();
      const data = snapshot!.data;
      const session = data.sessions[0] as unknown as Record<string, unknown>;
      expect(session).not.toHaveProperty("agentApp");
      if (test.expected === undefined) expect([null, undefined]).toContain(session.communityHarness);
      else expect(session.communityHarness).toBe(test.expected);
      expect(communityHarnessOf(session.communityHarness as string | null | undefined, test.runtime)).toBe(test.positive);
      expect(session.resumeType).toBe("codex_id");
      expect(session.resumeToken).toBe("synthetic-old-token-never-contacted");
      expect(session.restorePolicy).toBe("resume_if_possible");
      expect(session.extension).toEqual({ marker: "preserve-extension" });
      expect(data.checkpoints).toEqual({ marker: "preserve-checkpoint" });
      expect(data.activeSessionIdByNode).toEqual({ "qa-node": "qa-session" });
      expect(data.activeOccupantsByNode).toEqual({ "qa-node": { kind: "resolved", sessionId: "qa-session" } });
      expect((JSON.parse(JSON.stringify(data)).sessions[0] as Record<string, unknown>)).not.toHaveProperty("agentApp");
    }
    expect((db.prepare("SELECT data FROM snapshots WHERE id = ?").get("qa-snapshot") as { data: string }).data).toBe(raw);

    const written = repo.createSnapshot("qa-rig", "manual", snapshots[0]!.data);
    const encoded = (db.prepare("SELECT data FROM snapshots WHERE id = ?").get(written.id) as { data: string }).data;
    const newSession = JSON.parse(encoded).sessions[0] as Record<string, unknown>;
    expect(newSession).not.toHaveProperty("agentApp");
    if (test.expected === undefined) expect([null, undefined]).toContain(newSession.communityHarness);
    else expect(newSession.communityHarness).toBe(test.expected);
    expect((db.prepare("SELECT data FROM snapshots WHERE id = ?").get("qa-snapshot") as { data: string }).data).toBe(raw);
  });
});
