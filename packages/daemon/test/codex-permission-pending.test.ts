import { createRequire } from "node:module";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { activityRoutes, evidenceFromHookActivity } from "../src/routes/activity.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { SeatActivityService } from "../src/domain/seat-activity-service.js";
import { CODEX_ACTIVITY_RUNG_INVENTORY } from "../src/domain/activity-taxonomy.js";
import { EventBus } from "../src/domain/event-bus.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import { probeSessionActivity } from "../src/domain/session-transport.js";
import { createFullTestDb } from "./helpers/test-app.js";

const require = createRequire(import.meta.url);
const { buildOpenRigPayload } = require("../assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs");

describe("Codex pending permission requests", () => {
  function setup(options: { noReader?: boolean; reader?: () => Promise<boolean | null> } = {}) {
    let nowMs = 0;
    let visible: boolean | null = false;
    let sequence = 0;
    const changes: boolean[] = [];
    const reader = vi.fn(options.reader ?? (async () => visible));
    const service = new SeatActivityService({
      tmux: { readPaneLastActivity: async () => null },
      defaultWindowSeconds: 3,
      now: () => new Date(nowMs),
      permissionPromptReader: options.noReader ? undefined : reader,
      permissionPromptChanged: (_, confirmed) => changes.push(confirmed),
    });
    service.declareRungInventory({ seatNodeId: "seat", sessionName: "session" }, CODEX_ACTIVITY_RUNG_INVENTORY);
    const request = (id: string) => service.reportEvidence({
      seatNodeId: "seat", sessionName: "session", rung: "lifecycle-hooks", sourceId: "codex:hooks",
      seq: ++sequence, observedAt: new Date(nowMs).toISOString(), permissionRequest: { id },
    });
    const stop = () => service.reportEvidence({
      seatNodeId: "seat", sessionName: "session", rung: "lifecycle-hooks", sourceId: "codex:hooks",
      seq: ++sequence, observedAt: new Date(nowMs).toISOString(), activity: "idle-at-prompt",
      needsInput: { count: 0, reason: null },
    });
    return {
      service, request, stop, changes, reader,
      advance: (value: number) => { nowMs = value; },
      visible: (value: boolean | null) => { visible = value; },
      count: () => service.getSeatState("seat")!.needsInput.count,
    };
  }

  it("automatic review without a visible prompt never produces attention", async () => {
    const fixture = setup();
    fixture.request("turn");
    fixture.advance(3_000);
    await fixture.service.pollSeat("session");
    expect(fixture.count()).toBe(0);
    fixture.stop();
    fixture.advance(4_000);
    await fixture.service.pollSeat("session");
    expect(fixture.count()).toBe(0);
    expect(fixture.changes).toEqual([]);
  });

  it("waits for grace, then confirms and clears a visible prompt mid-turn", async () => {
    const fixture = setup();
    fixture.request("turn");
    fixture.visible(true);
    fixture.advance(2_999);
    await fixture.service.pollSeat("session");
    expect(fixture.count()).toBe(0);
    fixture.advance(3_000);
    await fixture.service.pollSeat("session");
    expect(fixture.count()).toBe(1);
    fixture.visible(false);
    fixture.advance(4_000);
    await fixture.service.pollSeat("session");
    expect(fixture.count()).toBe(0);
    expect(fixture.changes).toEqual([true, false]);
  });

  it("deduplicates requests by the real turn id without restarting grace", async () => {
    const fixture = setup();
    fixture.request("turn");
    fixture.advance(2_000);
    fixture.request("turn");
    fixture.visible(true);
    fixture.advance(3_000);
    await fixture.service.pollSeat("session");
    expect(fixture.count()).toBe(1);
  });

  it.each(["missing reader", "missing pane", "capture failure"])("fails safe after grace with %s", async failure => {
    const fixture = setup({
      noReader: failure === "missing reader",
      reader: async () => {
        if (failure === "capture failure") throw new Error("capture failed");
        return null;
      },
    });
    fixture.request("turn");
    fixture.advance(2_999);
    await fixture.service.pollSeat("session");
    expect(fixture.count()).toBe(0);
    fixture.advance(3_000);
    await fixture.service.pollSeat("session");
    expect(fixture.service.getSeatState("seat")!.needsInput).toEqual({ count: 1, reason: "permission_request_unverified" });
    expect(fixture.changes).toEqual([true]);
  });

  it("clears the fail-safe attention when capture recovers with no prompt", async () => {
    const fixture = setup();
    fixture.request("turn");
    fixture.visible(null);
    fixture.advance(3_000);
    await fixture.service.pollSeat("session");
    fixture.visible(false);
    fixture.advance(4_000);
    await fixture.service.pollSeat("session");
    expect(fixture.count()).toBe(0);
    expect(fixture.changes).toEqual([true, false]);
  });

  it("backs off negative checks after ten seconds but still catches a late prompt", async () => {
    const fixture = setup();
    fixture.request("turn");
    for (let nowMs = 0; nowMs <= 10_000; nowMs += 1_000) {
      fixture.advance(nowMs);
      await fixture.service.pollSeat("session");
    }
    expect(fixture.reader).toHaveBeenCalledTimes(8);
    fixture.visible(true);
    for (let nowMs = 11_000; nowMs < 15_000; nowMs += 1_000) {
      fixture.advance(nowMs);
      await fixture.service.pollSeat("session");
      expect(fixture.count()).toBe(0);
    }
    fixture.advance(15_000);
    await fixture.service.pollSeat("session");
    expect(fixture.count()).toBe(1);
    expect(fixture.reader).toHaveBeenCalledTimes(9);
  });

  it("Stop resets permission observations so later ordinary hooks can request attention", async () => {
    const fixture = setup();
    fixture.service.declareRungInventory({ seatNodeId: "seat", sessionName: "session" }, {
      ...CODEX_ACTIVITY_RUNG_INVENTORY,
      rungs: CODEX_ACTIVITY_RUNG_INVENTORY.rungs.map(rung => rung.rung === "lifecycle-hooks"
        ? { ...rung, initialTrust: "authoritative" as const } : rung),
    });
    fixture.request("turn");
    fixture.advance(3_000);
    await fixture.service.pollSeat("session");
    fixture.stop();
    fixture.service.reportEvidence({
      seatNodeId: "seat", sessionName: "session", rung: "lifecycle-hooks", sourceId: "codex:hooks",
      seq: 3, observedAt: new Date(4_000).toISOString(), needsInput: { count: 1, reason: "elicitation_dialog" },
    });
    expect(fixture.service.getSeatState("seat")!.needsInput).toEqual({ count: 1, reason: "elicitation_dialog" });
  });

  it("does not resurrect a permission when Stop arrives during capture", async () => {
    let finishCapture!: (visible: boolean) => void;
    const fixture = setup({ reader: () => new Promise(resolve => { finishCapture = resolve; }) });
    fixture.request("turn");
    fixture.advance(3_000);
    const polling = fixture.service.pollSeat("session");
    await vi.waitFor(() => expect(fixture.reader).toHaveBeenCalledOnce());
    fixture.stop();
    finishCapture(true);
    await polling;
    expect(fixture.count()).toBe(0);
    expect(fixture.changes).toEqual([]);
  });
});

