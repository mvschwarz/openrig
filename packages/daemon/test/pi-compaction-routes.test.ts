import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { RunnerCore, type RunnerIo } from "../src/adapters/pi-runner.js";
import type { PiRunnerState } from "../src/adapters/pi-runner-protocol.js";
import { PiCompactionService } from "../src/domain/pi-compaction-service.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
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
    core = new RunnerCore(io, { sessionName: "pi@test" });
    core.start();
    const terminal = piCompactionTerminal(core);
    terminals.push(terminal);
    const readSessions: string[] = [];
    const service = new PiCompactionService({
      readSidecar: session => { readSessions.push(session); return session === "pi@test" ? sidecar : null; },
      resolveTarget: () => "%9", now: () => time,
      sleep: async ms => { time += ms; },
      tmux: terminal.tmux,
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
    const trigger = (skipMap = false) => app.request("/api/compaction/trigger", { method: "POST",
      headers: { Authorization: "Bearer synthetic-token", "Content-Type": "application/json" },
      body: JSON.stringify({ session: "pi@test", skipMap }) });
    return { app, core, commands: terminal.commands, terminal, trigger, readSessions, cancelPreparation };
  }

  it("dispatches Pi without Claude usage or lifecycle and reads real terminal sidecar", async () => {
    // Given a Pi runner wired through tmux input and sidecar callbacks.
    const f = fixture();
    // When the authenticated route triggers compaction and Pi finishes.
    const response = await f.trigger();
    f.core.handlePiLine(JSON.stringify({ type: "compaction_end", reason: "manual", requestId: "synthetic-request" }));
    const state = await f.app.request("/api/compaction/state?session=pi@test", { headers: { Authorization: "Bearer synthetic-token" } });
    // Then the route submits Pi input and observes completion without activity delivery.
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, runtime: "pi", stage: "submitted_unconfirmed" });
    expect(f.commands).toEqual([expect.stringMatching(/^\/openrig-state [\w-]+$/), "/openrig-compact"]);
    expect(await state.json()).toMatchObject({ ok: true, runtime: "pi", state: { status: "completed", completionKey: "synthetic-request" } });
  });

  it("preserves bearer auth for Pi trigger and state", async () => {
    // Given a protected Pi route.
    const f = fixture();
    // When unauthenticated requests arrive.
    const trigger = await f.app.request("/api/compaction/trigger", { method: "POST", body: JSON.stringify({ session: "pi@test" }) });
    const state = await f.app.request("/api/compaction/state?session=pi@test");
    // Then no runner input is sent.
    expect(trigger.status).toBe(401);
    expect(state.status).toBe(401);
    expect(f.commands).toEqual([]);
  });

  it("returns a draft refusal without submitting the editor's existing draft", async () => {
    // Given an unsent draft in the actual Pi readline editor.
    const f = fixture();
    f.terminal.input.write("operator draft");
    // When the authenticated route requests compaction.
    const response = await f.trigger();
    // Then neither the draft nor a control token has been submitted.
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ ok: false, reason: "draft_input_busy" });
    expect(f.terminal.editor.line).toBe("operator draft");
    expect(f.commands).toEqual([]);
  });

  it("reads the physical Pi sidecar for a logical seat address and echoes that address", async () => {
    const f = fixture();
    f.core.handlePiLine(JSON.stringify({ type: "compaction_end", reason: "manual", requestId: "completed" }));
    const response = await f.app.request("/api/compaction/state?session=worker@pi-route",
      { headers: { Authorization: "Bearer synthetic-token" } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, session: "worker@pi-route", runtime: "pi",
      state: { status: "completed", completionKey: "completed" } });
    expect(f.readSessions).toEqual(["pi@test"]);
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

  it("accepts but ignores skipMap for Pi and still uses native control input", async () => {
    const f = fixture();
    const response = await f.trigger(true);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, runtime: "pi", stage: "submitted_unconfirmed" });
    expect(f.commands).toEqual([expect.stringMatching(/^\/openrig-state [\w-]+$/), "/openrig-compact"]);
  });

  it("reports initial submission before a later unsupported RPC error and refuses retry", async () => {
    const f = fixture();
    const first = await f.trigger();
    expect(await first.json()).toMatchObject({ ok: true, stage: "submitted_unconfirmed" });
    f.core.handlePiLine(JSON.stringify({ type: "response", id: "pi-runner-compact", success: false,
      error: "Unknown command: compact" }));
    const retry = await f.trigger();
    expect(retry.status).toBe(422);
    expect(await retry.json()).toMatchObject({ ok: false, runtime: "pi", reason: "unsupported" });
    expect(f.commands).toHaveLength(2);
  });
});
