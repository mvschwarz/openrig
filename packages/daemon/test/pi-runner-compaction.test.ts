import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RunnerCore, writePiRunnerSidecar, type RunnerIo } from "../src/adapters/pi-runner.js";
import { buildPendingRunnerState, parsePiRunnerState, type PiRunnerState } from "../src/adapters/pi-runner-protocol.js";

function fixture(runtime: "pi" | "omp" = "pi") {
  const rpc: Record<string, unknown>[] = [];
  const activity: Record<string, unknown>[] = [];
  const lines: string[] = [];
  const sidecars: PiRunnerState[] = [];
  let time = Date.parse("2026-11-11T10:00:00Z");
  const io: RunnerIo = {
    sendRpc: cmd => { rpc.push(cmd); },
    postActivity: payload => { activity.push(payload); },
    mirrorLine: line => { lines.push(line); },
    mirrorAppend: () => {},
    writeSidecar: state => { sidecars.push(state); },
    now: () => new Date(time).toISOString(),
  };
  const core = new RunnerCore(io, { sessionName: "seat@test", launchId: "launch-1" }, { runtime });
  const event = (record: Record<string, unknown>) => core.handlePiLine(JSON.stringify(record));
  core.start();
  event({ type: "response", id: "pi-runner-get-state", data: { sessionFile: "/synthetic/session.jsonl" } });
  return { core, io, event, rpc, activity, lines, sidecars, advance: () => { time += 1000; } };
}

