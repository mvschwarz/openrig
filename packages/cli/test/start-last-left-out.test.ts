// `rig start --last` after a reboot that follows a restore, against the real daemon routes: the restore gave every
// seat a new session row, so the newest periodic snapshot names their predecessors and no longer matches. One seat's
// new row carries no resume token and the seats have no saved startup context.
// - That seat's current occupant is still known (its one current row), so current state stands in: the other seats
//   resume from their own current rows, and that seat keeps its row and null token and waits for a decision. Before
//   this, the whole rig was left out (404 no_snapshot), and nothing came back.
// - When that seat's current occupant is ambiguous, nothing is guessed: the rig is still left out and named with the
//   daemon's reason and blockers, as #3823 reports it. Before #3823 the rig vanished from the output ("Daemon and kernel
//   are up. No rigs to restore.", --json `{"status":"started","candidates":[],"keptDown":[],"restoredRigs":[]}`).

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
// Each seat's conversation when the periodic snapshot was taken (what a by-id restore of it resumes).
const TOKEN: Record<string, [string, string]> = {
  "dev.a": ["claude_id", "00000000-0000-4000-8000-00000000000a"],
  "dev.b": ["claude_id", "00000000-0000-4000-8000-00000000000b"],
  "dev.c": ["codex_id", "019a0000-0000-7000-8000-00000000000c"],
};
// What the Claude seats' hooks record on their new rows after that restore: the resumed conversation moved to a new id.
const CURRENT: Record<string, [string, string]> = {
  "dev.a": ["claude_id", "00000000-0000-4000-8000-0000000000aa"],
  "dev.b": ["claude_id", "00000000-0000-4000-8000-0000000000bb"],
};

type Launch = { runtime: string; name: string; resumeToken?: string };

/** `onLaunch` stands in for what the harness does once it starts, such as Claude's SessionStart hook recording the
 *  conversation it resumed on the session's row. */
function readyAdapter(runtime: string, launches: Launch[], onLaunch: (launch: Launch) => void): RuntimeAdapter {
  return {
    runtime,
    listInstalled: async () => [],
    project: async () => ({ projected: [], skipped: [], failed: [] }),
    deliverStartup: async () => ({ delivered: 0, failed: [] }),
    launchHarness: async (_binding: unknown, opts: { name: string; resumeToken?: string }) => {
      const launch = { runtime, name: opts.name, resumeToken: opts.resumeToken };
      launches.push(launch);
      onLaunch(launch);
      return { ok: true };
    },
    checkReady: async () => ({ ready: true }),
  } as unknown as RuntimeAdapter;
}

/** `ambiguousTokenless`: the token-less seat also keeps a second current row (a registered launch that never recorded a
 *  token and was never superseded), so which row is its occupant can't be told. */
