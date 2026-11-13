import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiCompactionService } from "../src/domain/pi-compaction-service.js";
import { PiCompactionRequestStore } from "../src/domain/pi-compaction-request-store.js";
import { DeliveryGuardError } from "../src/domain/seat-delivery-guard.js";
import { TerminalPolicyRefusal, type TerminalActor } from "../src/domain/terminal-policy.js";
import type { SendResult } from "../src/domain/session-transport.js";
import type { PiRunnerState } from "../src/adapters/pi-runner-protocol.js";

const seat = { nodeId: "node", sessionName: "pi@test", runtime: "pi" };
const start = Date.parse("2026-11-11T10:00:00Z");
type SendEffect = Pick<SendResult, "ok" | "sent" | "outcome" | "reason" | "inputPhase" | "error">;
type SendOptsSeen = { beforeWrite?: () => void; waitForIdleMs?: number; allowUnknownWhileIdle?: true };

function fixture(opts: {
  sidecar?: PiRunnerState | null;
  send?: (text: string, opts: SendOptsSeen) => Promise<SendEffect>;
  check?: (nodeId: string, action: "compaction", actor: TerminalActor) => void;
  requestStore?: Pick<PiCompactionRequestStore, "get" | "set" | "delete">;
} = {}) {
  let time = start;
  let state: PiRunnerState | null = opts.sidecar === undefined
    ? { ready: true, launchId: "launch", updatedAt: new Date(time).toISOString() }
    : opts.sidecar;
  const sent: string[] = [];
  const sentOpts: SendOptsSeen[] = [];
  let beforeWrite: (() => void) | undefined;
  let attempt = 0;
  const service = new PiCompactionService({
    readSidecar: () => state,
    send: async (session, text, sendOpts) => {
      sent.push(`${session}:${text}`);
      sentOpts.push(sendOpts);
      beforeWrite = sendOpts.beforeWrite;
      return opts.send
        ? opts.send(text, sendOpts)
        : { ok: true, sent: true, outcome: "rendered-unconfirmed" };
    },
    ...(opts.check ? { terminalPolicies: { check: opts.check } } : {}),
    ...(opts.requestStore ? { requestStore: opts.requestStore } : {}),
    now: () => time,
    newAttemptId: () => `attempt-${++attempt}`,
  });
  const update = (patch: Partial<PiRunnerState> | null) => {
    state = patch === null ? null : { ready: true, launchId: "launch", updatedAt: new Date(time + 1).toISOString(), ...patch };
  };
  return { service, sent, sentOpts, update, state: () => state, attemptId: () => `attempt-${attempt}`, beforeWrite: () => beforeWrite,
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

  it("lets a new request go while an earlier attempt is unresolved", async () => {
    const f = fixture();
    await f.service.trigger(seat);
    // The earlier attempt has no record yet: it still reads uncertain, but no longer holds the seat.
    expect(f.service.getState(seat.sessionName)).toMatchObject({ status: "uncertain", attemptId: "attempt-1" });
    expect(await f.service.trigger(seat)).toMatchObject({ triggered: true, attemptId: "attempt-2" });
    expect(f.sent).toHaveLength(2);
  });

  it("holds B while A awaits Pi's response, then permits retry once Pi answers", async () => {
    // Given A reached the runner's compact RPC but has no response yet.
    const f = fixture();
    await f.service.trigger(seat);
    f.update({ pendingCompaction: { attemptId: "attempt-1", requestedAt: "now" } });
    // When B is requested before A's response.
    expect(await f.service.trigger(seat)).toMatchObject({ triggered: false, reason: "already_in_progress" });
    expect(f.sent).toHaveLength(1);
    expect(f.service.getState(seat.sessionName)).toMatchObject({ status: "uncertain", attemptId: "attempt-1" });
    // Then Pi's answer releases the hold, even if no completion event was observed.
    f.update({});
    expect(await f.service.trigger(seat)).toMatchObject({ triggered: true, attemptId: "attempt-2" });
  });

  it("sends after a daemon restart while the prior attempt reads uncertain", async () => {
    const f = fixture({ sidecar: { ready: true, launchId: "launch", updatedAt: "old",
      compaction: { attemptId: "attempt-old", reason: "manual" } } });
    expect(f.service.getState(seat.sessionName)).toMatchObject({ status: "uncertain", phase: "submitted_no_result",
      attemptId: "attempt-old" });
    expect(await f.service.trigger(seat)).toMatchObject({ triggered: true, attemptId: "attempt-1" });
    expect(f.sent).toHaveLength(1);
  });

  it("sends once when two calls arrive before the first send resolves", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const f = fixture({ send: async () => { await gate; return { ok: true, sent: true, outcome: "rendered-unconfirmed" }; } });
    const first = f.service.trigger(seat);
    const second = f.service.trigger(seat);
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toMatchObject({ triggered: true, attemptId: "attempt-1" });
    // The second caller gets the first one's attempt id; only one control was sent.
    expect(b).toMatchObject({ triggered: true, attemptId: "attempt-1" });
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
  it("keeps a requested completion when a later automatic run replaces the one record", async () => {
    const f = fixture();
    await f.service.trigger(seat);
    const endedAt = new Date(start).toISOString();
    const requested = { attemptId: "attempt-1", reason: "manual", startedAt: endedAt, endedAt, result: { summary: "done" } };
    f.update({ compaction: requested, requestedCompaction: requested });
    expect(f.service.getState(seat.sessionName)).toMatchObject({ status: "completed", attemptId: "attempt-1" });
    // Pi's next automatic run replaces `compaction`; the request's record stays beside it.
    f.update({ compaction: { reason: "threshold", startedAt: endedAt }, requestedCompaction: requested });
    expect(f.service.getState(seat.sessionName)).toMatchObject({ status: "completed",
      attemptId: "attempt-1", automatic: { reason: "threshold" } });
    f.update({ compaction: { reason: "threshold", startedAt: endedAt, endedAt }, requestedCompaction: requested });
    expect(f.service.getState(seat.sessionName)).toMatchObject({ status: "completed", attemptId: "attempt-1",
      automatic: { reason: "threshold", endedAt } });
  });

  it("reads the newest pending attempt as uncertain after a restart, never an older completion", () => {
    const sidecar: PiRunnerState = { ready: true, launchId: "launch", updatedAt: "now",
      compaction: { attemptId: "attempt-A", reason: "manual", startedAt: "t0", endedAt: "t1" },
      requestedCompaction: { attemptId: "attempt-A", reason: "manual", startedAt: "t0", endedAt: "t1" },
      pendingCompaction: { attemptId: "attempt-B", requestedAt: "t2" } };
    // A new service over the same sidecar: its in-memory request is gone, as after a daemon restart.
    const service = new PiCompactionService({
      readSidecar: () => sidecar,
      send: async () => ({ ok: true, sent: true, outcome: "rendered-unconfirmed" }),
    });
    expect(service.getState(seat.sessionName)).toMatchObject({ status: "uncertain",
      phase: "submitted_no_result", attemptId: "attempt-B" });
  });

  it("asks the transport for its bounded idle wait and surfaces its not-idle refusal", async () => {
    const f = fixture({ send: async () => ({ ok: false, sent: false, inputPhase: "not_reached",
      reason: "wait_for_idle_timeout", error: "Target was still busy (working) when the 15000ms wait ended. No text was sent." }) });
    expect(await f.service.trigger(seat)).toMatchObject({ triggered: false, reason: "wait_for_idle_timeout" });
    // No control was written: the transport refused before any input, with its own reason.
    expect(f.sentOpts.at(-1)).toMatchObject({ waitForIdleMs: 15_000, allowUnknownWhileIdle: true });
    expect(f.service.getState(seat.sessionName)).toMatchObject({ status: "not_requested", attemptId: null });
  });
  it("keeps the earlier uncertain request when a retry is refused before input", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-compaction-refused-"));
    try {
      const store = new PiCompactionRequestStore(join(dir, "requests"));
      let sends = 0;
      const f = fixture({ requestStore: store, send: async () => {
        sends += 1;
        return sends === 3
          ? { ok: true, sent: false, outcome: "retained", reason: "typing_guard_enabled" }
          : { ok: true, sent: true, outcome: "rendered-unconfirmed" };
      } });
      // Given A completed.
      await f.service.trigger(seat);
      const endedAt = new Date(start).toISOString();
      const completed = { attemptId: "attempt-1", reason: "manual", startedAt: endedAt, endedAt, result: { summary: "done" } };
      f.update({ compaction: completed, requestedCompaction: completed });
      expect(f.service.getState(seat.sessionName)).toMatchObject({ status: "completed", attemptId: "attempt-1" });
      // When B is written without Enter, so it stays uncertain.
      await f.service.trigger(seat);
      expect(f.service.getState(seat.sessionName)).toMatchObject({ status: "uncertain", attemptId: "attempt-2" });
      // And the person retries with C, refused before any input.
      expect(await f.service.trigger(seat)).toMatchObject({ triggered: false, reason: "held" });
      // Then B is still the current request.
      expect(f.service.getState(seat.sessionName)).toMatchObject({ status: "uncertain",
        phase: "submitted_no_result", attemptId: "attempt-2" });
      // And it survives a recreated store and service.
      const restarted = new PiCompactionService({ readSidecar: f.state,
        requestStore: new PiCompactionRequestStore(join(dir, "requests")),
        send: async () => ({ ok: true, sent: true, outcome: "rendered-unconfirmed" }) });
      expect(restarted.getState(seat.sessionName)).toMatchObject({ status: "uncertain",
        phase: "submitted_no_result", attemptId: "attempt-2" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads a saved request as uncertain when the status file is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-compaction-missing-status-"));
    try {
      const store = new PiCompactionRequestStore(join(dir, "requests"));
      store.set(seat.sessionName, { nodeId: seat.nodeId, attemptId: "attempt-9", launchId: "launch",
        submittedAt: new Date(start).toISOString() });
      const service = new PiCompactionService({ readSidecar: () => null, requestStore: store,
        send: async () => ({ ok: true, sent: true, outcome: "rendered-unconfirmed" }) });
      expect(service.getState(seat.sessionName)).toMatchObject({ status: "uncertain",
        phase: "submitted_no_result", attemptId: "attempt-9" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the in-memory request when the store cannot be read or written", async () => {
    const denied = () => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }); };
    const f = fixture({ requestStore: { get: denied, set: denied, delete: denied } });
    expect(await f.service.trigger(seat)).toMatchObject({ triggered: true, attemptId: "attempt-1" });
    expect(f.service.getState(seat.sessionName)).toMatchObject({ status: "uncertain", attemptId: "attempt-1" });
  });
});
