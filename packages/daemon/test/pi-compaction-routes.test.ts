import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { RunnerCore, type RunnerIo } from "../src/adapters/pi-runner.js";
import type { PiRunnerState } from "../src/adapters/pi-runner-protocol.js";
import { PiCompactionService } from "../src/domain/pi-compaction-service.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { TerminalPolicyStore } from "../src/domain/terminal-policy.js";
import { compactionRoutes } from "../src/routes/compaction.js";
import { createFullTestDb } from "./helpers/test-app.js";
import { piCompactionTerminal } from "./helpers/pi-compaction-terminal.js";

describe("Pi compaction route with real runner", () => {
  const db = createFullTestDb();
  afterAll(() => { db.close(); });
  const terminals: ReturnType<typeof piCompactionTerminal>[] = [];
  afterEach(() => { terminals.splice(0).forEach(t => { t.editor.close(); }); db.prepare("DELETE FROM sessions").run(); });
  const rig = new RigRepository(db).createRig("pi-route");
  const node = new RigRepository(db).addNode(rig.id, "worker", { role: "worker", runtime: "pi" });

  function fixture() {
    new SessionRegistry(db).registerSession(node.id, "pi@test");
    new SessionRegistry(db).updateBinding(node.id, { tmuxSession: "pi@test", tmuxPane: "%9" });
    let time = Date.parse("2026-11-11T10:00:00Z");
    let sidecar: PiRunnerState | null = null;
    let core: RunnerCore;
    const io: RunnerIo = {
      sendRpc: cmd => {
        if (cmd.type === "get_state") {
          time += 1;
          core.handlePiLine(JSON.stringify({ type: "response", id: cmd.id, success: true,
            data: { sessionFile: "/synthetic/session", isStreaming: false, isCompacting: false } }));
        }
      },
      writeSidecar: value => { sidecar = value; }, postActivity: () => {},
      mirrorLine: () => {}, mirrorAppend: () => {}, now: () => new Date(time).toISOString(),
    };
    core = new RunnerCore(io, { sessionName: "pi@test", launchId: "launch-1" });
    core.start();
    const terminal = piCompactionTerminal(core);
    terminals.push(terminal);
    const readSessions: string[] = [];
    let attempt = 0;
    const service = new PiCompactionService({
      readSidecar: session => { readSessions.push(session); return session === "pi@test" ? sidecar : null; },
      send: terminal.send,
      terminalPolicies: new TerminalPolicyStore(db),
      now: () => time,
      newAttemptId: () => `attempt-${++attempt}`,
    });
    const app = new Hono();
    const cancelPreparation = vi.fn(() => null);
    app.use("*", async (c, next) => {
      c.set("db" as never, db);
      c.set("sessionTransport" as never, { resolveSessions: async () => ({ ok: true, sessions: ["pi@test"] }) });
      c.set("piCompactionService" as never, service);
      c.set("compactionEnforcer" as never, { cancelPreparation });
      await next();
    });
    app.route("/api/compaction", compactionRoutes({ bearerToken: "synthetic-token" }));
    const trigger = (skipMap = false, actor?: string) => app.request("/api/compaction/trigger", { method: "POST",
      headers: { Authorization: "Bearer synthetic-token", "Content-Type": "application/json",
        ...(actor ? { "X-OpenRig-Session": actor } : {}) },
      body: JSON.stringify({ session: "pi@test", skipMap }) });
    const state = (session = "pi@test") => app.request(`/api/compaction/state?session=${encodeURIComponent(session)}`,
      { headers: { Authorization: "Bearer synthetic-token" } });
    return { app, core, commands: terminal.commands, terminal, trigger, state, readSessions, cancelPreparation };
  }

  it("dispatches Pi through the guarded send and reports the requested run by attempt id", async () => {
    // Given a Pi runner wired through the guarded send path and its sidecar.
    const f = fixture();
    // When the authenticated route triggers compaction, before any result.
    const response = await f.trigger();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, runtime: "pi", attemptId: "attempt-1",
      stage: "submitted_unconfirmed" });
    expect(f.commands).toEqual(["/openrig-compact attempt-1"]);
    expect(await (await f.state()).json()).toMatchObject({ ok: true, runtime: "pi",
      state: { status: "uncertain", phase: "submitted_no_result", attemptId: "attempt-1" } });
    // When Pi starts and completes that requested run.
    f.core.handlePiLine(JSON.stringify({ type: "compaction_start", reason: "manual", requestId: "synthetic-request" }));
    f.core.handlePiLine(JSON.stringify({ type: "compaction_end", reason: "manual", requestId: "synthetic-request" }));
    // Then the status names the attempt and its completion, not just a request id.
    expect(await (await f.state()).json()).toMatchObject({ ok: true, runtime: "pi",
      state: { status: "completed", attemptId: "attempt-1" } });
  });

  it("preserves bearer auth for Pi trigger and state", async () => {
    const f = fixture();
    const trigger = await f.app.request("/api/compaction/trigger", { method: "POST", body: JSON.stringify({ session: "pi@test" }) });
    const state = await f.app.request("/api/compaction/state?session=pi@test");
    expect(trigger.status).toBe(401);
    expect(state.status).toBe(401);
    expect(f.commands).toEqual([]);
  });

  it("reads the physical Pi sidecar for a logical seat address and echoes that address", async () => {
    const f = fixture();
    const response = await f.trigger();
    expect(await response.json()).toMatchObject({ attemptId: "attempt-1" });
    f.core.handlePiLine(JSON.stringify({ type: "compaction_start", reason: "manual" }));
    f.core.handlePiLine(JSON.stringify({ type: "compaction_end", reason: "manual" }));
    const logical = await f.state("worker@pi-route");
    expect(logical.status).toBe(200);
    expect(await logical.json()).toMatchObject({ ok: true, session: "worker@pi-route", runtime: "pi",
      state: { status: "completed", attemptId: "attempt-1" } });
    expect(f.readSessions).toContain("pi@test");
  });

  it.each(["pi@test", "worker@pi-route"])("refuses Pi cancellation for %s without Claude guidance or calls", async session => {
    const f = fixture();
    const response = await f.app.request("/api/compaction/cancel", { method: "POST",
      headers: { Authorization: "Bearer synthetic-token", "Content-Type": "application/json" },
      body: JSON.stringify({ session }) });
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ ok: false, session, runtime: "pi", reason: "runtime_filter" });
    expect(f.cancelPreparation).not.toHaveBeenCalled();
    expect(f.commands).toEqual([]);
  });

  it("accepts but ignores skipMap for Pi and still uses the reserved control input", async () => {
    const f = fixture();
    const response = await f.trigger(true);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, runtime: "pi", stage: "submitted_unconfirmed" });
    expect(f.commands).toEqual(["/openrig-compact attempt-1"]);
  });

  it("reports a later unsupported compact RPC as that attempt's outcome and refuses retry", async () => {
    const f = fixture();
    const first = await f.trigger();
    expect(await first.json()).toMatchObject({ ok: true, stage: "submitted_unconfirmed" });
    f.core.handlePiLine(JSON.stringify({ type: "response", id: "pi-runner-compact:attempt-1", success: false,
      error: "Unknown command: compact" }));
    expect(await (await f.state()).json()).toMatchObject({ state: { status: "unsupported", attemptId: "attempt-1" } });
    const retry = await f.trigger();
    expect(retry.status).toBe(422);
    expect(await retry.json()).toMatchObject({ ok: false, runtime: "pi", reason: "unsupported" });
    expect(f.commands).toHaveLength(1);
  });

  it("applies the caller's terminal policy: a denied peer is refused before any input", async () => {
    new TerminalPolicyStore(db).write(node.id, { preset: "no-peer-interventions", helpers: [], exceptions: {} },
      "person", "No peer compaction");
    const f = fixture();
    const response = await f.trigger(false, "stranger@pi-route");
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ ok: false, runtime: "pi", reason: "terminal_policy_refused" });
    expect(f.commands).toEqual([]);
    // The seat's own caller is still allowed under the same policy.
    const self = await f.trigger(false, "pi@test");
    expect(self.status).toBe(200);
    expect(f.commands).toEqual(["/openrig-compact attempt-1"]);
  });
});
