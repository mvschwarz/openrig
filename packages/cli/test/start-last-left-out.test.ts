// `rig start --last` after a reboot that follows a restore, against the real daemon routes: the restore gave every
// seat a new session row, so the newest periodic snapshot names their predecessors and no longer matches; one seat's
// new row carries no resume token and the seats have no saved startup context, so current state can't stand in
// either, and the id-based preview answers 404 no_snapshot. Before this fix the rig vanished from the output
// ("Daemon and kernel are up. No rigs to restore.", --json `{"status":"started","candidates":[],"keptDown":[],
// "restoredRigs":[]}`); now it is named with the daemon's reason and blockers, and still not restored.

import { afterEach, expect, it, vi } from "vitest";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { Command } from "commander";
import { createFullTestDb, createTestApp } from "../../daemon/test/helpers/test-app.js";
import type { TmuxAdapter } from "../../daemon/src/adapters/tmux.js";
import type { RuntimeAdapter } from "../../daemon/src/domain/runtime-adapter.js";
import { Reconciler } from "../../daemon/src/domain/reconciler.js";
import { snapshotMatchesCurrentOccupants } from "../../daemon/src/domain/rehydrate-eligibility.js";
import { startCommand } from "../src/commands/start.js";
import { DaemonClient } from "../src/client.js";
import { STATE_FILE, type DaemonState, type LifecycleDeps } from "../src/daemon-lifecycle.js";
import { allowFetchTarget, resetFetchAllowlist } from "./fetch-guard.js";

const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); resetFetchAllowlist(); });

const SEATS = [["dev.a", "claude-code"], ["dev.b", "claude-code"], ["dev.c", "codex"]] as const;
const TOKEN: Record<string, [string, string]> = {
  "dev.a": ["claude_id", "00000000-0000-4000-8000-00000000000a"],
  "dev.b": ["claude_id", "00000000-0000-4000-8000-00000000000b"],
  "dev.c": ["codex_id", "019a0000-0000-7000-8000-00000000000c"],
};

function readyAdapter(runtime: string): RuntimeAdapter {
  return {
    runtime,
    listInstalled: async () => [],
    project: async () => ({ projected: [], skipped: [], failed: [] }),
    deliverStartup: async () => ({ delivered: 0, failed: [] }),
    launchHarness: async () => ({ ok: true }),
    checkReady: async () => ({ ready: true }),
  } as unknown as RuntimeAdapter;
}

async function rebootedAfterRestore() {
  const db = createFullTestDb(); cleanup.push(() => db.close());
  const live = new Set<string>();
  const tmux = {
    hasSession: vi.fn(async (name: string) => live.has(name)),
    probeSession: vi.fn(async (name: string) => ({ state: live.has(name) ? "present" : "absent" })),
    createSession: vi.fn(async (name: string) => { live.add(name); return { ok: true }; }),
    killSession: vi.fn(async (name: string) => { live.delete(name); return { ok: true }; }),
    listSessions: vi.fn(async () => [...live].map((name) => ({ name }))),
    listWindows: vi.fn(async () => []),
    listPanes: vi.fn(async () => [{ id: "%fixture", index: 0, cwd: "/tmp", width: 80, height: 24, active: true }]),
    getPanePid: vi.fn(async () => 100),
    getPaneCommand: vi.fn(async () => "claude"),
    capturePaneContent: vi.fn(async () => "Claude Code\n❯"),
    sendText: vi.fn(async () => ({ ok: true })),
    sendKeys: vi.fn(async () => ({ ok: true })),
    setSessionOption: vi.fn(async () => ({ ok: true })),
    startServer: vi.fn(async () => ({ ok: true })),
  } as unknown as TmuxAdapter;
  const kernelBootTracker = { getStatus: () => ({ kernelState: "ready", agents: [], firstUnreadySince: null, variant: null, detail: null, lastBootFailure: null }) };
  const fixture = createTestApp(db, { tmux, appDeps: { kernelBootTracker } as never });
  const { rigRepo, sessionRegistry, snapshotCapture, restoreOrchestrator, eventBus } = fixture;

  // Three running seats in a pod, each with its conversation's token, and no saved startup context.
  const rig = rigRepo.createRig("rebooted");
  db.prepare("INSERT INTO pods (id, rig_id, label) VALUES (?, ?, ?)").run("pod", rig.id, "Dev");
  for (const [logicalId, runtime] of SEATS) {
    const node = rigRepo.addNode(rig.id, logicalId, { runtime, podId: "pod", cwd: "/tmp" });
    const name = `${logicalId.replace(".", "-")}@rebooted`;
    const row = sessionRegistry.registerSession(node.id, name);
    sessionRegistry.updateStatus(row.id, "running");
    sessionRegistry.updateStartupStatus(row.id, "ready");
    sessionRegistry.updateBinding(node.id, { tmuxSession: name });
    sessionRegistry.updateResumeToken(row.id, ...TOKEN[logicalId]!, "hook");
    live.add(name);
  }
  const periodic = snapshotCapture.captureSnapshot(rig.id, "auto-periodic");
  // A reboot: every tmux session is gone, and the boot reconciler marks the lost rows detached.
  const reboot = async () => {
    live.clear();
    await new Reconciler({ db, sessionRegistry, eventBus, tmuxAdapter: tmux, readProcesses: async () => [] }).reconcile(rig.id);
  };
  await reboot();

  // The by-hand recovery: restore that periodic snapshot by id. Every seat gets a new session row.
  const adapters = Object.fromEntries(["claude-code", "codex", "terminal"].map((r) => [r, readyAdapter(r)]));
  const restored = await restoreOrchestrator.restore(periodic.id, { adapters, fsOps: { exists: () => true } });
  expect(restored.ok).toBe(true);
  const current = () => db.prepare(
    `SELECT s.id, n.logical_id AS seat, s.status, s.resume_token AS token FROM sessions s JOIN nodes n ON n.id = s.node_id
      WHERE n.rig_id = ? AND s.status NOT IN ('superseded', 'exited') ORDER BY n.logical_id`,
  ).all(rig.id) as Array<{ id: string; seat: string; status: string; token: string | null }>;
  const restoredRows = current();
  expect(restoredRows.map((row) => [row.seat, row.status])).toEqual([["dev.a", "running"], ["dev.b", "running"], ["dev.c", "running"]]);
  const captured = new Set(periodic.data.sessions.map((session) => session.id));
  expect(restoredRows.every((row) => !captured.has(row.id))).toBe(true);
  // The Claude seats' hooks record the resumed conversation on their new rows. The Codex seat's restore ended
  // attention_required (its process check did not pass here), so restore did not record the token on its new row.
  if (restored.ok) expect(restored.result.nodes.find((node) => node.logicalId === "dev.c")?.status).toBe("attention_required");
  for (const row of restoredRows) if (row.seat !== "dev.c") sessionRegistry.updateResumeToken(row.id, ...TOKEN[row.seat]!, "hook");
  expect(current().find((row) => row.seat === "dev.c")?.token).toBeNull();

  // The next reboot, before a later periodic snapshot names the restored rows.
  await reboot();
  return { fixture, db, rig, periodic, current };
}

