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
import { ContextMonitor } from "../src/domain/context-monitor.js";
import { ContextUsageStore } from "../src/domain/context-usage-store.js";
import { EventBus } from "../src/domain/event-bus.js";
import { PiCompactionService } from "../src/domain/pi-compaction-service.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { piCompactionTerminal } from "./helpers/pi-compaction-terminal.js";

afterEach(() => vi.useRealTimers());

describe("Pi runner -> compaction/activity/context consumers", () => {
  it.each([
    { requestId: "manual-request", delivery: "delayed" },
    { requestId: "manual-request", delivery: "lost" },
    { requestId: undefined, delivery: "delayed" },
    { requestId: undefined, delivery: "lost" },
  ] as const)("preserves completion and usage with $delivery activity, requestId=$requestId", async ({ requestId, delivery }) => {
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
    const store = new ContextUsageStore(db, { stateDir: dir });
    const readSidecar = () => parsePiRunnerState(readFileSync(sidecar, "utf8"));
    const monitor = new ContextMonitor(db, store, undefined, undefined, undefined, undefined, undefined, readSidecar);
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
    const inputs = terminal.commands;
    const service = new PiCompactionService({
      readSidecar, resolveTarget: () => "%7",
      tmux: {
        sendText: terminal.tmux.sendText,
        sendKeys: async () => {
          const input = inputs.at(-1);
          if (input === undefined) throw new TypeError("Enter without input");
          await terminal.tmux.sendKeys();
          if (input.startsWith("/openrig-state ")) {
            const probe = rpc.at(-1);
            expect(probe).toMatchObject({ type: "get_state" });
            expect(probe?.id).not.toBe("pi-runner-get-state");
            vi.setSystemTime(Date.now() + 1);
            event({ type: "response", id: probe?.id, command: "get_state", success: true,
              data: { isStreaming: false, isCompacting: false, sessionFile: "/ignored/control.jsonl" } });
          }
          return { ok: true };
        },
      },
      sleep: async ms => { await vi.advanceTimersByTimeAsync(ms); },
    });
    try {
      event({ type: "response", id: "pi-runner-get-state", command: "get_state", success: true,
        data: { sessionFile: "/synthetic/session.jsonl", sessionId: "seam-session" } });
      await monitor.pollOnce();
      expect(store.getForNode(node.id, sessionName)).toMatchObject({ availability: "unknown", usedPercentage: null });

      // When the service drives the runner's exact control/compact inputs and Pi completes.
      expect(await service.trigger({ nodeId: node.id, sessionName, runtime: "pi" }))
        .toEqual({ triggered: true, stage: "submitted_unconfirmed" });
      expect(inputs).toEqual([expect.stringMatching(/^\/openrig-state [\w-]+$/), "/openrig-compact"]);
      const compact = rpc.at(-1);
      expect(compact).toMatchObject({ type: "compact" });
      expect(rpc.some(command => command.type === "prompt")).toBe(false);
      expect(readSidecar()).toMatchObject({ ready: true, sessionId: "seam-session", sessionFile: "/synthetic/session.jsonl" });
      expect(service.getState(sessionName).status).toBe("unknown");
      event({ type: "compaction_start", reason: "manual", requestId });
      expect(service.getState(sessionName)).toMatchObject({ status: "in_progress", completionKey: null });
      expect(activity.getLatestForNode({ nodeId: node.id })).toMatchObject({ state: "running", rawEvent: "active", rawSubtype: "compaction" });
      vi.setSystemTime(Date.now() + 1000);
      const endedAt = new Date().toISOString();
      event({ type: "compaction_end", reason: "manual", requestId, aborted: false,
        result: { summary: "Compacted", tokensBefore: 180000, estimatedTokensAfter: 20000 } });
      const stats = rpc.at(-1);
      expect(stats).toMatchObject({ type: "get_session_stats" });
      event({ type: "response", id: compact?.id, command: "compact", success: true,
        data: { summary: "Compacted", tokensBefore: 180000, estimatedTokensAfter: 20000 } });

      // Then durable completion wins even while activity still claims compaction is active.
      const completed = { status: "completed", completionKey: requestId ?? `manual:${endedAt}`,
        compaction: { reason: "manual", endedAt, aborted: false } };
      expect(service.getState(sessionName)).toMatchObject(completed);
      expect(activity.getLatestForNode({ nodeId: node.id })).toMatchObject({ state: "running", rawEvent: "active", rawSubtype: "compaction" });
      expect(emitted.filter(beat => beat.subtype === "compaction").map(beat => beat.hookEvent)).toEqual(["active", "Stop"]);
      expect(held).toHaveLength(1);
      expect(held[0]).toMatchObject({ reason: "manual", endedAt, ...(requestId ? { requestId } : {}) });
      if (delivery === "delayed") held.forEach(ingest);
      expect(activity.getLatestForNode({ nodeId: node.id })).toMatchObject({
        state: delivery === "delayed" ? "idle" : "running",
        rawEvent: delivery === "delayed" ? "Stop" : "active", rawSubtype: "compaction",
      });
      core.heartbeat();
      expect(activity.getLatestForNode({ nodeId: node.id })).toMatchObject({ state: "idle", rawEvent: "Stop", rawSubtype: "idle_heartbeat" });
      expect(service.getState(sessionName)).toMatchObject(completed);

      // Stats may arrive later than completion; null is unknown, never estimatedTokensAfter.
      await monitor.pollOnce();
      expect(store.getForNode(node.id, sessionName)).toMatchObject({ availability: "unknown", usedPercentage: null });
      event({ type: "response", id: stats?.id, command: "get_session_stats", success: true,
        data: { contextUsage: { tokens: null, percent: null, contextWindow: 200000 } } });
      expect(readSidecar()?.contextUsage).toMatchObject({ tokens: null, percent: null });
      await monitor.pollOnce();
      expect(store.getForNode(node.id, sessionName)).toMatchObject({ availability: "unknown", usedPercentage: null, totalInputTokens: null });

      // A later assistant turn produces a real fresh sample; polling, not completion, exposes it.
      vi.setSystemTime(Date.now() + 1000);
      event({ type: "agent_start" });
      event({ type: "agent_end" });
      const nextStats = rpc.at(-1);
      expect(nextStats).toMatchObject({ type: "get_session_stats" });
      const sampledAt = new Date().toISOString();
      event({ type: "response", id: nextStats?.id, command: "get_session_stats", success: true,
        data: { contextUsage: { tokens: 24000, percent: 12, contextWindow: 200000 } } });
      expect(store.getForNode(node.id, sessionName).availability).toBe("unknown");
      await monitor.pollOnce();
      expect(store.getForNode(node.id, sessionName)).toMatchObject({ availability: "known", source: "pi",
        totalInputTokens: 24000, usedPercentage: 12, remainingPercentage: 88, contextWindowSize: 200000,
        sessionId: "seam-session", sessionName, sampledAt, fresh: true });
      expect(service.getState(sessionName)).toMatchObject(completed);
    } finally {
      terminal.editor.close();
      monitor.stop();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
