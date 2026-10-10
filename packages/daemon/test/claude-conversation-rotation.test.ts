import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SessionTransport } from "../src/domain/session-transport.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { EventBus } from "../src/domain/event-bus.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { activityRoutes } from "../src/routes/activity.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { NativeProcessRow } from "../src/domain/native-process-lineage.js";
import { observeClaudeDelivery, verifyClaudePaneProcess } from "../src/domain/native-process-lineage.js";

const original = "00000000-0000-4000-8000-000000000596";
const rotated = "00000000-0000-4000-8000-000000000597";
const name = "test-c@rotation";
const screen = "─────────\n❯\u00a0\n─────────\n  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents\n";

type Mode = "unchanged" | "rotation" | "duplicate-hook" | "delayed-hook" | "shim"
  | "unknown" | "foreign-runtime" | "changed-process" | "changed-occupant"
  | "changed-pane" | "changed-after-paste" | "stale-hook-foreign-runtime"
  | "N1-settings-before" | "settings-after" | "plain-wrong-token" | "lone-wrong-shim"
  | "delayed-rotated-hook" | "probe-refresh";
const tokenOnlyModes = ["N1-settings-before", "settings-after", "plain-wrong-token", "lone-wrong-shim"] as const;

// The hook, SQLite registry and transport are real. Only process/tmux observations
// and writes are substituted: this does not claim to execute native Claude /clear.
async function sendAfterHook(mode: Mode, consumer: "send" | "wake" | "handoff" = "send") {
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
    const hook = async (token: string, occurredAt?: string) => {
      const response = await app.request("/api/activity/hooks", {
        method: "POST",
        headers: { "content-type": "application/json", "x-openrig-activity-token": "fixture" },
        body: JSON.stringify({ eventFamily: "session_identity", sessionName: name, runtime: "claude-code", sessionId: token, occurredAt }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ tokenPersisted: true });
    };
    await hook(original);
    // These mismatched fixtures never rotate: even an initial hook is not proof
    // of a later conversation transition. Their ordinary delivery is unverified.
    const tokenOnly = tokenOnlyModes.some(value => value === mode) || mode === "probe-refresh";
    if (mode !== "unchanged" && !tokenOnly) {
      await hook(rotated, mode === "delayed-rotated-hook" ? "2000-01-01T00:00:00Z" : undefined);
    }
    if (mode === "duplicate-hook") await hook(rotated);
    if (mode === "probe-refresh") {
      db.prepare("UPDATE sessions SET resume_last_verified = ? WHERE id = ?").run("2000-01-01 00:00:00", session.id);
      registry.markResumeProbeResult(session.id, "resumable");
      expect(db.prepare("SELECT resume_token, resume_provenance, resume_last_verified FROM sessions WHERE id = ?").get(session.id))
        .toMatchObject({ resume_token: original, resume_provenance: "hook", resume_last_verified: expect.not.stringContaining("2000-01-01") });
    }
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
    if (tokenOnly) {
      rows[2]!.command = `/opt/claude ${mode === "N1-settings-before" ? "--settings /fixture/settings.json " : ""}--session-id ${rotated}${mode === "settings-after" ? " --settings /fixture/settings.json" : ""}`;
      if (mode === "lone-wrong-shim") rows.push({ ...rows[2]!, pid: 103, ppid: 102,
        command: "/child/claude --settings /fixture/settings.json" });
    }
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
    const send = vi.spyOn(transport, "send"); // Call through the actual delivery path for every consumer.
    if (consumer === "send") await transport.send(name, "isolated rotation message");
    else {
      const queue = new QueueRepository(db, eventBus, { transport, loadHumanRegistry: () => ({ ok: true, entities: [] }) });
      if (consumer === "wake") {
        const wake = await (queue as unknown as {
          performWakeSend(id: string, destination: string, sender: string): Promise<{ classified: string }>;
        }).performWakeSend("fixture-q596", name, "fixture-sender@rotation");
        expect(wake.classified).toBe("indeterminate");
      } else {
        queue.attachOutbox(new OutboxHandler(db));
        const source = await queue.create({ sourceSession: "orch@rotation", destinationSession: "owner@rotation", body: "review", nudge: false });
        const { created } = await queue.handoff({ qitemId: source.qitemId, fromSession: "owner@rotation", toSession: name });
        expect(queue.getById(source.qitemId)?.state).toBe("handed-off");
        await vi.waitFor(() => expect(queue.getById(created.qitemId)?.lastNudgeResult).toBe("delivered-ack-pending"));
      }
    }
    expect(send).toHaveBeenCalledTimes(1);
    const result = await send.mock.results[0]!.value;
    const stored = db.prepare("SELECT resume_token FROM sessions WHERE id = ?").get(session.id) as { resume_token: string };
    // Independent of delivery effects: strict identity stays unproved for a mismatch.
    const input = { target: "%1", tmux, listProcesses: async () => rows, expectedToken: stored.resume_token };
    const observed = await observeClaudeDelivery(input);
    const strict = await verifyClaudePaneProcess(input);
    return { result, calls, stored, observed, strict };
  } finally { db.close(); }
}

describe("ordinary Claude delivery after an in-process conversation change (#596)", () => {
  describe.each(["send", "wake", "handoff"] as const)("%s with token-only uncertainty", consumer => {
    it.each([...tokenOnlyModes, "rotation"] as const)("%s warns and delivers without proving conversation identity", async mode => {
      const { result, calls, stored, observed, strict } = await sendAfterHook(mode, consumer);
      expect(stored.resume_token).toBe(mode === "rotation" ? rotated : original);
      expect(observed.state).toBe("unknown");
      expect(strict).toBeNull();
      expect(result.ok).toBe(true);
      expect(result.warning).toContain("without verified native identity");
      expect(result.warning).toContain("current conversation is unverified");
      expect(result.warning).not.toMatch(/\/clear|rotation/i);
      expect(calls).toEqual(["text", "enter"]);
    });
  });

  it.each(["delayed-rotated-hook", "probe-refresh"] as const)("%s is not conversation-transition proof", async mode => {
    const { result, calls, observed, strict } = await sendAfterHook(mode);
    expect(observed.state).toBe("unknown");
    expect(strict).toBeNull();
    expect(result.warning).toContain("current conversation is unverified");
    expect(result.ok).toBe(true);
    expect(calls).toEqual(["text", "enter"]);
  });

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
