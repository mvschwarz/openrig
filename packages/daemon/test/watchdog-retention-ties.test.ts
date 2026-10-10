import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { WatchdogHistoryLog } from "../src/domain/watchdog-history-log.js";
import { WatchdogJobsRepository } from "../src/domain/watchdog-jobs-repository.js";
import { WatchdogPolicyEngine } from "../src/domain/watchdog-policy-engine.js";
import { pruneWatchdogHistory } from "../src/domain/queue-retention.js";

describe("watchdog retention timestamp ties", () => {
  let db: Database.Database;
  let dir: string;
  let history: WatchdogHistoryLog;
  let jobs: WatchdogJobsRepository;
  const old = "2026-08-28T10:00:00.000Z";
  const nowIso = "2026-10-04T10:00:00.000Z";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "watchdog-retention-"));
    db = createDb(join(dir, "state.sqlite"));
    migrate(db, ALL_MIGRATIONS);
    history = new WatchdogHistoryLog(db);
    jobs = new WatchdogJobsRepository(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function register() {
    return jobs.register({ policy: "periodic-reminder", targetSession: "worker@rig",
      registeredBySession: "ops@rig", intervalSeconds: 60,
      specYaml: "policy: periodic-reminder\nmessage: owned reminder\n" });
  }

  it("retains the boundary pair produced by a real transcript binding and delivery", async () => {
    const transcript = join(dir, "owned.jsonl");
    writeFileSync(transcript, "owned transcript bytes");
    db.prepare("INSERT INTO rigs (id, name) VALUES ('rig', 'rig')").run();
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES ('node', 'rig', 'worker')").run();
    db.prepare("INSERT INTO sessions (id, node_id, session_name) VALUES ('session', 'node', 'worker@rig')").run();
    db.prepare(`INSERT INTO occupant_tenures (id, node_id, generation_ordinal, generation_uuid, kind, boot_at)
      VALUES ('tenure', 'node', 1, 'generation', 'initial', '2026-08-28T09:00:00.000Z')`).run();
    db.prepare(`INSERT INTO context_usage (node_id, session_id, session_name, availability, transcript_path, sampled_at)
      VALUES ('node', 'session', 'worker@rig', 'known', ?, '2026-08-28T09:00:01.000Z')`).run(transcript);
    const job = jobs.register({ policy: "context-usage-threshold", targetSession: "worker@rig",
      registeredBySession: "daemon@kernel", intervalSeconds: 60, thresholdBytes: 8,
      watchedFilePath: null,
      specYaml: "policy: context-usage-threshold\ngenerated_by: continuity-policy-materializer\ncontinuity_mode: managed-compaction\nmessage: owned wake\n" });
    const deliveries: string[] = [];
    const engine = new WatchdogPolicyEngine({ jobsRepo: jobs, historyLog: history,
      eventBus: new EventBus(db), now: () => new Date(old), resolveTargetGeneration: () => "generation",
      deliver: async request => { deliveries.push(request.targetSession); return { status: "ok" }; } });
    await engine.evaluate(job);
    expect(deliveries).toEqual(["worker@rig"]);
    const pair = history.listForJob(job.jobId);
    expect(pair).toHaveLength(2);
    expect(pair.map(row => row.evaluatedAt)).toEqual([old, old]);
    expect(pair.map(row => row.skipReason)).toContain("watched_file_bound");
    expect(pair.map(row => row.outcome)).toContain("sent");
    for (let i = 0; i < 49; i++) history.record({ jobId: job.jobId,
      evaluatedAt: new Date(Date.parse(old) + (i + 1) * 60_000).toISOString(), outcome: "skipped" });
    // The boundary pair belongs to one evaluation. The documented safe tie policy keeps both.
    expect(pruneWatchdogHistory(db, { nowIso }).deletedRows).toBe(0);
    db.close();
    db = createDb(join(dir, "state.sqlite"));
    history = new WatchdogHistoryLog(db);
    expect(history.countForJob(job.jobId)).toBe(51);
    expect(history.listForJob(job.jobId, 100).map(row => row.historyId))
      .toEqual(expect.arrayContaining(pair.map(row => row.historyId)));
  });

  it("prunes older ties once at least K strictly newer rows exist, without touching another job", () => {
    const job = register();
    const sibling = register();
    for (const evaluatedAt of [old, old, "2026-08-29T10:00:00.000Z", "2026-08-30T10:00:00.000Z"])
      history.record({ jobId: job.jobId, evaluatedAt, outcome: "skipped" });
    history.record({ jobId: sibling.jobId, evaluatedAt: old, outcome: "skipped" });
    expect(pruneWatchdogHistory(db, { nowIso, watchdogKeepPerJob: 2 }).deletedRows).toBe(2);
    expect(history.listForJob(job.jobId).map(row => row.evaluatedAt))
      .toEqual(["2026-08-30T10:00:00.000Z", "2026-08-29T10:00:00.000Z"]);
    expect(history.countForJob(sibling.jobId)).toBe(1);
  });

  it("honors zero retained rows, batch limits, and the age window", () => {
    const job = register();
    for (let i = 0; i < 3; i++) history.record({ jobId: job.jobId, evaluatedAt: old, outcome: "skipped" });
    history.record({ jobId: job.jobId, evaluatedAt: nowIso, outcome: "sent" });
    expect(pruneWatchdogHistory(db, { nowIso, watchdogKeepPerJob: 0, batchSize: 2 }).deletedRows).toBe(2);
    expect(pruneWatchdogHistory(db, { nowIso, watchdogKeepPerJob: 0 }).deletedRows).toBe(1);
    expect(history.listForJob(job.jobId)).toMatchObject([{ evaluatedAt: nowIso }]);
  });
});
