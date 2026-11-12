import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunnerCore, writePiRunnerSidecar } from "../src/adapters/pi-runner.js";
import { parsePiRunnerState } from "../src/adapters/pi-runner-protocol.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { EventBus } from "../src/domain/event-bus.js";
import { PiCompactionService } from "../src/domain/pi-compaction-service.js";
import { PiCompactionRequestStore } from "../src/domain/pi-compaction-request-store.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { piCompactionTerminal } from "./helpers/pi-compaction-terminal.js";

afterEach(() => vi.useRealTimers());

describe("Pi runner -> requested compaction status", () => {
  it.each(["draft", "without-enter"])("keeps B uncertain after daemon restart with %s input", async boundary => {
    // Given A completed through the real runner editor.
    const dir = mkdtempSync(join(tmpdir(), "pi-request-restart-"));
    const sidecar = join(dir, "runner-state.json");
    const readSidecar = () => parsePiRunnerState(readFileSync(sidecar, "utf8"));
    const core = new RunnerCore({
      sendRpc: () => {}, postActivity: () => {}, mirrorLine: () => {}, mirrorAppend: () => {},
      writeSidecar: state => writePiRunnerSidecar(sidecar, state), now: () => new Date().toISOString(),
    }, { sessionName: "builder@seam", nodeId: "builder", launchId: "launch" });
    core.handlePiLine(JSON.stringify({ type: "response", id: "pi-runner-get-state", data: {} }));
    const terminal = piCompactionTerminal(core);
    const requestStore = new PiCompactionRequestStore(join(dir, "requests"));
    let attempt = 0;
    const service = new PiCompactionService({ readSidecar, requestStore,
      newAttemptId: () => `attempt-${++attempt}`, send: async (session, text, opts) => {
        expect(requestStore.get(session)?.attemptId).toBe(text.split(" ")[1]);
        if (attempt === 1 || boundary === "draft") return terminal.send(session, text, opts);
        opts.beforeWrite?.();
        terminal.input.write(`\u001b[200~${text}\u001b[201~`);
        return { ok: false, sent: true, inputPhase: "written" };
      } });
    const seat = { nodeId: "builder", sessionName: "builder@seam", runtime: "pi" };
    try {
      await service.trigger(seat);
      core.handlePiLine(JSON.stringify({ type: "compaction_start", reason: "manual" }));
      core.handlePiLine(JSON.stringify({ type: "compaction_end", reason: "manual" }));
      expect(service.getState(seat.sessionName)).toMatchObject({ status: "completed", attemptId: "attempt-1" });
      if (boundary === "draft") terminal.input.write("operator draft ");
      // When B is written and the daemon is recreated, including its request store.
      await service.trigger(seat);
      core.heartbeat(); // Runner writes must not erase the daemon-owned request.
      const restarted = new PiCompactionService({ readSidecar, send: terminal.send,
        requestStore: new PiCompactionRequestStore(join(dir, "requests")) });
      // Then the newest request is B, not A's completion.
      expect(restarted.getState(seat.sessionName)).toMatchObject({ status: "uncertain", attemptId: "attempt-2" });
      expect(restarted.getState(seat.sessionName, "different-agent").attemptId).not.toBe("attempt-2");
      const replacement = new RunnerCore({
        sendRpc: () => {}, postActivity: () => {}, mirrorLine: () => {}, mirrorAppend: () => {},
        writeSidecar: state => writePiRunnerSidecar(sidecar, state), now: () => new Date().toISOString(),
      }, { sessionName: seat.sessionName, nodeId: seat.nodeId, launchId: "replacement-launch" });
      replacement.handlePiLine(JSON.stringify({ type: "response", id: "pi-runner-get-state", data: {} }));
      expect(restarted.getState(seat.sessionName, seat.nodeId)).toMatchObject({ status: "not_requested" });
    } finally {
      terminal.editor.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([{ delivery: "delayed" }, { delivery: "lost" }] as const)(
    "keeps the requested attempt's completion with $delivery activity delivery", async ({ delivery }) => {
      // Given a real runner sidecar and running Pi seat in an isolated database.
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-11-11T12:00:00Z"));
      const dir = mkdtempSync(join(tmpdir(), "pi-compaction-seam-"));
      const sidecar = join(dir, "runner-state.json");
      const db = createDb();
      migrate(db, ALL_MIGRATIONS);
      const rigs = new RigRepository(db);
      const rig = rigs.createRig("seam");
      const node = rigs.addNode(rig.id, "builder", { runtime: "pi" });
      const sessionName = "builder@seam";
      const session = new SessionRegistry(db).registerSession(node.id, sessionName);
      db.prepare("UPDATE sessions SET status = 'running' WHERE id = ?").run(session.id);
      const activity = new AgentActivityStore({ db, eventBus: new EventBus(db) });
      const readSidecar = () => parsePiRunnerState(readFileSync(sidecar, "utf8"));
      const rpc: Record<string, unknown>[] = [];
      const emitted: Record<string, unknown>[] = [];
      const held: Record<string, unknown>[] = [];
      const ingest = (payload: Record<string, unknown>) => {
        if (typeof payload.hookEvent !== "string" || typeof payload.sessionName !== "string"
          || typeof payload.runtime !== "string") throw new TypeError("Malformed runner activity");
        expect(activity.recordHookEvent({
          runtime: payload.runtime, sessionName: payload.sessionName, hookEvent: payload.hookEvent,
          subtype: typeof payload.subtype === "string" ? payload.subtype : null,
          occurredAt: typeof payload.occurredAt === "string" ? payload.occurredAt : null,
          sourceSequence: typeof payload.sequence === "number" ? payload.sequence : null,
        }).ok).toBe(true);
      };
      const core = new RunnerCore({
        sendRpc: command => { rpc.push(command); },
        postActivity: payload => {
          emitted.push(payload);
          if (payload.hookEvent === "Stop" && payload.subtype === "compaction") held.push(payload);
          else ingest(payload);
        },
        mirrorLine: () => {}, mirrorAppend: () => {},
        writeSidecar: state => writePiRunnerSidecar(sidecar, state),
        now: () => new Date().toISOString(),
      }, { sessionName, launchId: "seam-launch" }, { runtime: "pi" });
      const event = (record: Record<string, unknown>) => core.handlePiLine(JSON.stringify(record));
      core.start();
      const terminal = piCompactionTerminal(core);
      const service = new PiCompactionService({
        readSidecar,
        send: terminal.send,
        newAttemptId: () => "seam-attempt",
      });
      try {
        event({ type: "response", id: "pi-runner-get-state", command: "get_state", success: true,
          data: { sessionFile: "/synthetic/session.jsonl", sessionId: "seam-session" } });

        // When the service sends the reserved input through the guarded path and Pi runs it.
        expect(await service.trigger({ nodeId: node.id, sessionName, runtime: "pi" }))
          .toEqual({ triggered: true, attemptId: "seam-attempt", stage: "submitted_unconfirmed" });
        expect(terminal.commands).toEqual(["/openrig-compact seam-attempt"]);
        expect(rpc.some(command => command.type === "prompt")).toBe(false);
        expect(readSidecar()).toMatchObject({ ready: true, sessionId: "seam-session", sessionFile: "/synthetic/session.jsonl" });
        expect(service.getState(sessionName)).toMatchObject({ status: "uncertain", phase: "submitted_no_result" });

        event({ type: "compaction_start", reason: "manual", requestId: "manual-request" });
        expect(service.getState(sessionName)).toMatchObject({ status: "uncertain", phase: "started_no_end",
          attemptId: "seam-attempt", startedAt: "2026-11-11T12:00:00.000Z" });
        expect(activity.getLatestForNode({ nodeId: node.id })).toMatchObject({ state: "running",
          rawEvent: "active", rawSubtype: "compaction" });

        vi.setSystemTime(Date.now() + 1000);
        const endedAt = new Date().toISOString();
        event({ type: "compaction_end", reason: "manual", requestId: "manual-request", aborted: false,
          result: { summary: "Compacted", tokensBefore: 180000, estimatedTokensAfter: 20000 } });

        // Then durable completion belongs to the requested attempt, even while activity still reads active.
        expect(service.getState(sessionName)).toMatchObject({ status: "completed", attemptId: "seam-attempt",
          endedAt, result: { summary: "Compacted", tokensBefore: 180000 } });
        expect(activity.getLatestForNode({ nodeId: node.id })).toMatchObject({ state: "running",
          rawEvent: "active", rawSubtype: "compaction" });
        expect(emitted.filter(beat => beat.subtype === "compaction").map(beat => beat.hookEvent)).toEqual(["active", "Stop"]);
        expect(held).toHaveLength(1);
        expect(held[0]).toMatchObject({ reason: "manual", endedAt, requestId: "manual-request" });
        if (delivery === "delayed") held.forEach(ingest);
        core.heartbeat();
        expect(activity.getLatestForNode({ nodeId: node.id })).toMatchObject({ state: "idle",
          rawEvent: "Stop", rawSubtype: "idle_heartbeat" });
        expect(service.getState(sessionName)).toMatchObject({ status: "completed", attemptId: "seam-attempt" });

        // Then a later automatic run replaces `compaction` only; the request still reads completed.
        event({ type: "compaction_start", reason: "threshold", requestId: "auto-1" });
        event({ type: "compaction_end", reason: "threshold", requestId: "auto-1" });
        expect(service.getState(sessionName)).toMatchObject({ status: "completed", attemptId: "seam-attempt",
          automatic: { reason: "threshold" } });
        // Recreating the service over the same sidecar (a daemon restart) still answers with
        // the requested attempt's own completion, never the automatic run.
        const restarted = new PiCompactionService({ readSidecar, send: terminal.send, newAttemptId: () => "next-attempt" });
        expect(restarted.getState(sessionName)).toMatchObject({ status: "completed", attemptId: "seam-attempt" });
      } finally {
        terminal.editor.close();
        db.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
});
