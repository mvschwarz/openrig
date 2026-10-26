import { expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { upCommand } from "../../cli/src/commands/up.js";
import { DaemonClient } from "../../cli/src/client.js";
import type { LifecycleDeps } from "../../cli/src/daemon-lifecycle.js";
import { CommunityHarnessRuntimeAdapter } from "../src/adapters/community-harness-runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";

it.each([false, true])("community contract: exact up --existing reopens the saved conversation, or refuses missing=%s without a fresh launch", async missing => {
  const home = mkdtempSync(join(tmpdir(), "community-existing-"));
  const previousHome = process.env.OPENRIG_HOME;
  const previousExit = process.exitCode;
  const db = createFullTestDb();
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    process.env.OPENRIG_HOME = home;
    process.exitCode = undefined;
    const presets = join(home, "community-harnesses");
    mkdirSync(presets);
    writeFileSync(join(presets, "synth.yaml"), "format: 1\nname: synth\ncommand: synth-launch\nmaintainer: Example\nlimits: []\nlaunch_result: true\nresume: true\nfirst_input: true\n");
    const sendShellCommand = vi.fn(async (_session: string, command: string) => {
      const file = /OPENRIG_LAUNCH_RESULT='([^']+)'/.exec(command)![1]!;
      const attempt = /OPENRIG_LAUNCH_ATTEMPT=(\S+)/.exec(command)![1]!;
      writeFileSync(file, JSON.stringify({ format: 1, attempt, harness: "synth", producer: "synthetic-launcher 1",
        ...(missing ? { error: "missing" } : { nativeRef: "saved-chat" }) }));
      return { ok: true as const };
    });
    const tmux = { createSession: vi.fn(async () => ({ ok: true })), hasSession: async () => false,
      listSessions: async () => [], listWindows: async () => [],
      listPanes: async () => [{ id: "%1", index: 0, cwd: home, width: 80, height: 24, active: true }],
      getPanePid: async () => 1234, getPaneCommand: async () => "node",
      sendText: vi.fn(async () => ({ ok: true })), sendKeys: vi.fn(async () => ({ ok: true })),
      capturePaneContent: async () => "synthetic harness", sendShellCommand } as unknown as TmuxAdapter;
    const adapter = new CommunityHarnessRuntimeAdapter("synth", { tmux: { ...tmux, hasSession: async () => true },
      presetsDir: () => presets, launchResultRoot: () => join(home, "results") });
    const app = createTestApp(db, { tmux, adapters: { synth: adapter } });
    const rig = app.rigRepo.createRig("community-existing");
    db.prepare("INSERT INTO pods (id, rig_id, label) VALUES ('p1', ?, 'Dev')").run(rig.id);
    const node = app.rigRepo.addNode(rig.id, "dev.worker", { runtime: "synth", podId: "p1", cwd: home });
    const session = app.sessionRegistry.registerSession(node.id, "dev-worker@community-existing");
    app.sessionRegistry.recordCommunityHarnessSelection(session.id, "synth");
    app.sessionRegistry.recordLauncherReportedToken(session.id, "community:synth", "saved-chat");
    app.sessionRegistry.updateStatus(session.id, "running");
    db.prepare("INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, '[]', '[]', '[]', 'synth')").run(node.id);
    app.snapshotCapture.captureSnapshot(rig.id, "auto-pre-down");
    app.sessionRegistry.updateStatus(session.id, "exited");
    const client = new DaemonClient("http://in-process.invalid");
    const requests: string[] = [];
    const request = async (path: string, body?: unknown) => {
      requests.push(path);
      const response = await app.app.request(path, body === undefined ? {} : {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      return { status: response.status, data: await response.json() };
    };
    vi.spyOn(client, "get").mockImplementation(request as never);
    vi.spyOn(client, "post").mockImplementation(request as never);
    const lifecycle = { readFile: () => null, exists: () => false, isProcessAlive: () => true,
      fetch: async () => ({ ok: true }), spawn: () => { throw new Error("must not start a daemon"); } } as unknown as LifecycleDeps;
    const cmd = new Command().addCommand(upCommand({ lifecycleDeps: lifecycle, clientFactory: () => client,
      preflightExec: async () => "tmux 3.6a" }));
    await cmd.parseAsync(["node", "rig", "up", "community-existing", "--existing", "--json"]);
    const result = JSON.parse(log.mock.calls.at(-1)![0] as string);
    expect(requests.filter(p => p === "/api/up")).toHaveLength(1);
    expect(requests.some(p => p.startsWith("/api/specs/library"))).toBe(false);
    expect(result.status).toBe("restored");
    expect(result.nodes, JSON.stringify(result)).toContainEqual(expect.objectContaining({ nodeId: node.id,
      status: missing ? "awaiting-decision" : "resumed" }));
    expect(sendShellCommand).toHaveBeenCalledTimes(1);
    expect(sendShellCommand.mock.calls[0]![1]).toContain("OPENRIG_RESUME_REF='saved-chat'");
    expect(sendShellCommand.mock.calls[0]![1]).not.toContain("OPENRIG_CONVERSATION=");
    expect(sendShellCommand.mock.calls[0]![1]).not.toMatch(/OPENRIG_FIRST_INPUT='/);
    expect(tmux.sendText).not.toHaveBeenCalled();
    if (!missing) {
      expect(process.exitCode ?? 0).toBe(0);
      expect(db.prepare("SELECT resume_token FROM sessions WHERE node_id=? ORDER BY id DESC LIMIT 1").get(node.id))
        .toEqual({ resume_token: "saved-chat" });
    }
  } finally {
    log.mockRestore();
    process.exitCode = previousExit;
    if (previousHome === undefined) delete process.env.OPENRIG_HOME; else process.env.OPENRIG_HOME = previousHome;
    db.close();
    rmSync(home, { recursive: true, force: true });
  }
});