describe("Pi compaction sidecar", () => {
  it.each([true, false])("releases A on RPC success=%s without permanently refusing an uncertain retry", success => {
    const f = fixture();
    f.core.handleUserBlock("/openrig-compact attempt-A");
    f.event({ type: "response", id: "pi-runner-compact:attempt-A", success,
      ...(success ? {} : { error: "Nothing to compact" }) });
    expect(f.sidecars.at(-1)?.pendingCompaction).toBeUndefined();
    f.core.handleUserBlock("/openrig-compact attempt-B");
    f.event({ type: "response", id: "pi-runner-compact:attempt-A", success: true });
    expect(f.sidecars.at(-1)?.pendingCompaction?.attemptId).toBe("attempt-B");
    expect(f.rpc.at(-1)).toEqual({ type: "compact", id: "pi-runner-compact:attempt-B" });
  });
  it("keeps A pending when B arrives before Pi answers and credits a delayed start to A", () => {
    // Given A is sent but Pi has not responded.
    const f = fixture();
    f.core.handleUserBlock("/openrig-compact attempt-A");
    // When B arrives before a delayed manual start.
    f.core.handleUserBlock("/openrig-compact attempt-B");
    expect(f.rpc.filter(command => command.type === "compact")).toHaveLength(1);
    expect(f.sidecars.at(-1)?.pendingCompaction?.attemptId).toBe("attempt-A");
    f.event({ type: "compaction_start", reason: "manual", requestId: "request-A" });
    // Then the start belongs to A, not B.
    expect(f.sidecars.at(-1)?.compaction).toMatchObject({ attemptId: "attempt-A", requestId: "request-A" });
  });

  it("does not clear B or replace its run when A's RPC error arrives late", () => {
    // Given A ended and B is awaiting Pi.
    const f = fixture();
    f.core.handleUserBlock("/openrig-compact attempt-A");
    f.event({ type: "compaction_start", reason: "manual", requestId: "request-A" });
    f.event({ type: "compaction_end", reason: "manual", requestId: "request-A" });
    f.core.handleUserBlock("/openrig-compact attempt-B");
    // When A's response arrives late.
    f.event({ type: "response", id: "pi-runner-compact:attempt-A", success: false, error: "late error" });
    // Then B remains pending and its delayed start belongs to B.
    expect(f.sidecars.at(-1)?.pendingCompaction?.attemptId).toBe("attempt-B");
    f.event({ type: "compaction_start", reason: "manual", requestId: "request-B" });
    f.event({ type: "response", id: "pi-runner-compact:attempt-A", success: false, error: "late error" });
    expect(f.sidecars.at(-1)?.compaction).toMatchObject({ attemptId: "attempt-B", requestId: "request-B" });
  });

  it("keeps the prior sidecar readable until the atomic replacement", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sidecar-"));
    const target = path.join(dir, "runner-state.json");
    fs.writeFileSync(target, "prior");
    const rename = fs.renameSync.bind(fs);
    const replacement = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      expect(fs.readFileSync(target, "utf8")).toBe("prior");
      expect(JSON.parse(fs.readFileSync(from, "utf8"))).toMatchObject({ ready: true, updatedAt: "now" });
      rename(from, to);
    });
    try {
      writePiRunnerSidecar(target, { ready: true, updatedAt: "now" });
      expect(replacement).toHaveBeenCalledOnce();
    } finally {
      replacement.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("carries the requested attempt id into the native compact command and back into the record", () => {
    // Given a requested manual compaction.
    const f = fixture();
    f.core.handleUserBlock("/openrig-compact attempt-1");
    // Then the reserved input becomes the native compact RPC, naming the attempt.
    expect(f.rpc.at(-1)).toEqual({ type: "compact", id: "pi-runner-compact:attempt-1" });
    expect(f.lines.some(line => line.includes("/openrig-compact"))).toBe(false);
    expect(f.activity.some(beat => beat.hookEvent === "UserPromptSubmit")).toBe(false);
    // When Pi starts and ends that run.
    f.event({ type: "compaction_start", reason: "manual", requestId: "request-1" });
    expect(f.sidecars.at(-1)?.compaction).toEqual({
      attemptId: "attempt-1", requestId: "request-1", reason: "manual", startedAt: "2026-11-11T10:00:00.000Z" });
    f.advance();
    f.event({ type: "compaction_end", reason: "manual", requestId: "request-1", result: { summary: "summary", tokensBefore: 123 } });
    // Then the terminal record still names the requested attempt.
    expect(f.sidecars.at(-1)?.compaction).toMatchObject({
      attemptId: "attempt-1", requestId: "request-1", startedAt: "2026-11-11T10:00:00.000Z",
      endedAt: "2026-11-11T10:00:01.000Z", result: { summary: "summary", tokensBefore: 123 },
    });
  });

  it("never lets an automatic run take a pending attempt id", () => {
    const f = fixture();
    f.core.handleUserBlock("/openrig-compact attempt-1");
    f.event({ type: "compaction_start", reason: "threshold", requestId: "auto-1" });
    expect(f.sidecars.at(-1)?.compaction).toEqual({ requestId: "auto-1", reason: "threshold", startedAt: "2026-11-11T10:00:00.000Z" });
    f.event({ type: "compaction_end", reason: "threshold", requestId: "auto-1" });
    expect(f.sidecars.at(-1)?.compaction).not.toHaveProperty("attemptId");
    f.event({ type: "compaction_start", reason: "manual", requestId: "request-1" });
    expect(f.sidecars.at(-1)?.compaction).toMatchObject({ attemptId: "attempt-1", reason: "manual" });
  });

  it("persists the pending attempt before sending the compact RPC, clearing it at start", () => {
    const f = fixture();
    f.core.handleUserBlock("/openrig-compact attempt-1");
    // The sidecar names the newest request before the RPC leaves, so a daemon
    // restart reads it as uncertain instead of falling back to an older result.
    expect(f.sidecars.at(-1)?.pendingCompaction).toEqual({ attemptId: "attempt-1", requestedAt: "2026-11-11T10:00:00.000Z" });
    expect(f.rpc.at(-1)).toEqual({ type: "compact", id: "pi-runner-compact:attempt-1" });
    f.event({ type: "compaction_start", reason: "manual", requestId: "request-1" });
    expect(f.sidecars.at(-1)?.pendingCompaction).toBeUndefined();
    expect(f.sidecars.at(-1)?.compaction).toMatchObject({ attemptId: "attempt-1", reason: "manual" });
  });

  it("keeps a requested completion beside a later automatic run", () => {
    const f = fixture();
    f.core.handleUserBlock("/openrig-compact attempt-1");
    f.event({ type: "compaction_start", reason: "manual", requestId: "request-1" });
    f.advance();
    f.event({ type: "compaction_end", reason: "manual", requestId: "request-1", result: { summary: "summary" } });
    expect(f.sidecars.at(-1)?.requestedCompaction).toMatchObject({ attemptId: "attempt-1",
      startedAt: "2026-11-11T10:00:00.000Z", endedAt: "2026-11-11T10:00:01.000Z", result: { summary: "summary" } });
    // Pi's next automatic compaction replaces `compaction` only.
    f.advance();
    f.event({ type: "compaction_start", reason: "threshold", requestId: "auto-1" });
    expect(f.sidecars.at(-1)?.compaction).not.toHaveProperty("attemptId");
    f.advance();
    f.event({ type: "compaction_end", reason: "threshold", requestId: "auto-1" });
    expect(f.sidecars.at(-1)?.compaction).not.toHaveProperty("attemptId");
    expect(f.sidecars.at(-1)?.requestedCompaction).toMatchObject({ attemptId: "attempt-1",
      endedAt: "2026-11-11T10:00:01.000Z", result: { summary: "summary" } });
  });

  it("records an unsupported compact RPC against the attempt that asked for it", () => {
    const f = fixture();
    f.core.handleUserBlock("/openrig-compact attempt-1");
    f.event({ type: "response", id: "pi-runner-compact:attempt-1", command: "compact", success: false, error: "Unknown command: compact" });
    expect(f.lines.at(-1)).toContain("unsupported");
    expect(f.sidecars.at(-1)?.compaction).toMatchObject({ attemptId: "attempt-1", reason: "manual",
      errorMessage: expect.stringContaining("Unknown command"), endedAt: expect.any(String) });
    expect(f.activity.some(beat => beat.subtype === "compaction")).toBe(false);
  });

  it("retains event identity when the compact RPC also reports failure", () => {
    const f = fixture();
    f.core.handleUserBlock("/openrig-compact attempt-1");
    f.event({ type: "compaction_start", reason: "manual", requestId: "request-1" });
    f.event({ type: "compaction_end", reason: "manual", requestId: "request-1", errorMessage: "Nothing to compact" });
    f.advance();
    f.event({ type: "response", id: "pi-runner-compact:attempt-1", success: false, error: "Nothing to compact" });
    expect(f.sidecars.at(-1)?.compaction).toMatchObject({ attemptId: "attempt-1", requestId: "request-1",
      startedAt: "2026-11-11T10:00:00.000Z", endedAt: "2026-11-11T10:00:00.000Z", errorMessage: "Nothing to compact" });
  });

  it.each([false, true])("posts ordered compaction beats and re-arms idle when terminal delivery is lost=%s", lost => {
    const f = fixture();
    f.core.heartbeat();
    f.core.handleUserBlock("/openrig-compact attempt-1");
    f.event({ type: "compaction_start", reason: "manual", requestId: "request-1" });
    const active = f.activity.at(-1);
    f.io.postActivity = payload => {
      if (lost && payload.subtype === "compaction") return Promise.resolve(null);
      f.activity.push(payload);
    };
    f.advance();
    f.event({ type: "compaction_end", reason: "manual", requestId: "request-1", aborted: true });
    expect(f.sidecars.at(-1)?.compaction).toMatchObject({ attemptId: "attempt-1", requestId: "request-1",
      aborted: true, endedAt: "2026-11-11T10:00:01.000Z" });
    if (!lost) expect(f.activity.at(-1)).toMatchObject({ hookEvent: "Stop", subtype: "compaction",
      requestId: "request-1", reason: "manual", endedAt: "2026-11-11T10:00:01.000Z" });
    expect(active).toMatchObject({ hookEvent: "active", subtype: "compaction", requestId: "request-1" });
    f.core.heartbeat();
    expect(f.activity.at(-1)).toMatchObject({ hookEvent: "Stop", subtype: "idle_heartbeat" });
  });

  it("does not add durable compaction or terminal beats for OMP", () => {
    const f = fixture("omp");
    f.event({ type: "compaction_start", reason: "manual" });
    f.event({ type: "compaction_end", reason: "manual" });
    expect(f.sidecars.at(-1)?.compaction).toBeUndefined();
    expect(f.activity.filter(beat => beat.subtype === "compaction").map(beat => beat.hookEvent)).toEqual(["active"]);
  });

  it("re-arms idle on compaction end even when attention suppresses the Stop post", () => {
    const f = fixture();
    f.core.heartbeat();
    f.event({ type: "extension_ui_request", method: "confirm", id: "approval", title: "Approval" });
    f.event({ type: "compaction_start", reason: "manual" });
    f.event({ type: "compaction_end", reason: "manual" });
    expect(f.core["lastPostedHook"]).toBeNull();
    expect(f.core["lastHeartbeatMs"]).toBeNull();
    expect(f.activity.at(-1)).toMatchObject({ hookEvent: "Notification", subtype: "permission_prompt" });
    const beats = f.activity.length;
    f.core.heartbeat();
    expect(f.activity).toHaveLength(beats);
  });

  it.each([
    " /openrig-compact attempt-1", "/openrig-compact attempt-1 ", "/openrig-compact attempt-1\ntext",
    "text /openrig-compact attempt-1", "/openrig-compact", "/compact",
  ])("keeps %j as model input", block => {
    const f = fixture();
    f.core.handleUserBlock(block);
    expect(f.rpc.at(-1)).toMatchObject({ type: "prompt", message: block });
  });

  it("leaves the reserved block as ordinary OMP input", () => {
    const f = fixture("omp");
    f.core.handleUserBlock("/openrig-compact attempt-1");
    expect(f.rpc.at(-1)).toMatchObject({ type: "prompt", message: "/openrig-compact attempt-1" });
  });

  it.each(["request-1", undefined])("retains terminal identity %s across later writes", requestId => {
    const f = fixture();
    f.core.handleUserBlock("/openrig-compact attempt-1");
    f.event({ type: "compaction_start", reason: "manual", requestId });
    f.advance();
    f.event({ type: "compaction_end", reason: "manual", requestId, result: { summary: "summary", tokensBefore: 123 }, aborted: false });
    f.event({ type: "response", id: "pi-runner-get-state", data: {} });
    expect(parsePiRunnerState(JSON.stringify(f.sidecars.at(-1)))?.compaction).toMatchObject({
      attemptId: "attempt-1", reason: "manual", startedAt: "2026-11-11T10:00:00.000Z",
      endedAt: "2026-11-11T10:00:01.000Z", result: { summary: "summary", tokensBefore: 123 },
      ...(requestId ? { requestId } : {}),
    });
  });

  it("replaces terminal state when the next compaction starts", () => {
    const f = fixture();
    f.event({ type: "compaction_end", reason: "manual", errorMessage: "failed" });
    f.event({ type: "compaction_start", reason: "threshold", requestId: "next" });
    expect(f.sidecars.at(-1)?.compaction).toEqual({ reason: "threshold", requestId: "next", startedAt: "2026-11-11T10:00:00.000Z" });
  });

  it("drops launch-local compaction on restart but retains the cursor", () => {
    const prior: PiRunnerState = { ready: true, updatedAt: "old", lastEntryId: "cursor",
      compaction: { attemptId: "attempt-1", reason: "manual", endedAt: "old" } };
    const pending = buildPendingRunnerState("next", "now", prior);
    expect(pending).toEqual({ ready: false, launchId: "next", updatedAt: "now", lastEntryId: "cursor" });
  });
});
