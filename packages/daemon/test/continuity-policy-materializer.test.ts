import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  armContinuityPolicy,
  materializeContinuityPolicy,
} from "../src/domain/continuity-policy-materializer.js";

const CLAUDE_SEAT = {
  compactionStrategy: "apprentice-handover" as const,
  runtime: "claude-code",
  targetSession: "advice-lead@rig",
  watchedFilePath: "/tmp/advice-lead.jsonl",
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

  it("positive-matches Claude only and leaves native/default modes unarmed", () => {
    expect(materializeContinuityPolicy({ ...CLAUDE_SEAT, runtime: "codex" }).jobs).toEqual([]);
    expect(materializeContinuityPolicy({ ...CLAUDE_SEAT, compactionStrategy: "default-compaction" }).jobs).toEqual([]);
    expect(materializeContinuityPolicy({ ...CLAUDE_SEAT, compactionStrategy: "handover" }).jobs).toEqual([]);
    expect(materializeContinuityPolicy({ ...CLAUDE_SEAT, compactionStrategy: "managed-compaction" }).jobs.length).toBeLessThanOrEqual(1);
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
