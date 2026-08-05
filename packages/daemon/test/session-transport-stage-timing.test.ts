import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SessionTransport } from "../src/domain/session-transport.js";
import type { TmuxAdapter, TmuxResult } from "../src/adapters/tmux.js";
import { createDaemon } from "../src/startup.js";
import { createFullTestDb } from "./helpers/test-app.js";

interface StageRecord {
  site: string;
  durationMs: number;
  outcome: "ok" | "failed";
}

class RecordingStageTimer {
  readonly records: StageRecord[] = [];

  async runStage<T>(
    site: string,
    fn: () => Promise<T>,
    classify?: (value: T) => "ok" | "failed",
  ): Promise<T> {
    const started = performance.now();
    try {
      const value = await fn();
      this.records.push({
        site,
        durationMs: Math.max(0, performance.now() - started),
        outcome: classify?.(value) ?? "ok",
      });
      return value;
    } catch (error) {
      this.records.push({ site, durationMs: Math.max(0, performance.now() - started), outcome: "failed" });
      throw error;
    }
  }
}

function mockTmux(overrides?: Partial<{
  sendText: (target: string, text: string) => Promise<TmuxResult>;
  sendKeys: (target: string, keys: string[]) => Promise<TmuxResult>;
  capturePaneContent: (target: string, lines?: number) => Promise<string | null>;
}>): TmuxAdapter {
  return {
    hasSession: async () => true,
    sendText: overrides?.sendText ?? (async () => ({ ok: true as const })),
    sendKeys: overrides?.sendKeys ?? (async () => ({ ok: true as const })),
    capturePaneContent: overrides?.capturePaneContent ?? (async () => "idle\n❯ "),
    createSession: async () => ({ ok: true as const }),
    killSession: async () => ({ ok: true as const }),
    listSessions: async () => [],
    listWindows: async () => [],
    listPanes: async () => [],
    startPipePane: async () => ({ ok: true as const }),
    stopPipePane: async () => ({ ok: true as const }),
    getPanePid: async () => null,
    getPaneCommand: async () => null,
  } as unknown as TmuxAdapter;
}

describe("SessionTransport stage timing", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;

  beforeEach(() => {
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    const rig = rigRepo.createRig("timing-rig");
    const node = rigRepo.addNode(rig.id, "dev.impl", { role: "worker", runtime: "claude-code" });
    const session = sessionRegistry.registerSession(node.id, "dev-impl@timing-rig");
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateBinding(node.id, { tmuxSession: "dev-impl@timing-rig" });
  });

  afterEach(() => db.close());

  function transport(tmux: TmuxAdapter, timer: RecordingStageTimer): SessionTransport {
    return new SessionTransport({
      db,
      rigRepo,
      sessionRegistry,
      tmuxAdapter: tmux,
      sleep: async () => {},
      slowOpRecorder: timer,
    } as never);
  }

  it("records the four real verify-path stages in source order with durations", async () => {
    const timer = new RecordingStageTimer();
    let captures = 0;
    const result = await transport(mockTmux({
      capturePaneContent: async () => (++captures === 1 ? "before\n❯ " : "before\nhello\n❯ "),
    }), timer).send("dev-impl@timing-rig", "hello", { verify: true });

    expect(result.ok).toBe(true);
    expect(timer.records.map((r) => r.site)).toEqual([
      "session_transport.pre_capture",
      "session_transport.send_text",
      "session_transport.submit",
      "session_transport.post_capture",
    ]);
    expect(timer.records.every((r) => Number.isFinite(r.durationMs) && r.durationMs >= 0)).toBe(true);
    expect(timer.records.every((r) => r.outcome === "ok")).toBe(true);
  });

  it("attributes a transport timeout/failure to its exact stage without adding a new timeout", async () => {
    const timer = new RecordingStageTimer();
    const result = await transport(mockTmux({
      sendText: async () => ({ ok: false, code: "timeout", message: "tmux send timed out" }),
    }), timer).send("dev-impl@timing-rig", "hello", { verify: true });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("send_failed");
    expect(timer.records).toEqual([
      expect.objectContaining({ site: "session_transport.pre_capture", outcome: "ok" }),
      expect.objectContaining({ site: "session_transport.send_text", outcome: "failed" }),
    ]);
  });

  it("wires the recorder through createDaemon into the production SessionTransport", async () => {
    const timer = new RecordingStageTimer();
    const oldNoKernel = process.env.OPENRIG_NO_KERNEL;
    process.env.OPENRIG_NO_KERNEL = "1";
    const daemon = await createDaemon({
      dbPath: ":memory:",
      tmuxExec: async (command: string) => command.includes("capture-pane") ? "idle\n❯ " : "",
      cmuxExec: async () => "",
      slowOpRecorder: timer,
    } as never);
    try {
      const composedRig = daemon.deps.rigRepo.createRig("composed-timing-rig");
      const node = daemon.deps.rigRepo.addNode(composedRig.id, "dev.impl", {
        role: "worker",
        runtime: "claude-code",
      });
      const session = daemon.deps.sessionRegistry.registerSession(node.id, "dev-impl@composed-timing-rig");
      daemon.deps.sessionRegistry.updateStatus(session.id, "running");
      daemon.deps.sessionRegistry.updateBinding(node.id, { tmuxSession: "dev-impl@composed-timing-rig" });

      const result = await daemon.deps.sessionTransport!.send(
        "dev-impl@composed-timing-rig",
        "hello",
        { verify: true },
      );
      expect(result.ok).toBe(true);
      expect(timer.records.map((record) => record.site)).toEqual([
        "session_transport.pre_capture",
        "session_transport.send_text",
        "session_transport.submit",
        "session_transport.post_capture",
      ]);
    } finally {
      daemon.eventLoopMonitor.stop();
      daemon.db.close();
      if (oldNoKernel === undefined) delete process.env.OPENRIG_NO_KERNEL;
      else process.env.OPENRIG_NO_KERNEL = oldNoKernel;
    }
  }, 10_000);
});
