import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { EventBus } from "../src/domain/event-bus.js";
import { deriveRestoreAttemptReceipt } from "../src/domain/restore-attempt-receipt.js";

describe("deriveRestoreAttemptReceipt", () => {
  let db: Database.Database;
  let events: EventBus;

  beforeEach(() => {
    db = createFullTestDb();
    events = new EventBus(db);
  });

  afterEach(() => db.close());

  it("preserves the original partial result while deriving operator-completed intended-set truth", () => {
    const started = events.emit({
      type: "restore.started",
      rigId: "rig-1",
      snapshotId: "snap-manual",
      snapshotSelection: {
        snapshotId: "snap-manual",
        kind: "manual",
        createdAt: "2026-09-04 00:00:00",
        ageMs: 1000,
        mode: "explicit",
        rationale: "operator selected this exact restore-usable snapshot",
        newerUsableAlternative: null,
      },
      intendedRoster: [
        { nodeId: "n1", logicalId: "lead" },
        { nodeId: "n2", logicalId: "worker" },
      ],
      excludedNodes: [{ nodeId: "old", logicalId: "historical", reason: "historical_not_in_intended_roster" }],
    });
    events.emit({
      type: "restore.completed",
      rigId: "rig-1",
      snapshotId: "snap-manual",
      result: {
        snapshotId: "snap-manual",
        preRestoreSnapshotId: "pre",
        rigResult: "partially_restored",
        nodes: [
          { nodeId: "n1", logicalId: "lead", status: "resumed" },
          { nodeId: "n2", logicalId: "worker", status: "attention_required" },
        ],
        warnings: [],
      },
    });
    events.emit({
      type: "restore.outcome_reconciled",
      rigId: "rig-1",
      nodeId: "n2",
      attemptId: started.seq,
      from: "attention_required",
      to: "operator_recovered",
      evidence: { tmux: true, fgProcess: "codex", resumeTokenUsed: true, paneState: "usable" },
    });

    const receipt = deriveRestoreAttemptReceipt(db, "rig-1", started.seq);

    expect(receipt.ok).toBe(true);
    if (!receipt.ok) return;
    expect(receipt.originalResult.rigResult).toBe("partially_restored");
    expect(receipt.originalResult.nodes[1]!.status).toBe("attention_required");
    expect(receipt.reconciliations).toHaveLength(1);
    expect(receipt.currentNodes[1]!.status).toBe("operator_recovered");
    expect(receipt.unresolvedIntendedSeats).toEqual([]);
    expect(receipt.currentIntendedSetVerdict).toBe("fully_restored");
    expect(receipt.excludedNodes).toEqual([expect.objectContaining({ logicalId: "historical" })]);
  });

  it("does not let a later attempt supply this attempt's completion", () => {
    const first = events.emit({ type: "restore.started", rigId: "rig-1", snapshotId: "s1" });
    events.emit({ type: "restore.started", rigId: "rig-1", snapshotId: "s2" });
    events.emit({
      type: "restore.completed",
      rigId: "rig-1",
      snapshotId: "s2",
      result: { snapshotId: "s2", preRestoreSnapshotId: null, rigResult: "fully_restored", nodes: [], warnings: [] },
    });

    expect(deriveRestoreAttemptReceipt(db, "rig-1", first.seq)).toMatchObject({ ok: false, code: "attempt_incomplete" });
  });

  it("keeps an intended seat with no node result visible as unresolved", () => {
    const started = events.emit({
      type: "restore.started",
      rigId: "rig-1",
      snapshotId: "s1",
      intendedRoster: [{ nodeId: "n1", logicalId: "lead" }],
    });
    events.emit({
      type: "restore.completed",
      rigId: "rig-1",
      snapshotId: "s1",
      result: { snapshotId: "s1", preRestoreSnapshotId: null, rigResult: "fully_restored", nodes: [], warnings: [] },
    });

    const receipt = deriveRestoreAttemptReceipt(db, "rig-1", started.seq);

    expect(receipt.ok).toBe(true);
    if (!receipt.ok) return;
    expect(receipt.currentIntendedSetVerdict).toBe("failed");
    expect(receipt.unresolvedIntendedSeats).toEqual([
      expect.objectContaining({ nodeId: "n1", logicalId: "lead", status: "failed" }),
    ]);
  });
});
