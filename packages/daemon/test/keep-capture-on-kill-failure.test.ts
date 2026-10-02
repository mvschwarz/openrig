import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SnapshotRepository } from "../src/domain/snapshot-repository.js";
import { CheckpointStore } from "../src/domain/checkpoint-store.js";
import { SnapshotCapture } from "../src/domain/snapshot-capture.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { RigTeardownOrchestrator } from "../src/domain/rig-teardown.js";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";
import { shellQuote } from "../src/adapters/shell-quote.js";
import { startTranscriptRotation, stopTranscriptRotation, getActiveRotationCount, getLastCaptureAt } from "../src/domain/transcript-rotation.js";
const run = promisify(exec);
const runFile = promisify(execFile);

describe.skipIf(process.platform === "win32")("native failed-kill transcript continuity", () => {
  it.each([true, false])("preserves capture only while the seat survives (kill fails=%s)", async (failure) => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "kill-capture-"));
    const socketDir = fs.mkdtempSync("/tmp/openrig-env-socket-");
    const socket = path.join(socketDir, "owned.sock");
    const env = { ...process.env, HOME: temp };
    delete env.TMUX; delete env.TMUX_TMPDIR;
    const sessionName = "worker@kill-fixture";
    const db = createDb();
    migrate(db, ALL_MIGRATIONS);
    try {
      await runFile("tmux", ["-S", socket, "-f", "/dev/null", "new-session", "-d", "-s", "server", "sleep 60"], { env });
      const tmuxAdapter = new TmuxAdapter(async (command) => {
        if (failure && command.includes("kill-session")) throw new Error("fixture transport unavailable");
        return (await run(`tmux -S ${shellQuote(socket)} ${command.slice(5)}`, { env })).stdout;
      });
      expect(await tmuxAdapter.createSession(sessionName, temp)).toEqual({ ok: true });
      const rigRepo = new RigRepository(db);
      const sessionRegistry = new SessionRegistry(db);
      const eventBus = new EventBus(db);
      const rig = rigRepo.createRig("kill-fixture");
      const node = rigRepo.addNode(rig.id, "worker");
      const session = sessionRegistry.registerSession(node.id, sessionName);
      sessionRegistry.updateStatus(session.id, "running");
      const snapshotCapture = new SnapshotCapture({ db, rigRepo, sessionRegistry, eventBus,
        snapshotRepo: new SnapshotRepository(db), checkpointStore: new CheckpointStore(db) });
      const orchestrator = new RigTeardownOrchestrator({ db, rigRepo, sessionRegistry, eventBus, snapshotCapture, tmuxAdapter });
      const outputPath = path.join(temp, "transcript.log");
      startTranscriptRotation(tmuxAdapter, sessionName, outputPath, { lines: 20, pollIntervalMs: 30 });
      const deadline = Date.now() + 2000;
      while (getLastCaptureAt(sessionName) === undefined && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(fs.existsSync(outputPath)).toBe(true);
      const before = getLastCaptureAt(sessionName)!;
      const result = await orchestrator.teardown(rig.id);
      expect(await tmuxAdapter.hasSession(sessionName)).toBe(failure);
      expect(sessionRegistry.getSessionsForRig(rig.id).find((entry) => entry.id === session.id)?.status).toBe(failure ? "running" : "exited");
      expect(result.sessionsKilled).toBe(failure ? 0 : 1);
      expect(getActiveRotationCount()).toBe(failure ? 1 : 0);
      if (failure) {
        expect(result.errors.join("\n")).toContain("fixture transport unavailable");
        const captureDeadline = Date.now() + 2000;
        while ((getLastCaptureAt(sessionName) ?? 0) <= before && Date.now() < captureDeadline) await new Promise((resolve) => setTimeout(resolve, 10));
        expect(getLastCaptureAt(sessionName)).toBeGreaterThan(before);
      } else {
        expect(result.errors).toEqual([]);
        expect(getLastCaptureAt(sessionName)).toBeUndefined();
      }
    } finally {
      stopTranscriptRotation(sessionName);
      await runFile("tmux", ["-S", socket, "kill-server"], { env }).catch(() => {});
      db.close(); fs.rmSync(temp, { recursive: true, force: true }); fs.rmSync(socketDir, { recursive: true, force: true });
    }
  });
});
