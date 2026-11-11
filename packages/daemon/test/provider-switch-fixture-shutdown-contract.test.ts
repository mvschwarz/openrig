import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { CheckpointStore } from "../src/domain/checkpoint-store.js";
import { EventBus } from "../src/domain/event-bus.js";
import { readProcessTable, type ProcessTableRow } from "../src/domain/process-table.js";
import { ResumeMetadataRefresher } from "../src/domain/resume-metadata-refresher.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { RigTeardownOrchestrator } from "../src/domain/rig-teardown.js";
import { seatRuntimeHome } from "../src/domain/seat-runtime-home.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SnapshotCapture } from "../src/domain/snapshot-capture.js";
import { SnapshotRepository } from "../src/domain/snapshot-repository.js";

interface ProviderLaunchRecord {
  pid: number;
  conversation: string;
  model: string;
  permission: string;
  auth: string;
  remembered: boolean;
}

describe.skipIf(process.platform === "win32")("provider-switch synthetic Claude fixture shutdown capture contract", () => {
  let binRoot: string;
  let claudeFixtureBinary: string;
  let root: string;
  let db: ReturnType<typeof createDb>;
  let rigRepo: RigRepository;
  let registry: SessionRegistry;
  let eventBus: EventBus;
  let snapshotRepo: SnapshotRepository;
  let capture: SnapshotCapture;
  const cleanupCallbacks: Array<() => Promise<void>> = [];

  beforeAll(() => {
    binRoot = fs.mkdtempSync(path.join(os.tmpdir(), "provider-switch-claude-bin-"));
    claudeFixtureBinary = path.join(binRoot, "claude");
    const fixtureSource = fileURLToPath(new URL("fixtures/provider-switch-claude.c", import.meta.url));
    const shippedRelay = fileURLToPath(
      new URL("../assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs", import.meta.url),
    );
    execFileSync("cc", [
      fixtureSource,
      "-o",
      claudeFixtureBinary,
      `-DFIXTURE_NODE=${JSON.stringify(process.execPath)}`,
      `-DFIXTURE_RELAY=${JSON.stringify(shippedRelay)}`,
    ]);
  });

  afterAll(() => {
    if (binRoot) fs.rmSync(binRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "provider-switch-shutdown-"));
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    rigRepo = new RigRepository(db);
    registry = new SessionRegistry(db);
    eventBus = new EventBus(db);
    snapshotRepo = new SnapshotRepository(db);
    capture = new SnapshotCapture({
      db,
      rigRepo,
      sessionRegistry: registry,
      eventBus,
      snapshotRepo,
      checkpointStore: new CheckpointStore(db),
    });
  });

  afterEach(async () => {
    while (cleanupCallbacks.length > 0) {
      const stop = cleanupCallbacks.pop()!;
      await stop();
    }
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function waitForPrompt(child: ChildProcessWithoutNullStreams): Promise<void> {
    let stdout = "";
    let stderr = "";
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`synthetic provider fixture timed out waiting for prompt (stdout=${JSON.stringify(stdout)}, stderr=${JSON.stringify(stderr)})`));
      }, 10_000);
      const onData = (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
        if (stdout.includes("❯ ")) {
          cleanup();
          resolve();
        }
      };
      const onStderr = (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      };
      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        cleanup();
        reject(new Error(`synthetic provider fixture exited before prompt (code=${String(code)}, signal=${String(signal)}, stderr=${JSON.stringify(stderr)})`));
      };
      const cleanup = () => {
        clearTimeout(timer);
        child.stdout.off("data", onData);
        child.stderr.off("data", onStderr);
        child.off("error", onError);
        child.off("exit", onExit);
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onStderr);
      child.once("error", onError);
      child.once("exit", onExit);
    });
  }

  async function launchProviderSwitchFixtureSeat(options: {
    storedToken: string;
    provenance: "operator" | "scrape" | "hook";
    args: string[];
    extraEnv: Record<string, string>;
    seatName?: string;
  }) {
    const workDir = path.join(root, "work");
    const homeDir = path.join(root, "home");
    const openrigHome = path.join(root, "openrig-home");
    const daemonConfigDir = path.join(root, "daemon-claude");
    const selectedConfigDir = path.join(root, "account");
    const scratchTmpDir = path.join(root, "tmp");
    for (const dir of [workDir, homeDir, openrigHome, daemonConfigDir, selectedConfigDir, scratchTmpDir]) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const rig = rigRepo.createRig("provider-switch-fixture");
    const node = rigRepo.addNode(rig.id, "work.worker", {
      runtime: "claude-code",
      cwd: workDir,
      model: "fixture-model",
      restorePolicy: "resume_if_possible",
    });
    db.prepare("UPDATE nodes SET account_home = ? WHERE id = ?").run(selectedConfigDir, node.id);

    const seatName = options.seatName ?? "r00-provider-switch-fixture-work_worker";
    const session = registry.registerSession(node.id, seatName);
    registry.updateStatus(session.id, "running");
    registry.updateBinding(node.id, { tmuxSession: seatName, tmuxPane: "%1" });
    registry.updateResumeToken(session.id, "claude_id", options.storedToken, options.provenance);

    const child = spawn(claudeFixtureBinary, options.args, {
      cwd: workDir,
      env: {
        PATH: "/usr/bin:/bin",
        HOME: homeDir,
        TMPDIR: scratchTmpDir,
        OPENRIG_HOME: openrigHome,
        CLAUDE_CONFIG_DIR: selectedConfigDir,
        OPENRIG_NODE_ID: node.id,
        OPENRIG_RUNTIME: "claude-code",
        ...options.extraEnv,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stopChild = async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, "close");
      child.kill("SIGTERM");
      const killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 2_000);
      try {
        await exited;
      } finally {
        clearTimeout(killTimer);
      }
    };
    cleanupCallbacks.push(stopChild);

    await waitForPrompt(child);
    const childPid = child.pid!;

    const panePid = process.pid;
    const readForegroundRows = async (): Promise<ProcessTableRow[]> => {
      const table = await readProcessTable();
      const selfRow = table.find((row) => row.pid === panePid);
      const liveRow = table.find((row) => row.pid === childPid);
      if (!selfRow || !liveRow) return [];
      return [
        {
          pid: selfRow.pid,
          ppid: selfRow.ppid,
          pgid: panePid,
          tpgid: liveRow.pid,
          executableName: "bash",
          startedAt: selfRow.startedAt,
          command: "bash",
        },
        {
          ...liveRow,
          ppid: panePid,
          pgid: liveRow.pid,
          tpgid: liveRow.pid,
        },
      ];
    };

    const initialSample = await readForegroundRows();
    const initialLiveRow = initialSample.find((row) => row.pid === childPid);
    expect(initialLiveRow, "expected live compiled provider-switch-claude OS process in process table").toBeDefined();
    expect(Number.isFinite(Date.parse(initialLiveRow!.startedAt))).toBe(true);

    const listClaudeProcesses = vi.fn(readForegroundRows);
    const probeClaudeResume = vi.fn(async () => "inconclusive" as const);
    const tmux = {
      getPanePid: vi.fn(async () => panePid),
      killSession: vi.fn(async () => {
        await stopChild();
        return { ok: true as const };
      }),
    } as unknown as TmuxAdapter;

    const refresher = new ResumeMetadataRefresher({
      sessionRegistry: registry,
      tmuxAdapter: tmux,
      homeDir,
      claudeConfigDir: daemonConfigDir,
      seatHome: (nodeId, runtime) => seatRuntimeHome(db, nodeId, runtime).home,
      listClaudeProcesses,
      probeClaudeResume,
    });
    const teardown = new RigTeardownOrchestrator({
      db,
      rigRepo,
      sessionRegistry: registry,
      eventBus,
      snapshotCapture: capture,
      tmuxAdapter: tmux,
      resumeMetadataRefresher: refresher,
    });

    const readLaunches = (): ProviderLaunchRecord[] => {
      const journalPath = path.join(openrigHome, "provider-launches.jsonl");
      return fs
        .readFileSync(journalPath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as ProviderLaunchRecord);
    };

    return {
      rig,
      node,
      session,
      seatName,
      workDir,
      openrigHome,
      daemonConfigDir,
      selectedConfigDir,
      childPid,
      initialLiveRow: initialLiveRow!,
      pidSessionFile: path.join(selectedConfigDir, "sessions", `${childPid}.json`),
      probeClaudeResume,
      listClaudeProcesses,
      tmux,
      refresher,
      teardown,
      readLaunches,
    };
  }

  it("writes current-PID session metadata from explicit --name + --resume so shutdown captures without fallback probe", async () => {
    const conversation = randomUUID();
    const seatName = "r00-provider-switch-fixture-work_worker";
    const h = await launchProviderSwitchFixtureSeat({
      storedToken: conversation,
      provenance: "operator",
      seatName,
      args: ["--resume", conversation, "--name", seatName, "--model", "fixture-model", "--permission-mode", "acceptEdits"],
      extraEnv: {
        OPENRIG_SESSION_NAME: seatName,
        ANTHROPIC_API_KEY: "synthetic-api",
      },
    });

    expect(h.readLaunches()).toEqual([
      {
        pid: h.childPid,
        conversation,
        model: "fixture-model",
        permission: "acceptEdits",
        auth: "api",
        remembered: false,
      },
    ]);

    const result = await h.teardown.teardown(h.rig.id);
    expect(result.errors).toEqual([]);
    expect(result.sessionsKilled).toBe(1);
    expect(h.listClaudeProcesses).toHaveBeenCalled();

    const recordExists = fs.existsSync(h.pidSessionFile);
    expect
      .soft(recordExists, "expected synthetic fixture to write <CLAUDE_CONFIG_DIR>/sessions/<pid>.json for explicit --name + --resume")
      .toBe(true);
    if (recordExists) {
      const stat = fs.statSync(h.pidSessionFile);
      expect.soft(stat.size).toBeLessThanOrEqual(64 * 1024);
      expect.soft(stat.mtimeMs).toBeGreaterThanOrEqual(Date.parse(h.initialLiveRow.startedAt));
      expect.soft(JSON.parse(fs.readFileSync(h.pidSessionFile, "utf8"))).toMatchObject({
        name: h.seatName,
        sessionId: conversation,
      });
    }

    expect
      .soft(h.probeClaudeResume, "expected captureClaudeSessionId hit without invoking fallback probeClaudeResume")
      .not.toHaveBeenCalled();
    const updated = registry.getSessionsForRig(h.rig.id)[0]!;
    expect.soft(updated.resumeToken).toBe(conversation);
    expect.soft(updated.resumeLastProbeStatus).toBe("resumable");
  });

  it("writes current-PID session metadata from --name + --session-id so shutdown captures conversation without fallback probe", async () => {
    const initialConversation = randomUUID();
    const activeConversation = randomUUID();
    const seatName = "r00-provider-switch-fixture-work_worker";
    const h = await launchProviderSwitchFixtureSeat({
      storedToken: initialConversation,
      provenance: "scrape",
      seatName,
      args: ["--session-id", activeConversation, "--name", seatName, "--model", "fixture-model", "--permission-mode", "acceptEdits"],
      extraEnv: {
        CLAUDE_CODE_OAUTH_TOKEN: "synthetic-plan",
      },
    });

    expect(h.readLaunches()).toEqual([
      {
        pid: h.childPid,
        conversation: activeConversation,
        model: "fixture-model",
        permission: "acceptEdits",
        auth: "plan",
        remembered: false,
      },
    ]);

    const result = await h.teardown.teardown(h.rig.id);
    expect(result.errors).toEqual([]);
    expect(result.sessionsKilled).toBe(1);
    expect(h.listClaudeProcesses).toHaveBeenCalled();

    const recordExists = fs.existsSync(h.pidSessionFile);
    expect
      .soft(recordExists, "expected synthetic fixture to write <CLAUDE_CONFIG_DIR>/sessions/<pid>.json for --name + --session-id")
      .toBe(true);
    if (recordExists) {
      const stat = fs.statSync(h.pidSessionFile);
      expect.soft(stat.size).toBeLessThanOrEqual(64 * 1024);
      expect.soft(stat.mtimeMs).toBeGreaterThanOrEqual(Date.parse(h.initialLiveRow.startedAt));
      expect.soft(JSON.parse(fs.readFileSync(h.pidSessionFile, "utf8"))).toMatchObject({
        name: h.seatName,
        sessionId: activeConversation,
      });
    }

    expect
      .soft(h.probeClaudeResume, "expected captureClaudeSessionId hit without invoking fallback probeClaudeResume")
      .not.toHaveBeenCalled();
    const updated = registry.getSessionsForRig(h.rig.id)[0]!;
    expect.soft(updated.resumeToken).toBe(activeConversation);
    const snap = snapshotRepo.getSnapshot(result.snapshotId!)!;
    expect.soft(snap.data.sessions.find((s) => s.id === h.session.id)?.resumeToken).toBe(activeConversation);
  });

  it("does not emit current-PID session metadata when only OPENRIG_SESSION_NAME is set without explicit --name", async () => {
    const initialConversation = randomUUID();
    const resumedConversation = randomUUID();
    const seatName = "r00-provider-switch-fixture-work_worker";
    const h = await launchProviderSwitchFixtureSeat({
      storedToken: initialConversation,
      provenance: "scrape",
      seatName,
      args: ["--resume", resumedConversation, "--model", "fixture-model", "--permission-mode", "acceptEdits"],
      extraEnv: {
        OPENRIG_SESSION_NAME: seatName,
        ANTHROPIC_API_KEY: "synthetic-api",
      },
    });

    expect(h.readLaunches()).toEqual([
      {
        pid: h.childPid,
        conversation: resumedConversation,
        model: "fixture-model",
        permission: "acceptEdits",
        auth: "api",
        remembered: false,
      },
    ]);

    const result = await h.teardown.teardown(h.rig.id);
    expect(result.errors).toEqual([]);
    expect(result.sessionsKilled).toBe(1);
    expect(h.listClaudeProcesses).toHaveBeenCalled();

    expect
      .soft(fs.existsSync(h.pidSessionFile), "expected synthetic fixture not to emit <CLAUDE_CONFIG_DIR>/sessions/<pid>.json without explicit --name")
      .toBe(false);
    expect
      .soft(h.probeClaudeResume, "expected launch without explicit --name to fall through to fallback probeClaudeResume")
      .toHaveBeenCalledTimes(1);
    expect.soft(h.probeClaudeResume).toHaveBeenCalledWith(h.seatName, initialConversation, h.workDir, h.selectedConfigDir);

    const updated = registry.getSessionsForRig(h.rig.id)[0]!;
    expect.soft(updated.resumeToken).toBe(initialConversation);
    expect.soft(updated.resumeLastProbeStatus).toBe("inconclusive");
    const snap = snapshotRepo.getSnapshot(result.snapshotId!)!;
    expect.soft(snap.data.sessions.find((s) => s.id === h.session.id)?.resumeToken).toBe(initialConversation);
  });

});
