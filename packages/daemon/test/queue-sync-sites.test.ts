import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository, createLinkedSuccessorLookup } from "../src/domain/queue-repository.js";
import { configureSyncSiteRecorder, runSyncSiteWhenSlow } from "../src/domain/sync-site-wrap.js";

// The queue's synchronous reads named in the slow-operation log, so an event-loop stall during one is attributed to it.
// A fake recorder takes every call; the real recorder's slow threshold is pinned in slow-op-recorder.test.ts.
describe("queue reads named in the slow-operation log", () => {
  let db: Database.Database;
  let repo: QueueRepository;
  const sync: string[] = [];
  const slow: Array<{ site: string; outcome: string }> = [];
  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    repo = new QueueRepository(db, new EventBus(db));
    configureSyncSiteRecorder({
      runSync<T>(site: string, fn: () => T): T { sync.push(site); return fn(); },
      recordSlowSync(site: string, _durationMs: number, outcome: "ok" | "failed"): void { slow.push({ site, outcome }); },
    });
  });
  afterEach(() => { configureSyncSiteRecorder(undefined); sync.length = 0; slow.length = 0; db.close(); });

  it("names a handoff", async () => {
    const source = await repo.create({ sourceSession: "planner@r", destinationSession: "relay@r", body: "work", nudge: false });
    sync.length = 0;
    const { created } = await repo.handoff({ qitemId: source.qitemId, fromSession: "relay@r", toSession: "worker@r", nudge: false });
    expect(created.destinationSession).toBe("worker@r");
    expect(sync).toContain("queue.handoff");
  });

  it("names decisionRevision's reply read through the slow-only site, once per revision", async () => {
    const ask = await repo.create({ sourceSession: "planner@r", destinationSession: "relay@r", body: "work", nudge: false });
    slow.length = 0;
    const revision = repo.decisionRevision(repo.getById(ask.qitemId)!);
    expect(typeof revision).toBe("string");
    expect(slow).toEqual([{ site: "queue.decision_revision.replies", outcome: "ok" }]);
  });

  it("names the stuck sweep's linked-successor build when it is built", () => {
    const lookup = createLinkedSuccessorLookup(db, ["qitem-source"]);
    expect(sync).toEqual([]);
    expect(lookup.has("qitem-source", "worker@r")).toBe(false);
    expect(lookup.has("qitem-source", "other@r")).toBe(false);
    expect(sync).toEqual(["queue.linked_successors.build"]);
  });

  it("keeps the wrapped call's result and error, and records each outcome", () => {
    expect(runSyncSiteWhenSlow("test.site", () => 7)).toBe(7);
    expect(() => runSyncSiteWhenSlow("test.site", () => { throw new Error("read failed"); })).toThrow("read failed");
    expect(slow).toEqual([{ site: "test.site", outcome: "ok" }, { site: "test.site", outcome: "failed" }]);
  });

  it("never lets a failing record replace the wrapped call's result", () => {
    configureSyncSiteRecorder({ recordSlowSync(): void { throw new Error("recorder gone"); } });
    expect(runSyncSiteWhenSlow("test.site", () => "value")).toBe("value");
    expect(() => runSyncSiteWhenSlow("test.site", () => { throw new Error("read failed"); })).toThrow("read failed");
  });

  it("runs the call bare when no recorder is configured", () => {
    configureSyncSiteRecorder(undefined);
    expect(runSyncSiteWhenSlow("test.site", () => "bare")).toBe("bare");
    expect(slow).toEqual([]);
  });
});
