import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SessionTransport } from "../src/domain/session-transport.js";
import { EventBus } from "../src/domain/event-bus.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { activityRoutes } from "../src/routes/activity.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { NativeProcessRow } from "../src/domain/native-process-lineage.js";

const original = "00000000-0000-4000-8000-000000000596";
const rotated = "00000000-0000-4000-8000-000000000597";
const name = "test-c@rotation";
const screen = "─────────\n❯\u00a0\n─────────\n  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents\n";

type Mode = "unchanged" | "rotation" | "duplicate-hook" | "delayed-hook" | "shim"
  | "unknown" | "foreign-runtime" | "changed-process" | "changed-occupant"
  | "changed-pane" | "changed-after-paste" | "stale-hook-foreign-runtime";

// The hook, SQLite registry and transport are real. Only process/tmux observations
// and writes are substituted: this does not claim to execute native Claude /clear.
async function sendAfterHook(mode: Mode) {
  const db = createDb();
  try {
    migrate(db, ALL_MIGRATIONS);
    const rigRepo = new RigRepository(db), registry = new SessionRegistry(db), eventBus = new EventBus(db);
    const rig = rigRepo.createRig("rotation");
    const node = rigRepo.addNode(rig.id, "test.c", { runtime: "claude-code" });
    const session = registry.registerSession(node.id, name);
    registry.updateStatus(session.id, "running");
    registry.updateBinding(node.id, { tmuxSession: name, tmuxPane: "%1" });
    const store = new AgentActivityStore({ db, eventBus });
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("agentActivityStore" as never, store as never);
      c.set("activityHookToken" as never, "fixture" as never);
      c.set("sessionRegistry" as never, registry as never);
      c.set("eventBus" as never, eventBus as never);
      await next();
    });
    app.route("/api/activity", activityRoutes);
    const hook = async (token: string) => {
      const response = await app.request("/api/activity/hooks", {
        method: "POST",
        headers: { "content-type": "application/json", "x-openrig-activity-token": "fixture" },
        body: JSON.stringify({ eventFamily: "session_identity", sessionName: name, runtime: "claude-code", sessionId: token }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ tokenPersisted: true });
    };
    await hook(original);
    if (mode !== "unchanged") await hook(rotated);
    if (mode === "duplicate-hook") await hook(rotated);
    // Equal-rank hooks can arrive late today. This patch must not treat their
    // arrival as evidence that overrides an independently observed conflict.
    if (mode === "delayed-hook" || mode === "stale-hook-foreign-runtime") await hook(original);

    const foreign = mode === "foreign-runtime" || mode === "stale-hook-foreign-runtime";
    const startedAt = "Sat Oct  3 01:00:00 2026";
    const rows: NativeProcessRow[] = [
      { pid: 100, ppid: 1, pgid: 100, tpgid: 101, executableName: "bash", command: "-bash", startedAt },
      { pid: 101, ppid: 100, pgid: 101, tpgid: 101, executableName: "sh", command: "/bin/sh /fixture/launch", startedAt },
      { pid: 102, ppid: 101, pgid: 101, tpgid: 101, executableName: foreign ? "codex" : "claude",
        command: foreign ? "codex resume other" : `/opt/claude --session-id ${original}`, startedAt },
    ];
    if (mode === "shim") rows.push({ ...rows[2]!, pid: 103, ppid: 102,
      command: `/child/claude --session-id ${original} --settings /fixture/settings.json` });
    let reads = 0;
    const calls: string[] = [];
    const tmux = {
      hasSession: async () => true,
      probeSession: async () => ({ state: "present" }),
      getPanePid: async () => 100,
      getPaneCommand: async () => "sh",
      listPanes: async () => [{ id: mode === "changed-pane" ? "%2" : "%1" }],
      capturePaneContent: async () => screen,
      sendText: async () => {
        calls.push("text");
        if (mode === "changed-after-paste") registry.updateBinding(node.id, { tmuxSession: name, tmuxPane: "%2" });
        return { ok: true };
      },
      sendKeys: async () => { calls.push("enter"); return { ok: true }; },
    } as unknown as TmuxAdapter;
    const listProcesses = async () => {
      reads++;
      if (mode === "unknown") throw new Error("fixture unavailable");
      if (mode === "changed-occupant" && reads === 1) registry.mintOccupantTenure(node.id, "fresh");
      return mode === "changed-process" && reads === 2
        ? rows.map(row => row.pid === 102 ? { ...row, startedAt: "replacement" } : row) : rows;
    };
    const transport = new SessionTransport({ db, rigRepo, sessionRegistry: registry, eventBus,
      tmuxAdapter: tmux, listProcesses, sleep: async () => {} });
    const result = await transport.send(name, "isolated rotation message");
    return { result, calls, stored: db.prepare("SELECT resume_token FROM sessions WHERE id = ?").get(session.id) };
  } finally { db.close(); }
}

describe("ordinary Claude delivery after an in-process conversation change (#596)", () => {
  it.each(["rotation", "duplicate-hook", "shim", "unknown"] as const)("%s delivers once with uncertainty, not a false identity claim", async mode => {
    const { result, calls, stored } = await sendAfterHook(mode);
    expect(stored).toEqual({ resume_token: rotated });
    expect(result.ok).toBe(true);
    expect(result.warning).toContain("without verified native identity");
    expect(calls).toEqual(["text", "enter"]);
  });

  it.each(["unchanged", "delayed-hook"] as const)("%s retains existing hook storage and send behavior", async mode => {
    const { result, calls, stored } = await sendAfterHook(mode);
    expect(stored).toEqual({ resume_token: original });
    expect(result.ok).toBe(true);
    expect(calls).toEqual(["text", "enter"]);
  });

  it.each(["foreign-runtime", "stale-hook-foreign-runtime", "changed-occupant", "changed-process", "changed-pane"] as const)("%s still refuses before writing", async mode => {
    const { result, calls } = await sendAfterHook(mode);
    expect(result).toMatchObject({ ok: false, sent: false, reason: "target_runtime_conflict" });
    expect(calls).toEqual([]);
  });

  it("a recipient change after paste still prevents Enter", async () => {
    const { result, calls } = await sendAfterHook("changed-after-paste");
    expect(result).toMatchObject({ ok: false, sent: true, reason: "target_runtime_conflict" });
    expect(calls).toEqual(["text"]);
  });
});
