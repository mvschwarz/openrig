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
import { makePermissionPromptReader, makePromptStateReader } from "../src/domain/queue-wake-ladder.js";
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

  it.each(["turn-a", "turn-b"])("discards an all-clear read overtaken by request %s, then accepts a fresh read", async id => {
    const fixture = setup();
    fixture.request("turn-a");
    fixture.visible(true);
    fixture.advance(3_000);
    await fixture.service.pollSeat("session");
    let finishCapture!: (visible: boolean) => void;
    fixture.reader.mockImplementationOnce(() => new Promise(resolve => { finishCapture = resolve; }));
    fixture.advance(4_000);
    const polling = fixture.service.pollSeat("session");
    await vi.waitFor(() => expect(fixture.reader).toHaveBeenCalledTimes(2));
    fixture.request(id);
    finishCapture(false);
    await polling;
    expect(fixture.count()).toBe(1);
    expect(fixture.changes).not.toContain(false);
    fixture.visible(false);
    fixture.advance(7_000);
    await fixture.service.pollSeat("session");
    expect(fixture.count()).toBe(0);
    expect(fixture.changes.at(-1)).toBe(false);
  });

  it("tells its readers unknown inside the grace, clear once a read finds no prompt, blocked while one shows or can't be read", async () => {
    const fixture = setup();
    const raisedAt = new Date(0).toISOString();
    expect(fixture.service.codexPermissionState("seat", raisedAt)).toBeNull();
    fixture.request("turn");
    fixture.advance(2_000);
    await fixture.service.pollSeat("session");
    expect(fixture.service.codexPermissionState("seat", raisedAt)).toBe("unknown");
    fixture.advance(3_000);
    await fixture.service.pollSeat("session");
    expect(fixture.service.codexPermissionState("seat", raisedAt)).toBe("clear");
    // A read from before a later refusal doesn't clear it.
    expect(fixture.service.codexPermissionState("seat", raisedAt, new Date(4_000).toISOString())).toBe("unknown");
    fixture.visible(true);
    fixture.advance(4_000);
    await fixture.service.pollSeat("session");
    expect(fixture.service.codexPermissionState("seat", raisedAt)).toBe("blocked");
    fixture.visible(null);
    fixture.advance(5_000);
    await fixture.service.pollSeat("session");
    expect(fixture.service.codexPermissionState("seat", raisedAt)).toBe("blocked");
    fixture.stop();
    expect(fixture.service.codexPermissionState("seat", raisedAt)).toBeNull();
  });

  it("reads a same-turn request unknown until a read lands the grace after its hook", async () => {
    const fixture = setup();
    fixture.request("turn");
    fixture.advance(3_000);
    await fixture.service.pollSeat("session");
    expect(fixture.service.codexPermissionState("seat", new Date(0).toISOString())).toBe("clear");
    fixture.advance(81_000);
    fixture.request("turn");
    const second = new Date(81_000).toISOString();
    expect(fixture.service.codexPermissionState("seat", second)).toBe("unknown");
    await fixture.service.pollSeat("session"); // read before the second request's grace
    expect(fixture.service.codexPermissionState("seat", second)).toBe("unknown");
    fixture.advance(86_000);
    await fixture.service.pollSeat("session");
    expect(fixture.service.codexPermissionState("seat", second)).toBe("clear");
  });

  it("doesn't clear a refusal that landed during the capture it reads", async () => {
    const fixture = setup();
    fixture.request("turn");
    let finishCapture!: (visible: boolean) => void;
    fixture.reader.mockImplementationOnce(() => new Promise(resolve => { finishCapture = resolve; }));
    fixture.advance(3_000);
    const polling = fixture.service.pollSeat("session");
    await vi.waitFor(() => expect(fixture.reader).toHaveBeenCalledOnce());
    fixture.advance(3_500); // the refusal at 3.2 s comes after this capture began
    finishCapture(false);
    await polling;
    const raisedAt = new Date(0).toISOString();
    expect(fixture.service.codexPermissionState("seat", raisedAt, new Date(3_200).toISOString())).toBe("unknown");
    expect(fixture.service.codexPermissionState("seat", raisedAt, new Date(2_900).toISOString())).toBe("clear");
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

  // `occupant`: the seat's live occupant generation, carried by its hooks and resolved by the store, as the daemon wires it.
  function setup(attachmentType: "tmux" | "external_cli" = "tmux", occupant?: string) {
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
    const store = new AgentActivityStore({ db, eventBus: new EventBus(db), now,
      ...(occupant ? { resolveOccupantGeneration: () => occupant } : {}) });
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
        store.recordHookEvent({ sessionName: name, runtime: "codex", ...(occupant ? { generation: occupant } : {}),
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
      }, { OPENRIG_SESSION_NAME: sessionName, OPENRIG_RUNTIME: "codex",
        ...(occupant ? { OPENRIG_OCCUPANT_GENERATION: occupant } : {}) }, now);
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

  // The wake ladder's two readers, wired as the daemon wires them, with the oracle's pane check of the request.
  function ladderReaders(fixture: ReturnType<typeof setup>, service: SeatActivityService = fixture.service) {
    const getLatestHook = (sessionName: string) => fixture.store.getLatestForNode({ sessionName, order: "arrival" });
    const promptState = makePromptStateReader({ db: fixture.db, getSeatState: id => service.getSeatState(id), getLatestHook,
      getCodexPermissionState: (id, raisedAt, after) => service.codexPermissionState(id, raisedAt, after) });
    const permissionPrompts = makePermissionPromptReader({ db: fixture.db, getLatestHook,
      getCodexPermissionState: (id, raisedAt) => service.codexPermissionState(id, raisedAt) });
    return {
      prompt: (refusedAtMs: number) => promptState(fixture.sessionName, new Date(refusedAtMs).toISOString()),
      permission: () => permissionPrompts(fixture.sessionName).find(o => o.destination === fixture.sessionName)?.state,
    };
  }
  const at = async (fixture: ReturnType<typeof setup>, ms: number) => {
    fixture.advance(ms);
    await fixture.service.pollAllRunningTmuxSeats(fixture.db);
  };

  it("an auto-approved request reads clear at both ladder readers, at the two-minute step and past hook staleness", async () => {
    const fixture = setup("tmux", "gen-1");
    const ladder = ladderReaders(fixture);
    await fixture.hook("PermissionRequest");
    for (const ms of [3_000, 120_000, 301_000]) {
      await at(fixture, ms);
      expect([ms, ladder.prompt(1_000)]).toEqual([ms, "clear"]);
      expect([ms, ladder.permission()]).toEqual([ms, "clear"]);
    }
  });

  it("a prompt on screen still reads blocked at both, after a repeated request hook and past staleness", async () => {
    const fixture = setup("tmux", "gen-1");
    const ladder = ladderReaders(fixture);
    await fixture.hook("PermissionRequest");
    fixture.visible(true);
    await at(fixture, 3_000);
    fixture.advance(3_500);
    await fixture.hook("PermissionRequest"); // the duplicate registration's copy, or a later request in the turn
    for (const ms of [8_000, 304_000]) {
      await at(fixture, ms);
      expect([ms, ladder.prompt(1_000)]).toEqual([ms, "blocked"]);
      expect([ms, ladder.permission()]).toEqual([ms, "blocked"]);
    }
  });

  it("inside the grace, before the first pane read, both readers say unknown, not blocked", async () => {
    const fixture = setup("tmux", "gen-1");
    const ladder = ladderReaders(fixture);
    await fixture.hook("PermissionRequest");
    await at(fixture, 1_000);
    expect(ladder.prompt(500)).toBe("unknown");
    expect(ladder.permission()).toBe("unknown");
  });

  it("the oracle's grace holds at the refusal reader even when the activity read alone would clear it", async () => {
    const fixture = setup("tmux", "gen-1");
    await fixture.hook("PermissionRequest");
    fixture.advance(1_000);
    const read = makePromptStateReader({ db: fixture.db,
      // As a seat whose hooks are trusted would read: working, no prompt counted, observed after the refusal.
      getSeatState: () => ({ activity: "working", needsInput: { count: 0, reason: null },
        needsInputEvidence: { rung: "lifecycle-hooks", observedAt: new Date(1_000).toISOString() } }),
      getLatestHook: sessionName => fixture.store.getLatestForNode({ sessionName, order: "arrival" }),
      getCodexPermissionState: (id, raisedAt, after) => fixture.service.codexPermissionState(id, raisedAt, after) });
    expect(read(fixture.sessionName, new Date(500).toISOString())).toBe("unknown");
  });

  it("with no request tracked (the oracle rebuilt), the hook still reads blocked, fresh or stale, as before", async () => {
    const fixture = setup("tmux", "gen-1");
    const rebuilt = new SeatActivityService({ tmux: { readPaneLastActivity: async () => null } as never, defaultWindowSeconds: 3,
      now: () => new Date(0) });
    const ladder = ladderReaders(fixture, rebuilt);
    await fixture.hook("PermissionRequest");
    fixture.advance(120_000);
    expect(ladder.prompt(1_000)).toBe("blocked");
    expect(ladder.permission()).toBe("blocked");
    // A held wake still escalates after the activity service is rebuilt (held-wake-escalation.test.ts).
    fixture.advance(301_000);
    expect(ladder.prompt(1_000)).toBe("blocked");
    expect(ladder.permission()).toBe("blocked");
  });

  it("the reported turn: two auto-approved requests 81 s apart, a hand-in, then Stop, never reads as a waiting prompt", async () => {
    // As reported: requests at 10:17:42Z and 10:19:03Z, a hand-in at 10:20:07Z and Stop at 10:20:15Z, then the ladder's
    // two-minute step after the hand-in.
    const fixture = setup("tmux", "gen-1");
    const ladder = ladderReaders(fixture);
    const seen = new Set<string | undefined>();
    for (let ms = 0; ms <= 265_000; ms += 1_000) {
      fixture.advance(ms);
      if (ms === 0 || ms === 81_000) await fixture.hook("PermissionRequest");
      if (ms === 153_000) await fixture.hook("Stop");
      await fixture.service.pollAllRunningTmuxSeats(fixture.db);
      seen.add(ladder.permission());
      if (ms >= 145_000) seen.add(ladder.prompt(145_000));
    }
    expect(seen.has("blocked")).toBe(false);
    expect(ladder.permission()).toBe("clear");
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