describe("real Codex permission hook chain", () => {
  const databases: ReturnType<typeof createFullTestDb>[] = [];
  afterEach(() => { for (const database of databases.splice(0)) database.close(); });

  function setup(attachmentType: "tmux" | "external_cli" = "tmux") {
    const db = createFullTestDb();
    databases.push(db);
    const rigRepo = new RigRepository(db);
    const rig = rigRepo.createRig("permission-test");
    const node = rigRepo.addNode(rig.id, "worker", { runtime: "codex" });
    const registry = new SessionRegistry(db);
    const sessionName = "worker@permission-test";
    const session = registry.registerSession(node.id, sessionName);
    registry.updateStatus(session.id, "running");
    registry.updateBinding(node.id, { attachmentType, tmuxSession: attachmentType === "tmux" ? sessionName : null });
    let nowMs = 0;
    let visible = false;
    const now = () => new Date(nowMs);
    const store = new AgentActivityStore({ db, eventBus: new EventBus(db), now });
    const tmux = {
      readPaneLastActivity: async () => null,
      hasSession: async () => true,
      capturePaneContent: async () => visible
        ? "Would you like to run the following command?\n› 1. Yes, proceed (y)\n  2. No (esc)"
        : "• Working (3s • esc to interrupt)",
    } as unknown as TmuxAdapter;
    const reader = vi.fn(async () => {
      const activity = await probeSessionActivity({ sessionName, runtime: "codex", attachmentType: "tmux", tmuxAdapter: tmux, now: now() });
      if (activity.state === "unknown") return null;
      return activity.state === "needs_input" && ["permission_prompt", "selection_prompt"].includes(activity.reason);
    });
    const service = new SeatActivityService({
      tmux, defaultWindowSeconds: 3, now,
      permissionPromptReader: reader,
      permissionPromptChanged: (name, confirmed) => {
        store.recordHookEvent({ sessionName: name, runtime: "codex",
          hookEvent: confirmed ? "PermissionPromptConfirmed" : "PermissionPromptCleared" });
      },
    });
    const app = new Hono();
    app.use("*", async (context, next) => {
      context.set("agentActivityStore" as never, store as never);
      context.set("activityHookToken" as never, "test-token" as never);
      context.set("seatActivityService" as never, service as never);
      await next();
    });
    app.route("/activity", activityRoutes);
    const hook = async (hookEvent: string, turnId = "turn") => {
      const payload = buildOpenRigPayload({
        hook_event_name: hookEvent, session_id: "codex-session", turn_id: turnId,
        transcript_path: null, cwd: "/project", model: "test-model", permission_mode: "default",
        tool_name: "shell", tool_input: { command: "echo hello" },
      }, { OPENRIG_SESSION_NAME: sessionName, OPENRIG_RUNTIME: "codex" }, now);
      const response = await app.request("/activity/hooks", {
        method: "POST", headers: { "content-type": "application/json", authorization: "Bearer test-token" },
        body: JSON.stringify(payload),
      });
      expect(response.status).toBe(200);
      return payload;
    };
    return {
      db, node, sessionName, store, service, reader, hook,
      advance: (value: number) => { nowMs = value; },
      visible: (value: boolean) => { visible = value; },
      count: () => service.getSeatState(node.id)!.needsInput.count,
    };
  }

  it("relay → route → store → negative pane → positive pane → Stop uses only the real turn id", async () => {
    const fixture = setup();
    const payload = await fixture.hook("PermissionRequest");
    expect(payload).toMatchObject({ turnId: "turn", subtype: "shell" });
    for (const field of ["reviewer", "decision", "toolUseId"]) expect(payload).not.toHaveProperty(field);
    const pending = fixture.store.getLatestForNode({ sessionName: fixture.sessionName })!;
    expect(pending).toMatchObject({ state: "unknown", reason: "permission_request_pending", turnId: "turn" });
    expect(evidenceFromHookActivity({ seatNodeId: fixture.node.id, sessionName: fixture.sessionName,
      runtime: "codex", seq: 1, activity: pending })).toMatchObject({ permissionRequest: { id: "turn" } });
    fixture.advance(3_000);
    await fixture.service.pollAllRunningTmuxSeats(fixture.db);
    expect(fixture.count()).toBe(0);
    expect(fixture.store.getLatestForNode({ sessionName: fixture.sessionName })!.state).toBe("unknown");
    fixture.visible(true);
    fixture.advance(4_000);
    await fixture.service.pollAllRunningTmuxSeats(fixture.db);
    expect(fixture.count()).toBe(1);
    expect(fixture.store.getLatestForNode({ sessionName: fixture.sessionName })!.state).toBe("needs_input");
    await fixture.hook("Stop");
    expect(fixture.count()).toBe(0);
    expect(fixture.store.getLatestForNode({ sessionName: fixture.sessionName })!.state).toBe("idle");
    fixture.advance(5_000);
    await fixture.service.pollAllRunningTmuxSeats(fixture.db);
    expect(fixture.count()).toBe(0);
    expect(fixture.reader).toHaveBeenCalledTimes(2);
  });

  it("a running Codex seat without a tmux attachment fails safe on the production sweep", async () => {
    const fixture = setup("external_cli");
    await fixture.hook("PermissionRequest");
    fixture.advance(2_999);
    await fixture.service.pollAllRunningTmuxSeats(fixture.db);
    expect(fixture.count()).toBe(0);
    fixture.advance(3_000);
    await fixture.service.pollAllRunningTmuxSeats(fixture.db);
    expect(fixture.count()).toBe(1);
    expect(fixture.reader).not.toHaveBeenCalled();
    expect(fixture.store.getLatestForNode({ sessionName: fixture.sessionName })!.state).toBe("needs_input");
  });
});
