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
  it.each(["agent_end", "compaction_end"])("samples context after %s and retains honest nulls within the launch", type => {
    const f = fixture();
    f.event({ type, reason: "manual" });
    expect(f.rpc.at(-1)).toEqual({ type: "get_session_stats", id: "pi-runner-session-stats" });
    f.event({ type: "response", id: "pi-runner-session-stats", success: true,
      data: { contextUsage: { tokens: null, percent: null, contextWindow: 200000 } } });
    f.advance();
    f.event({ type: "response", id: "pi-runner-get-state", data: {} });
    expect(f.sidecars.at(-1)?.contextUsage).toEqual({ tokens: null, percent: null, contextWindow: 200000, updatedAt: "2026-11-11T10:00:00.000Z" });
  });

  it("replaces null usage with a fresh numeric sample", () => {
    const f = fixture();
    f.event({ type: "response", id: "pi-runner-session-stats", data: { contextUsage: { tokens: null, percent: null, contextWindow: 10000 } } });
    f.advance();
    f.event({ type: "response", id: "pi-runner-session-stats", data: { contextUsage: { tokens: 123, percent: 1.23, contextWindow: 10000 } } });
    expect(f.sidecars.at(-1)?.contextUsage).toMatchObject({ tokens: 123, percent: 1.23, contextWindow: 10000 });
  });

  it.each([{}, { tokens: 0, percent: 0 }, { tokens: "123", percent: null, contextWindow: 10000 }])("does not fabricate usage from malformed stats %j", contextUsage => {
    const f = fixture();
    f.event({ type: "response", id: "pi-runner-session-stats", data: { contextUsage } });
    expect(f.sidecars.at(-1)?.contextUsage).toBeUndefined();
  });

  it.each(["compact", "get_session_stats"])("surfaces unsupported %s without a success claim", command => {
    const f = fixture();
    f.event({ type: "response", id: command === "compact" ? "pi-runner-compact" : "pi-runner-session-stats",
      command, success: false, error: `Unknown command: ${command}` });
    expect(f.lines.at(-1)).toContain("unsupported");
    if (command === "compact") expect(f.sidecars.at(-1)?.compaction).toMatchObject({ reason: "manual", errorMessage: expect.stringContaining("Unknown command"), endedAt: expect.any(String) });
    expect(f.activity.some(beat => beat.subtype === "compaction")).toBe(false);
  });

  it("drops a previous usage sample when stats become unsupported", () => {
    const f = fixture();
    f.event({ type: "response", id: "pi-runner-session-stats", data: { contextUsage: { tokens: 123, percent: 1.23, contextWindow: 10000 } } });
    f.event({ type: "response", id: "pi-runner-session-stats", success: false, error: "Unknown command: get_session_stats" });
    expect(f.sidecars.at(-1)?.contextUsage).toBeUndefined();
  });

  it("retains event identity when the compact RPC also reports failure", () => {
    const f = fixture();
    f.event({ type: "compaction_start", reason: "manual", requestId: "request-1" });
    f.event({ type: "compaction_end", reason: "manual", requestId: "request-1", errorMessage: "Nothing to compact" });
    f.advance();
    f.event({ type: "response", id: "pi-runner-compact", success: false, error: "Nothing to compact" });
    expect(f.sidecars.at(-1)?.compaction).toMatchObject({ requestId: "request-1", startedAt: "2026-11-11T10:00:00.000Z", endedAt: "2026-11-11T10:00:00.000Z", errorMessage: "Nothing to compact" });
  });

  it("never requests stats on OMP completion", () => {
    const f = fixture("omp");
    f.event({ type: "agent_end" });
    f.event({ type: "compaction_end" });
    expect(f.rpc.some(cmd => cmd.type === "get_session_stats")).toBe(false);
  });
  it.each([false, true])("posts ordered compaction beats and re-arms idle when terminal delivery is lost=%s", lost => {
    const f = fixture();
    f.core.heartbeat();
    f.event({ type: "compaction_start", reason: "manual", requestId: "request-1" });
    const active = f.activity.at(-1);
    f.io.postActivity = payload => {
      if (lost && payload.subtype === "compaction") return Promise.resolve(null);
      f.activity.push(payload);
    };
    f.advance();
    f.event({ type: "compaction_end", reason: "manual", requestId: "request-1", aborted: true });
    expect(f.sidecars.at(-1)?.compaction).toMatchObject({ requestId: "request-1", aborted: true, endedAt: "2026-11-11T10:00:01.000Z" });
    if (!lost) expect(f.activity.at(-1)).toMatchObject({ hookEvent: "Stop", subtype: "compaction", requestId: "request-1", reason: "manual", endedAt: "2026-11-11T10:00:01.000Z" });
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
  it("dispatches only the exact reserved Pi block without echo or prompt activity", () => {
    const f = fixture();
    f.core.handleUserBlock("/openrig-compact");
    expect(f.rpc.at(-1)).toMatchObject({ type: "compact" });
    expect(f.lines.some(line => line.includes("/openrig-compact"))).toBe(false);
    expect(f.activity.some(beat => beat.hookEvent === "UserPromptSubmit")).toBe(false);
  });

  it.each([" /openrig-compact", "/openrig-compact ", "/openrig-compact\ntext", "text /openrig-compact", "/compact"])("keeps %j as model input", block => {
    const f = fixture();
    f.core.handleUserBlock(block);
    expect(f.rpc.at(-1)).toMatchObject({ type: "prompt", message: block });
  });

  it("leaves the reserved block as ordinary OMP input", () => {
    const f = fixture("omp");
    f.core.handleUserBlock("/openrig-compact");
    expect(f.rpc.at(-1)).toMatchObject({ type: "prompt", message: "/openrig-compact" });
  });
  it.each(["request-1", undefined])("retains terminal identity %s across later writes", requestId => {
    // Given an announced compaction.
    const f = fixture();
    f.event({ type: "compaction_start", reason: "manual", requestId });
    f.advance();
    // When it ends and another sidecar write follows.
    f.event({ type: "compaction_end", reason: "manual", requestId, result: { summary: "summary", tokensBefore: 123 }, aborted: false });
    f.event({ type: "response", id: "pi-runner-get-state", data: {} });
    // Then its request id or reason/end timestamp remains durable.
    expect(parsePiRunnerState(JSON.stringify(f.sidecars.at(-1)))?.compaction).toMatchObject({
      reason: "manual", startedAt: "2026-11-11T10:00:00.000Z", endedAt: "2026-11-11T10:00:01.000Z",
      result: { summary: "summary", tokensBefore: 123 }, ...(requestId ? { requestId } : {}),
    });
  });

  it("replaces terminal state when the next compaction starts", () => {
    // Given a completed compaction.
    const f = fixture();
    f.event({ type: "compaction_end", reason: "manual", errorMessage: "failed" });
    // When a new compaction starts.
    f.event({ type: "compaction_start", reason: "threshold", requestId: "next" });
    // Then no old terminal fields survive.
    expect(f.sidecars.at(-1)?.compaction).toEqual({ reason: "threshold", requestId: "next", startedAt: "2026-11-11T10:00:00.000Z" });
  });

  it("drops launch-local compaction and usage on restart but retains the cursor", () => {
    // Given prior launch telemetry.
    const prior: PiRunnerState = { ready: true, updatedAt: "old", lastEntryId: "cursor",
      compaction: { reason: "manual", endedAt: "old" },
      contextUsage: { tokens: null, percent: null, contextWindow: 200000, updatedAt: "old" } };
    // When the launch-scoped reset runs.
    const pending = buildPendingRunnerState("next", "now", prior);
    // Then only the durable cursor crosses launches.
    expect(pending).toEqual({ ready: false, launchId: "next", updatedAt: "now", lastEntryId: "cursor" });
  });
});
