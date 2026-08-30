import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import {
  armContinuityPolicy,
  createContinuityCutoverBaton,
  materializeContinuityPolicy,
  recordManagedWidthReceipt,
} from "../src/domain/continuity-policy-materializer.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { WatchdogHistoryLog } from "../src/domain/watchdog-history-log.js";
import { WatchdogJobsRepository } from "../src/domain/watchdog-jobs-repository.js";
import { parseWatchdogSpec } from "../src/domain/watchdog-policy-engine.js";

const CLAUDE_SEAT = {
  compactionStrategy: "apprentice-handover" as const,
  runtime: "claude-code",
  targetSession: "advice-lead@rig",
  watchedFilePath: "/tmp/advice-lead.jsonl",
  mechanic: "operator-agent@kernel",
};

describe("continuity policy materializer (S20 P4)", () => {
  it("materializes the apprentice strategy as exactly two calibrated watchdog registrations", () => {
    const plan = materializeContinuityPolicy(CLAUDE_SEAT);

    expect(plan.jobs).toHaveLength(2);
    expect(plan.jobs.every((job) => job.policy === "context-usage-threshold")).toBe(true);
    expect(plan.jobs.map((job) => job.key)).toEqual(["prepare", "cutover"]);
    expect(plan.jobs[1]?.requiresKey).toBe("prepare");
    expect(plan.jobs[0]!.thresholdBytes).toBeLessThan(plan.jobs[1]!.thresholdBytes);
    expect(plan.jobs[0]!.thresholdBytes).toBeGreaterThan(0);
    expect(plan.docText).toMatch(/113K–153K tokens\/MB/);
    expect(plan.docText).toMatch(/margin is the protection/i);
  });

  it("turns the symbolic requires rung into the first durable job id", () => {
    const register = vi
      .fn()
      .mockReturnValueOnce({ jobId: "prepare-job" })
      .mockReturnValueOnce({ jobId: "cutover-job" });

    const armed = armContinuityPolicy(CLAUDE_SEAT, { register });

    expect(armed.map((job) => job.jobId)).toEqual(["prepare-job", "cutover-job"]);
    expect(register).toHaveBeenCalledTimes(2);
    expect(register.mock.calls[0]![0]).toMatchObject({
      policy: "context-usage-threshold",
      requiresJobId: null,
    });
    expect(register.mock.calls[1]![0]).toMatchObject({
      policy: "context-usage-threshold",
      requiresJobId: "prepare-job",
    });
  });

  it("reuses one complete nonterminal materialized pair instead of duplicating it on relaunch", () => {
    const register = vi.fn();
    const existing = [
      {
        jobId: "prepare-job",
        state: "active" as const,
        specYaml: "generated_by: continuity-policy-materializer",
        requiresJobId: null,
      },
      {
        jobId: "cutover-job",
        state: "stopped" as const,
        specYaml: "generated_by: continuity-policy-materializer",
        requiresJobId: "prepare-job",
      },
    ];

    expect(armContinuityPolicy(CLAUDE_SEAT, {
      register,
      listExactTuple: () => existing,
    }).map((job) => job.jobId)).toEqual(["prepare-job", "cutover-job"]);
    expect(register).not.toHaveBeenCalled();
  });

  it("serializes both fire notices through the watchdog engine's actual spec parser", () => {
    const parsed = materializeContinuityPolicy(CLAUDE_SEAT).jobs.map(
      (job) => parseWatchdogSpec(job.specYaml),
    );
    const messages = parsed.map((spec) => spec.message);

    expect(messages[0]).toContain("continuity/apprentice-prepare.md");
    expect(messages[1]).toContain("continuity/apprentice-cutover.md");
    expect(messages.every((message) => message !== "|")).toBe(true);
    expect(parsed[1]?.context).toMatchObject({
      continuity_action: {
        type: "create-cutover-baton",
        destination: "operator-agent@kernel",
        body: expect.stringContaining("authority-effective-at-effect-receipt"),
      },
    });
  });

  it("arms managed compaction as exactly one real prep-nudge registration", () => {
    const plan = materializeContinuityPolicy({
      ...CLAUDE_SEAT,
      compactionStrategy: "managed-compaction",
      mechanic: undefined,
    });

    expect(plan.jobs).toHaveLength(1);
    expect(plan.jobs[0]).toMatchObject({
      key: "prepare",
      requiresKey: null,
      policy: "context-usage-threshold",
    });
    const parsed = parseWatchdogSpec(plan.jobs[0]!.specYaml);
    expect(parsed.message).toMatch(/deposit-before-compaction|recap-write/i);
    expect(parsed.context).not.toHaveProperty("continuity_action");
    expect(plan.docText).toMatch(/113K–153K tokens\/MB/);
    expect(plan.docText).toMatch(/retun/i);
  });

  it("registers generated jobs as pending when the first transcript sample has not arrived", () => {
    const apprentice = materializeContinuityPolicy({
      ...CLAUDE_SEAT,
      watchedFilePath: null,
    });
    const managed = materializeContinuityPolicy({
      ...CLAUDE_SEAT,
      compactionStrategy: "managed-compaction",
      mechanic: undefined,
      watchedFilePath: null,
    });

    expect(apprentice.jobs).toHaveLength(2);
    expect(managed.jobs).toHaveLength(1);
    expect([...apprentice.jobs, ...managed.jobs].every((job) => job.watchedFilePath === null)).toBe(true);
  });

  it("creates one generation-keyed QueueRepository baton across a delivery retry", async () => {
    const db = new Database(":memory:");
    try {
      migrate(db, ALL_MIGRATIONS);
      const queue = new QueueRepository(db, new EventBus(db), { validateRig: () => true });
      const action = {
        type: "create-cutover-baton" as const,
        jobId: "cutover-job",
        occupantGeneration: "target-generation-7",
        sourceSession: "target@rig",
        destination: "mechanic@kernel",
        body: "Owned cutover baton; one-active-walker; authority-effective-at-effect-receipt.",
      };

      const first = await createContinuityCutoverBaton(action, queue);
      const retry = await createContinuityCutoverBaton(action, queue);

      expect(retry.qitemId).toBe(first.qitemId);
      expect(queue.getById(first.qitemId)).toMatchObject({
        sourceSession: "target@rig",
        destinationSession: "mechanic@kernel",
        body: expect.stringContaining("authority-effective-at-effect-receipt"),
      });
      expect((db.prepare("SELECT COUNT(*) AS n FROM queue_items WHERE qitem_id = ?")
        .get(first.qitemId) as { n: number }).n).toBe(1);
    } finally {
      db.close();
    }
  });

  it("writes a saturation-honest managed width receipt on its S06 job and target generation", () => {
    const db = new Database(":memory:");
    try {
      migrate(db, ALL_MIGRATIONS);
      const jobs = new WatchdogJobsRepository(db, undefined, () => "target-generation-7");
      const history = new WatchdogHistoryLog(db);
      const job = jobs.register({
        policy: "context-usage-threshold",
        specYaml:
          "policy: context-usage-threshold\n" +
          "generated_by: continuity-policy-materializer\n" +
          "continuity_mode: managed-compaction\n" +
          "target:\n  session: target@rig\n" +
          "message: Deposit continuity context before managed compaction.\n",
        targetSession: "target@rig",
        intervalSeconds: 60,
        registeredBySession: "daemon@kernel",
        watchedFilePath: "/tmp/target.jsonl",
        thresholdBytes: 8,
      });

      const result = recordManagedWidthReceipt({
        sessionName: "target@rig",
        occupantGeneration: "target-generation-7",
        postRestoreUsedPercentage: 93,
        saturationBoundPercentage: 80,
        evaluatedAt: "2026-08-30T02:00:00.000Z",
      }, jobs, history);

      expect(result).toMatchObject({
        jobId: job.jobId,
        receipt: {
          postRestoreUsableWidthPercentage: 7,
          widthRecovered: false,
          reason: "restore_replayed_past_saturation_bound",
        },
      });
      expect(history.listForJob(job.jobId)).toEqual([
        expect.objectContaining({
          outcome: "skipped",
          skipReason: "post_restore_width_receipt",
          evaluationNotes: expect.objectContaining({
            occupantGeneration: "target-generation-7",
            widthRecovered: false,
            reason: "restore_replayed_past_saturation_bound",
          }),
        }),
      ]);
    } finally {
      db.close();
    }
  });

  it("leaves non-managed compaction alone when no S06 receipt key exists", () => {
    const record = vi.fn();
    expect(recordManagedWidthReceipt({
      sessionName: "default-seat@rig",
      occupantGeneration: "generation-1",
      postRestoreUsedPercentage: 20,
      saturationBoundPercentage: 80,
    }, {
      register: vi.fn(),
      listExactTuple: () => [],
    }, { record })).toBeNull();
    expect(record).not.toHaveBeenCalled();
  });

  it("refuses apprentice arming without a declared mechanic and teaches the exact repair", () => {
    expect(() => materializeContinuityPolicy({
      ...CLAUDE_SEAT,
      mechanic: undefined,
    })).toThrow(/mechanic.*spec-default.*profile.*member.*continuity\/apprentice-cutover\.md/i);
  });

  it("positive-matches Claude only and leaves native/default modes unarmed", () => {
    expect(materializeContinuityPolicy({ ...CLAUDE_SEAT, runtime: "codex" }).jobs).toEqual([]);
    expect(materializeContinuityPolicy({ ...CLAUDE_SEAT, compactionStrategy: "default-compaction" }).jobs).toEqual([]);
    expect(materializeContinuityPolicy({ ...CLAUDE_SEAT, compactionStrategy: "handover" }).jobs).toEqual([]);
    expect(materializeContinuityPolicy({ ...CLAUDE_SEAT, compactionStrategy: "managed-compaction" }).jobs).toHaveLength(1);
  });

  it("adds registration glue only, never a second timer, scheduler, or engine", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "../src/domain/continuity-policy-materializer.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/setInterval|setTimeout|new\s+\w*Scheduler|cron/i);
    expect(source).toMatch(/jobsRepository\.register|registrar\.register/);
  });
});