async function rebootedAfterRestore(opts: { ambiguousTokenless?: boolean } = {}) {
  const db = createFullTestDb(); cleanup.push(() => db.close());
  const live = new Set<string>();
  const created: string[] = [];
  const tmux = {
    hasSession: vi.fn(async (name: string) => live.has(name)),
    probeSession: vi.fn(async (name: string) => ({ state: live.has(name) ? "present" : "absent" })),
    createSession: vi.fn(async (name: string) => { live.add(name); created.push(name); return { ok: true }; }),
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
  const launches: Launch[] = [];
  // A resumed Claude starts as `claude --resume <id>` and its hook records that conversation on the new row. Nothing
  // starts or records the Codex seat's, so its process check fails.
  const processes = [{ pid: 100, ppid: 1, command: "bash" }];
  const hook = (launch: Launch) => {
    if (launch.runtime !== "claude-code" || !launch.resumeToken) return;
    processes.push({ pid: 101 + processes.length, ppid: 100, command: `claude --resume ${launch.resumeToken}` });
    const row = db.prepare("SELECT id FROM sessions WHERE session_name = ? ORDER BY id DESC LIMIT 1").get(launch.name) as { id: string };
    fixture.sessionRegistry.updateResumeToken(row.id, "claude_id", launch.resumeToken, "hook");
  };
  const adapters = Object.fromEntries(["claude-code", "codex", "terminal"].map((r) => [r, readyAdapter(r, launches, hook)]));
  const kernelBootTracker = { getStatus: () => ({ kernelState: "ready", agents: [], firstUnreadySince: null, variant: null, detail: null, lastBootFailure: null }) };
  // The routes restore with these adapters, as startup wires them.
  const fixture = createTestApp(db, { tmux, adapters, listProcesses: async () => [...processes], appDeps: { kernelBootTracker } as never });
  const { rigRepo, sessionRegistry, snapshotCapture, restoreOrchestrator, eventBus } = fixture;

  // Three running seats in a pod, each with its conversation's token, and no saved startup context.
  const rig = rigRepo.createRig("rebooted");
  db.prepare("INSERT INTO pods (id, rig_id, label) VALUES (?, ?, ?)").run("pod", rig.id, "Dev");
  const nodeIds: Record<string, string> = {};
  for (const [logicalId, runtime] of SEATS) {
    const node = rigRepo.addNode(rig.id, logicalId, { runtime, podId: "pod", cwd: "/tmp" });
    nodeIds[logicalId] = node.id;
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
  const restored = await restoreOrchestrator.restore(periodic.id, { adapters, fsOps: { exists: () => true } });
  expect(restored.ok).toBe(true);
  const current = () => db.prepare(
    `SELECT s.id, n.logical_id AS seat, s.status, s.resume_token AS token FROM sessions s JOIN nodes n ON n.id = s.node_id
      WHERE n.rig_id = ? AND s.status NOT IN ('superseded', 'exited') ORDER BY n.logical_id, s.id`,
  ).all(rig.id) as Array<{ id: string; seat: string; status: string; token: string | null }>;
  const restoredRows = current();
  expect(restoredRows.map((row) => [row.seat, row.status])).toEqual([["dev.a", "running"], ["dev.b", "running"], ["dev.c", "running"]]);
  const captured = new Set(periodic.data.sessions.map((session) => session.id));
  expect(restoredRows.every((row) => !captured.has(row.id))).toBe(true);
  // The Claude seats' hooks recorded the resumed conversation on their new rows, which then moved to a new id. The
  // Codex seat's restore ended attention_required (its process check did not pass here), so restore did not record
  // the token on its new row.
  if (restored.ok) expect(restored.result.nodes.find((node) => node.logicalId === "dev.c")?.status).toBe("attention_required");
  for (const row of restoredRows) if (row.seat !== "dev.c") sessionRegistry.updateResumeToken(row.id, ...CURRENT[row.seat]!, "hook");
  expect(current().find((row) => row.seat === "dev.c")?.token).toBeNull();
  if (opts.ambiguousTokenless) {
    const extra = sessionRegistry.registerSession(nodeIds["dev.c"]!, "dev-c@rebooted");
    sessionRegistry.updateStatus(extra.id, "detached");
  }

  // The next reboot, before a later periodic snapshot names the restored rows.
  await reboot();
  // Only what `rig start --last` launches from here on.
  launches.length = 0;
  created.length = 0;
  return { fixture, db, rig, periodic, current, launches, created, nodeIds };
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

const plan = (app: ReturnType<typeof createTestApp>["app"], path: string, body: Record<string, unknown>) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, plan: true }) });

