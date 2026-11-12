import { describe, expect, it } from "vitest";
import { PiCompactionService } from "../src/domain/pi-compaction-service.js";
import { DeliveryGuardError } from "../src/domain/seat-delivery-guard.js";
import { TerminalPolicyRefusal, type TerminalActor } from "../src/domain/terminal-policy.js";
import type { SendResult } from "../src/domain/session-transport.js";
import type { PiRunnerState } from "../src/adapters/pi-runner-protocol.js";

const seat = { nodeId: "node", sessionName: "pi@test", runtime: "pi" };
const start = Date.parse("2026-11-11T10:00:00Z");
type SendEffect = Pick<SendResult, "ok" | "sent" | "outcome" | "reason" | "inputPhase" | "error">;

function fixture(opts: {
  sidecar?: PiRunnerState | null;
  send?: (text: string, beforeWrite?: () => void) => Promise<SendEffect>;
  check?: (nodeId: string, action: "compaction", actor: TerminalActor) => void;
} = {}) {
  let time = start;
  let state: PiRunnerState | null = opts.sidecar === undefined
    ? { ready: true, launchId: "launch", updatedAt: new Date(time).toISOString() }
    : opts.sidecar;
  const sent: string[] = [];
  let beforeWrite: (() => void) | undefined;
  let attempt = 0;
  const service = new PiCompactionService({
    readSidecar: () => state,
    send: async (session, text, sendOpts) => {
      sent.push(`${session}:${text}`);
      beforeWrite = sendOpts.beforeWrite;
      return opts.send
        ? opts.send(text, sendOpts.beforeWrite)
        : { ok: true, sent: true, outcome: "rendered-unconfirmed" };
    },
    ...(opts.check ? { terminalPolicies: { check: opts.check } } : {}),
    now: () => time,
    newAttemptId: () => `attempt-${++attempt}`,
  });
  const update = (patch: Partial<PiRunnerState> | null) => {
    state = patch === null ? null : { ready: true, launchId: "launch", updatedAt: new Date(time + 1).toISOString(), ...patch };
  };
  return { service, sent, update, attemptId: () => `attempt-${attempt}`, beforeWrite: () => beforeWrite,
    advance: () => { time += 1000; } };
}