async function serveDaemon(app: ReturnType<typeof createTestApp>["app"]): Promise<number> {
  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const s = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, () => resolve(s));
  });
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const port = (server.address() as AddressInfo).port;
  allowFetchTarget(`http://127.0.0.1:${port}`);
  return port;
}

function startCmd(port: number): Command {
  const lifecycleDeps: LifecycleDeps = {
    acquireStartLock: () => ({ recordChild: vi.fn(), release: vi.fn() }),
    spawn: vi.fn(() => ({ pid: 1, unref: vi.fn() }) as never),
    fetch: vi.fn(async () => ({ ok: true })) as never,
    kill: vi.fn(() => true),
    readFile: vi.fn((p: string) => p === STATE_FILE
      ? JSON.stringify({ pid: 123, port, db: "t.sqlite", startedAt: "2026-11-23T00:00:00Z" } as DaemonState) : null),
    writeFile: vi.fn(),
    removeFile: vi.fn(),
    exists: vi.fn((p: string) => p === STATE_FILE),
    mkdirp: vi.fn(),
    openForAppend: vi.fn(() => 3),
    isProcessAlive: vi.fn(() => true),
  };
  const prog = new Command();
  prog.exitOverride();
  prog.addCommand(startCommand({ lifecycleDeps, clientFactory: (url: string) => new DaemonClient(url) }));
  return prog;
}

async function run(prog: Command, args: string[]) {
  const logs: string[] = [];
  const log = console.log, error = console.error, exitCode = process.exitCode;
  process.exitCode = undefined;
  console.log = (...parts: unknown[]) => logs.push(parts.join(" "));
  console.error = (...parts: unknown[]) => logs.push(parts.join(" "));
  try { await prog.parseAsync(["node", "rig", "start", ...args]); }
  finally { console.log = log; console.error = error; }
  const code = process.exitCode;
  process.exitCode = exitCode;
  return { logs, exitCode: code };
}

it("rig start --last names a rig whose newest snapshot predates a restore, with the daemon's reason, and restores nothing", async () => {
  const { fixture, db, rig, periodic, current } = await rebootedAfterRestore();
  // The cause, at the daemon: the newest auto-periodic snapshot (the one a person might restore by id) names the seats' predecessors, no
  // snapshot of the rig names the current occupants, and the preview `rig start` makes answers 404.
  const live = fixture.rigRepo.getRig(rig.id)!;
  expect(snapshotMatchesCurrentOccupants(db, live, periodic)).toBe(false);
  expect(fixture.snapshotRepo.listSnapshots(rig.id).some((snapshot) => snapshotMatchesCurrentOccupants(db, live, snapshot))).toBe(false);
  const preview = await fixture.app.request(`/api/rigs/${rig.id}/up`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ plan: true }),
  });
  expect(preview.status).toBe(404);
  const body = await preview.json() as { error: string; code: string; blockers: string[] };
  expect(body.code).toBe("no_snapshot");
  expect(body.error).toContain("its restore snapshots name an older occupant");
  expect(body.blockers).toEqual(["node dev.c is pod-aware but has no persisted startup context or resume token"]);
  const before = current();

  const port = await serveDaemon(fixture.app);
  const json = await run(startCmd(port), ["--last", "--json"]);
  const parsed = JSON.parse(json.logs.find((line) => line.startsWith("{"))!);
  expect(parsed).toMatchObject({ status: "started", candidates: [], keptDown: [], restoredRigs: [] });
  expect(parsed.leftOut).toEqual([{ rigId: rig.id, rigName: "rebooted", code: "no_snapshot", message: body.error, blockers: body.blockers }]);
  expect(parsed.previewErrors).toBeUndefined();
  expect(json.exitCode).toBeUndefined();

  const human = await run(startCmd(port), ["--last"]);
  const output = human.logs.join("\n");
  expect(output).toContain(`rebooted: left out, not restored -- ${body.error} (no_snapshot)`);
  expect(output).toContain("    node dev.c is pod-aware but has no persisted startup context or resume token");
  expect(output).toContain("Daemon and kernel are up. No rig restored: 1 rig(s) left out (see above).");
  expect(output).not.toContain("No rigs to restore");
  expect(human.exitCode).toBeUndefined();

  // Which rigs restore is unchanged: nothing was launched, and no predecessor's conversation came back.
  expect(current()).toEqual(before);
});