it("rig start --last after the reboot brings the other seats back on their own conversations, and the token-less seat waits for a decision", async () => {
  const { fixture, db, rig, periodic, current, launches, created, nodeIds } = await rebootedAfterRestore();
  // The cause, at the daemon: no stored snapshot names the current occupants, and dev.c's current row has no token.
  const liveRig = fixture.rigRepo.getRig(rig.id)!;
  expect(snapshotMatchesCurrentOccupants(db, liveRig, periodic)).toBe(false);
  expect(fixture.snapshotRepo.listSnapshots(rig.id).some((snapshot) => snapshotMatchesCurrentOccupants(db, liveRig, snapshot))).toBe(false);
  const before = current();
  const tokenless = before.find((row) => row.seat === "dev.c")!;
  expect(tokenless).toMatchObject({ status: "detached", token: null });

  // Both selection paths stand in with current state (one shared rule), and forecast the same seats: rig start's
  // id-based route and the name-based route `rig up <rig> --existing` takes. Neither writes anything.
  const snapshotsBefore = fixture.snapshotRepo.listSnapshots(rig.id).length;
  for (const [path, body] of [[`/api/rigs/${rig.id}/up`, {}], ["/api/up", { sourceRef: "rebooted" }]] as const) {
    const preview = await plan(fixture.app, path, body);
    expect(preview.status).toBe(200);
    const forecast = await preview.json() as { wouldCaptureCurrentState: boolean; nodes: Array<{ logicalId: string; intendedAction: string; occupantSessionId: string | null }> };
    expect(forecast.wouldCaptureCurrentState).toBe(true);
    expect(forecast.nodes.map((node) => [node.logicalId, node.intendedAction])).toEqual([
      ["dev.a", "resume-original"], ["dev.b", "resume-original"], ["dev.c", "awaiting-decision"],
    ]);
    expect(forecast.nodes.find((node) => node.logicalId === "dev.c")?.occupantSessionId).toBe(tokenless.id);
  }
  expect(fixture.snapshotRepo.listSnapshots(rig.id)).toHaveLength(snapshotsBefore);
  expect(current()).toEqual(before);

  const devCRows = () => (db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE node_id = ?").get(nodeIds["dev.c"]!) as { n: number }).n;
  const devCRowsBefore = devCRows();
  const port = await serveDaemon(fixture.app);
  const json = await run(startCmd(port), ["--last", "--json"]);
  const parsed = JSON.parse(json.logs.find((line) => line.startsWith("{"))!);
  expect(parsed.leftOut).toBeUndefined();
  expect(parsed.previewErrors).toBeUndefined();
  expect(parsed.candidates).toEqual([{ rigName: "rebooted", lifecycleState: expect.any(String) }]);
  expect(parsed.restoredRigs).toHaveLength(1);
  const restoredRig = parsed.restoredRigs[0] as { status: string; nodes: Array<{ logicalId: string; status: string; error?: string }>; warnings?: string[] };
  expect(restoredRig.status).toBe("partially_restored");
  expect(restoredRig.nodes.map((node) => [node.logicalId, node.status])).toEqual([["dev.a", "resumed"], ["dev.b", "resumed"], ["dev.c", "awaiting-decision"]]);
  expect(restoredRig.nodes.find((node) => node.logicalId === "dev.c")?.error).toContain("Original session unresumable: no resume token was captured for this seat. No session was started.");
  expect(restoredRig.warnings).toContain("Existing restore snapshots named an older occupant; captured current DB state as auto-rehydrate snapshot for reboot recovery.");
  // A seat waiting for a decision is not a clean restore: the existing exit-code contract.
  expect(json.exitCode).toBe(1);

  // The siblings resumed their own current conversations, not the periodic snapshot's older ones.
  expect(launches.map((launch) => [launch.runtime, launch.name, launch.resumeToken])).toEqual([
    ["claude-code", "dev-a@rebooted", CURRENT["dev.a"]![1]],
    ["claude-code", "dev-b@rebooted", CURRENT["dev.b"]![1]],
  ]);
  // dev.c: no blank start, no terminal, no token from an older row; its current row is untouched.
  expect(created).not.toContain("dev-c@rebooted");
  expect(launches.some((launch) => launch.resumeToken === TOKEN["dev.c"]![1])).toBe(false);
  const after = current();
  expect(after.filter((row) => row.seat === "dev.c")).toEqual([tokenless]);
  expect(devCRows()).toBe(devCRowsBefore);
  expect(after.filter((row) => row.seat !== "dev.c").map((row) => [row.seat, row.status, row.token])).toEqual([
    ["dev.a", "running", CURRENT["dev.a"]![1]], ["dev.b", "running", CURRENT["dev.b"]![1]],
  ]);
  // The current-state snapshot restore ran from records dev.c's own row, null token included.
  const rehydrate = fixture.snapshotRepo.listSnapshots(rig.id).find((snapshot) => snapshot.kind === "auto-rehydrate")!;
  expect(rehydrate.data.activeOccupantsByNode?.[nodeIds["dev.c"]!]).toEqual({ kind: "resolved", sessionId: tokenless.id });
  expect(rehydrate.data.sessions.find((session) => session.id === tokenless.id)?.resumeToken ?? null).toBeNull();
});

it("rig start --last prints the restored seats and the decision the token-less seat waits for", async () => {
  const { fixture } = await rebootedAfterRestore();
  const human = await run(startCmd(await serveDaemon(fixture.app)), ["--last"]);
  const output = human.logs.join("\n");
  expect(output).toContain("rebooted: partially_restored");
  expect(output).toContain("    dev.a: resumed");
  expect(output).toContain("    dev.b: resumed");
  expect(output).toContain("    dev.c: awaiting-decision -- Original session unresumable: no resume token was captured for this seat.");
  expect(output).toContain("    dev.c: awaiting-decision -- to fresh-prime: rig seat launch dev.c@rebooted --fresh");
  expect(output).not.toContain("left out");
  expect(human.exitCode).toBe(1);
});

it("when the token-less seat's occupant is ambiguous, nothing is guessed: rig start --last names the rig as left out and restores nothing", async () => {
  const { fixture, db, rig, periodic, current, launches, created } = await rebootedAfterRestore({ ambiguousTokenless: true });
  // The cause, at the daemon: the newest auto-periodic snapshot (the one a person might restore by id) names the seats' predecessors, no
  // snapshot of the rig names the current occupants, and the preview `rig start` makes answers 404.
  const liveRig = fixture.rigRepo.getRig(rig.id)!;
  expect(snapshotMatchesCurrentOccupants(db, liveRig, periodic)).toBe(false);
  expect(fixture.snapshotRepo.listSnapshots(rig.id).some((snapshot) => snapshotMatchesCurrentOccupants(db, liveRig, snapshot))).toBe(false);
  expect(current().filter((row) => row.seat === "dev.c").map((row) => [row.status, row.token])).toEqual([["detached", null], ["detached", null]]);
  const preview = await plan(fixture.app, `/api/rigs/${rig.id}/up`, {});
  expect(preview.status).toBe(404);
  const body = await preview.json() as { error: string; code: string; blockers: string[] };
  expect(body.code).toBe("no_snapshot");
  expect(body.error).toContain("its restore snapshots name an older occupant");
  expect(body.blockers).toEqual(["node dev.c is pod-aware but has no persisted startup context or resume token"]);
  // The name-based route agrees.
  expect((await plan(fixture.app, "/api/up", { sourceRef: "rebooted" })).status).toBe(404);
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
  expect(launches).toEqual([]);
  expect(created).toEqual([]);
});