describe("PiCompactionService", () => {
  it.each(["omp", "claude-code", "codex", null])("rejects runtime %s before any send", async runtime => {
    const f = fixture();
    expect(await f.service.trigger({ ...seat, runtime })).toMatchObject({ triggered: false, reason: "runtime_filter" });
    expect(f.sent).toEqual([]);
  });

  it("sends the reserved input and its attempt id through the guarded send path", async () => {
    const f = fixture();
    const result = await f.service.trigger(seat);
    expect(result).toEqual({ triggered: true, attemptId: "attempt-1", stage: "submitted_unconfirmed" });
    // One write to the seat's own session, carrying the id the runner stamps back.
    expect(f.sent).toEqual(["pi@test:/openrig-compact attempt-1"]);
    expect(f.beforeWrite()).toBeTypeOf("function");
    // Submission is not completion: no record yet reads uncertain for this attempt.
    expect(f.service.getState(seat.sessionName)).toMatchObject({ status: "uncertain",
      phase: "submitted_no_result", attemptId: "attempt-1" });
  });

  it("reports a held send as not started, with no attempt to track", async () => {
    const f = fixture({ send: async () => ({ ok: true, sent: false, outcome: "retained", reason: "typing_guard_enabled" }) });
    expect(await f.service.trigger(seat)).toMatchObject({ triggered: false, reason: "held" });
    expect(f.service.getState(seat.sessionName)).toMatchObject({ status: "not_requested", attemptId: null });
  });

  it("reports input that may have been written as uncertain, never was-not-started", async () => {
    const f = fixture({ send: async () => ({ ok: false, sent: true, inputPhase: "written", reason: "submit_failed" }) });
    expect(await f.service.trigger(seat)).toEqual({ triggered: true, attemptId: "attempt-1", stage: "uncertain" });
    expect(f.service.getState(seat.sessionName)).toMatchObject({ status: "uncertain",
      phase: "submitted_no_result", attemptId: "attempt-1" });
  });

  it("treats an indeterminate write as an uncertain attempt, not a pre-input refusal", async () => {
    const f = fixture({ send: async () => ({ ok: false, outcome: "failed", reason: "delivery_indeterminate" }) });
    expect(await f.service.trigger(seat)).toEqual({ triggered: true, attemptId: "attempt-1", stage: "uncertain" });
    expect(f.service.getState(seat.sessionName)).toMatchObject({ status: "uncertain",
      phase: "submitted_no_result", attemptId: "attempt-1" });
  });

  it("keeps the guard's pre-input reason when nothing was written", async () => {
    const f = fixture({ send: async () => ({ ok: false, sent: false, inputPhase: "not_reached", reason: "target_needs_input" }) });
    expect(await f.service.trigger(seat)).toMatchObject({ triggered: false, reason: "target_needs_input" });
    expect(f.service.getState(seat.sessionName)).toMatchObject({ status: "not_requested" });
  });

  it("turns a guarded send that throws after a write into an uncertain attempt", async () => {
    const f = fixture({ send: async () => {
      throw Object.assign(new DeliveryGuardError("launch_changed", "The runner launch changed."), { inputWritten: true });
    } });
    expect(await f.service.trigger(seat)).toEqual({ triggered: true, attemptId: "attempt-1", stage: "uncertain" });
    expect(f.service.getState(seat.sessionName)).toMatchObject({ status: "uncertain", attemptId: "attempt-1" });
  });

  it("keeps a guard refusal that throws before any write", async () => {
    const f = fixture({ send: async () => { throw new DeliveryGuardError("launch_changed", "The runner launch changed."); } });
    expect(await f.service.trigger(seat)).toMatchObject({ triggered: false, reason: "launch_changed" });
    expect(f.service.getState(seat.sessionName)).toMatchObject({ status: "not_requested" });
  });

  it("refuses a second request while a run has started and not ended", async () => {
    const f = fixture({ sidecar: { ready: true, launchId: "launch", updatedAt: "old",
      compaction: { attemptId: "attempt-0", startedAt: new Date(start).toISOString() } } });
    expect(await f.service.trigger(seat)).toMatchObject({ triggered: false, reason: "already_in_progress" });
    expect(f.sent).toEqual([]);
  });

  it("refuses a second request while the first is still unconfirmed", async () => {
    const f = fixture();
    await f.service.trigger(seat);
    expect(await f.service.trigger(seat)).toMatchObject({ triggered: false, reason: "already_in_progress" });
    expect(f.sent).toHaveLength(1);
  });

  it("refuses retry after an unsupported compact RPC", async () => {
    const f = fixture({ sidecar: { ready: true, launchId: "launch", updatedAt: "old",
      compaction: { attemptId: "attempt-0", reason: "manual", endedAt: new Date(start).toISOString(), errorMessage: "Unknown command: compact" } } });
    expect(f.service.getState(seat.sessionName)).toMatchObject({ status: "unsupported", attemptId: "attempt-0" });
    expect(await f.service.trigger(seat)).toMatchObject({ triggered: false, reason: "unsupported" });
    expect(f.sent).toEqual([]);
  });

  it("never lets an automatic completion answer the request", async () => {
    const f = fixture();
    await f.service.trigger(seat);
    f.update({ compaction: { reason: "threshold", endedAt: new Date(start).toISOString() } });
    expect(f.service.getState(seat.sessionName)).toMatchObject({ status: "uncertain",
      phase: "submitted_no_result", attemptId: "attempt-1",
      automatic: { reason: "threshold" } });
  });

  it("never lets an earlier request's completion answer a new one", async () => {
    const f = fixture({ sidecar: { ready: true, launchId: "launch", updatedAt: "old",
      compaction: { attemptId: "attempt-old", reason: "manual", endedAt: new Date(start).toISOString() } } });
    expect(await f.service.trigger(seat)).toMatchObject({ triggered: true, attemptId: "attempt-1" });
    expect(f.service.getState(seat.sessionName)).toMatchObject({ status: "uncertain",
      phase: "submitted_no_result", attemptId: "attempt-1", automatic: null });
  });

  it("reports a start with no end as uncertain", async () => {
    const f = fixture();
    await f.service.trigger(seat);
    f.update({ compaction: { attemptId: "attempt-1", reason: "manual", startedAt: new Date(start).toISOString() } });
    expect(f.service.getState(seat.sessionName)).toMatchObject({ status: "uncertain",
      phase: "started_no_end", attemptId: "attempt-1", startedAt: new Date(start).toISOString() });
  });

  it("reports the matching attempt's terminal outcome", async () => {
    const f = fixture();
    await f.service.trigger(seat);
    const endedAt = new Date(start).toISOString();
    f.update({ compaction: { attemptId: "attempt-1", reason: "manual", startedAt: endedAt, endedAt,
      result: { summary: "done" }, aborted: false } });
    expect(f.service.getState(seat.sessionName)).toMatchObject({ status: "completed", attemptId: "attempt-1",
      startedAt: endedAt, endedAt, result: { summary: "done" }, aborted: false });
  });

  it.each([
    { compaction: { errorMessage: "Nothing to compact" }, status: "failed" },
    { compaction: { aborted: true }, status: "aborted" },
    { compaction: { errorMessage: "Unknown command: compact" }, status: "unsupported" },
  ] as const)("reports %j as $status", ({ compaction, status }) => {
    const f = fixture({ sidecar: { ready: true, launchId: "launch", updatedAt: "old",
      compaction: { attemptId: "attempt-restart", reason: "manual", endedAt: new Date(start).toISOString(), ...compaction } } });
    // No in-memory request: the sidecar's own attempt id still names the run after a daemon restart.
    expect(f.service.getState(seat.sessionName)).toMatchObject({ status, attemptId: "attempt-restart" });
  });

  it("checks the carried launch at the write and at Enter", async () => {
    const f = fixture();
    await f.service.trigger(seat);
    const check = f.beforeWrite();
    expect(check).toBeTypeOf("function");
    f.update({ launchId: "replacement" });
    expect(() => check?.()).toThrow(DeliveryGuardError);
  });

  it("applies the caller's terminal-policy actor to the Pi operation", async () => {
    const check = (_nodeId: string, _action: "compaction", actor: TerminalActor) => {
      if (actor.source === "caller" && actor.session === "stranger@pi-rig") throw new TerminalPolicyRefusal("peer", "compaction");
    };
    const denied = fixture({ check });
    expect(await denied.service.trigger(seat, { source: "caller", session: "stranger@pi-rig" }))
      .toMatchObject({ triggered: false, reason: "terminal_policy_refused" });
    expect(denied.sent).toEqual([]);
    // Self and unattributed callers keep today's behaviour.
    expect(await fixture({ check }).service.trigger(seat, { source: "caller", session: "pi@test" }))
      .toMatchObject({ triggered: true });
    expect(await fixture({ check }).service.trigger(seat, { source: "caller", session: null }))
      .toMatchObject({ triggered: true });
  });

  it("refuses when the policy schema is unavailable for an attributed caller", async () => {
    const f = fixture({ check: () => { throw new Error("no schema"); } });
    expect(await f.service.trigger(seat, { source: "caller", session: "pi@test" }))
      .toMatchObject({ triggered: false, reason: "terminal_policy_unavailable" });
    expect(f.sent).toEqual([]);
  });

  it("allows a new request after the previous one completed", async () => {
    const f = fixture();
    await f.service.trigger(seat);
    const endedAt = new Date(start).toISOString();
    f.update({ compaction: { attemptId: "attempt-1", reason: "manual", startedAt: endedAt, endedAt } });
    expect(await f.service.trigger(seat)).toMatchObject({ triggered: true, attemptId: "attempt-2" });
    expect(f.sent).toHaveLength(2);
  });
});
