// #1077 — dev-review's reproduction against 2d04850b: a child `claude -p --resume` inherits the launch
// marker and generation; if the launched process's own first hook is missed, the child's hook must still
// not rotate the seat's identity. Control: the parent's hook delivered first.

import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { SeatIdentityReconciler } from "../src/domain/seat-identity-reconciler.js";
import { SeatIdentityStore } from "../src/domain/seat-identity-store.js";
import { SeatAttentionReconciler } from "../src/domain/seat-attention-reconciler.js";
import { SessionTransport } from "../src/domain/session-transport.js";
import { activityRoutes } from "../src/routes/activity.js";
import { sessionAdminRoutes } from "../src/routes/sessions.js";
import { claudeResumeLaunchEnv } from "../src/adapters/claude-resume-launch.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

const T1 = "00000000-0000-4000-8000-000000001080";
const T2 = "00000000-0000-4000-8000-000000001081";
const relayPath = fileURLToPath(new URL("../assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs", import.meta.url));

describe("resume launch marker binds the reporting process", () => {
  it.each([true, false])("a child cannot rotate the parent identity (parent first hook delivered: %s)", async delivered => {
    const db = createFullTestDb();
    try {
      const rigRepo = new RigRepository(db), registry = new SessionRegistry(db), eventBus = new EventBus(db);
      const rig = rigRepo.createRig("process-review");
      const node = rigRepo.addNode(rig.id, "dev.worker", { runtime: "claude-code" });
      const name = "dev-worker@process-review", session = registry.registerSession(node.id, name);
      registry.updateStatus(session.id, "running");
      registry.updateStartupStatus(session.id, "attention_required");
      registry.updateBinding(node.id, { tmuxSession: name, tmuxPane: "%1" });
      registry.recordResumeLaunch(session.id, T1);
      registry.updateResumeToken(session.id, "claude_id", T1, "scrape");
      const generation = registry.currentOccupantTenure(node.id)!.generationUuid;
      const activity = new AgentActivityStore({ db, eventBus });
      const app = new Hono();
      app.use("*", async (c, next) => {
        c.set("agentActivityStore" as never, activity as never);
        c.set("activityHookToken" as never, "fixture" as never);
        c.set("sessionRegistry" as never, registry as never);
        c.set("eventBus" as never, eventBus as never);
        await next();
      });
      app.route("/api/activity", activityRoutes);
      const postHook = async (payload: unknown) => {
        const response = await app.request("/api/activity/hooks", { method: "POST", headers: { "content-type": "application/json", "x-openrig-activity-token": "fixture" }, body: JSON.stringify(payload) });
        expect(response.status).toBe(200);
      };
      if (delivered) await postHook({ eventFamily: "session_identity", hookEvent: "SessionStart", runtime: "claude-code", sessionName: name, nodeId: node.id, sessionId: T1, source: "resume", generation, resumeLaunch: T1 });

      // Real OS parent -> child inheritance, using only fixture environment. The
      // child invokes the production relay payload builder. No Claude is launched.
      const childScript = `const relay = require(${JSON.stringify(relayPath)}); process.stdout.write(JSON.stringify(relay.buildSessionIdentityPayload({ hook_event_name: 'SessionStart', session_id: ${JSON.stringify(T2)}, source: 'resume' })));`;
      const parentScript = `const child = require('node:child_process').spawnSync(process.execPath, ['-e', ${JSON.stringify(childScript)}], {encoding:'utf8'}); if(child.status !== 0) throw Error(child.stderr); process.stdout.write(child.stdout);`;
      const inherited = spawnSync(process.execPath, ["-e", parentScript], { encoding: "utf8", env: {
        ...claudeResumeLaunchEnv(T1), OPENRIG_SESSION_NAME: name, OPENRIG_NODE_ID: node.id,
        OPENRIG_RUNTIME: "claude-code", OPENRIG_OCCUPANT_GENERATION: generation,
      } });
      expect(inherited.status, inherited.stderr).toBe(0);
      const childPayload = JSON.parse(inherited.stdout);
      expect(childPayload).toMatchObject({ sessionId: T2, resumeLaunch: T1, generation });
      await postHook(childPayload);

      // The child has finished. The original parent still occupies the pane and
      // has never changed conversation: argv and the stable process are still T1.
      const startedAt = "Fri Oct 9 12:00:00 2026";
      const listProcesses = async () => [
        { pid: 100, ppid: 1, pgid: 100, tpgid: 101, executableName: "bash", command: "bash", startedAt },
        { pid: 101, ppid: 100, pgid: 101, tpgid: 101, executableName: "claude", command: `/fixture/claude --resume ${T1}`, startedAt },
      ];
      const tmux = {
        listSessions: vi.fn(async () => [{ name }]), listPanes: vi.fn(async () => [{ id: "%1" }]),
        getPanePid: vi.fn(async () => 100), getPaneCommand: vi.fn(async () => "bash"),
        hasSession: vi.fn(async () => true), probeSession: vi.fn(async () => ({ state: "present" })),
        capturePaneContent: vi.fn(async () => "Claude Code\n❯"),
        sendText: vi.fn(async () => ({ ok: true })), sendKeys: vi.fn(async () => ({ ok: true })),
      } as unknown as TmuxAdapter;
      await new SeatIdentityReconciler({ db, tmux, listProcesses }).reconcileAll();
      const identity = new SeatIdentityStore(db).getForNode(node.id);
      // Exercise the public recovery route from its own recorded mismatch,
      // rather than erase that attention class with the preceding polling probe.
      new SeatIdentityStore(db).upsert({ nodeId: node.id, sessionName: name, verdict: "mismatch", evidenceSource: "pane_process", reason: "process_identity_mismatch", observedAt: new Date().toISOString(), evidence: { registeredPane: "%1", observedPid: 100, observedCommand: "bash", matchedLayer: null } });
      const clear = new SeatAttentionReconciler({ db, sessionRegistry: registry, eventBus, agentActivityStore: activity, tmux, listProcesses, sendVerify: async () => { throw new Error("unexpected input"); } });
      const admin = new Hono();
      admin.use("*", async (c,next) => { c.set("seatAttentionReconciler" as never, clear as never); c.set("terminalBearerToken" as never, "fixture" as never); await next(); });
      admin.route("/api/sessions", sessionAdminRoutes);
      const cleared = await admin.request(`/api/sessions/${encodeURIComponent(name)}/clear-attention`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer fixture" }, body: "{}" });
      const clearBody = await cleared.json();
      const sent = await new SessionTransport({ db, rigRepo, sessionRegistry: registry, eventBus, tmuxAdapter: tmux, listProcesses, sleep: async () => {} }).send(name, "offline review");
      const stored = db.prepare("SELECT resume_token, resume_launch_token, resume_rotated_from, startup_status FROM sessions WHERE id = ?").get(session.id);
      expect.soft(stored).toMatchObject({ resume_rotated_from: null });
      expect.soft(identity?.verdict).toBe("mismatch");
      expect.soft(cleared.status).toBe(422);
      expect.soft((sent as { warning?: string }).warning ?? "").toContain("without verified native identity");
    } finally { db.close(); }
  });
});
