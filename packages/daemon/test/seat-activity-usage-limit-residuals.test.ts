import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { SeatActivityService } from "../src/domain/seat-activity-service.js";
import { activityRoutes, restoredUsageLimitEvidence } from "../src/routes/activity.js";
import { readClaudeSelfReportEvidence } from "../src/adapters/claude-code-adapter.js";
import { CODEX_ACTIVITY_RUNG_INVENTORY, deriveDisplayActivity } from "../src/domain/activity-taxonomy.js";
import { observeCodexLimitBanner, recordCodexLimitBanner } from "../src/domain/provider/codex-limit-banner.js";

// A seat at its usage limit tells the truth after a daemon restart, and so does a Codex seat. A restart restores the
// held limit from the store, as it held live; a store that can't be read leaves the seat unknown, never working; and
// Codex's banner reaches the activity oracle as Claude's typed hook does, not only the store. Through the real hook
// route, store, occupant ledger and oracle, and the oracle's own restart sweep.

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function fixture() {
  // The relay's reset bound is checked against the real clock at ingress, so the fixture runs on it.
  const clock = { now: Date.now() };
  const reset = new Date(clock.now + 3 * 24 * 3600_000).toISOString();
  const db = createFullTestDb();
  cleanups.push(() => db.close());
  const rigs = new RigRepository(db);
  const rig = rigs.createRig("limit-rig");
  const claude = rigs.addNode(rig.id, "dev.lead", { runtime: "claude-code" });
  const codex = rigs.addNode(rig.id, "dev.qa", { runtime: "codex" });
  const terminal = rigs.addNode(rig.id, "infra.shell", { runtime: "terminal" });
  const sessions = new SessionRegistry(db);
  const occupy = (nodeId: string, name: string) => {
    const session = sessions.registerSession(nodeId, name);
    sessions.updateStatus(session.id, "running");
    return session.sessionName;
  };
  const claudeSession = occupy(claude.id, "dev-lead@limit-rig");
  const codexSession = occupy(codex.id, "dev-qa@limit-rig");
  const terminalSession = occupy(terminal.id, "infra-shell@limit-rig");
  // The seat's own Claude conversation: the store keeps a limit's reset only from a post that names it (#99).
  const conversation = "conv-dev-lead";
  db.prepare("UPDATE sessions SET resume_type = 'claude_id', resume_token = ? WHERE node_id = ?").run(conversation, claude.id);
  const generation = (nodeId: string) => sessions.currentOccupantTenure(nodeId)!.generationUuid;
  const eventBus = new EventBus(db);
  const store = new AgentActivityStore({ db, eventBus, now: () => new Date(clock.now),
    resolveOccupantGeneration: id => sessions.currentOccupantTenure(id)?.generationUuid ?? null,
    isRegisteredOccupantGeneration: (id, gen) => sessions.isOccupantGenerationRegistered(id, gen),
    isOccupantContinuedByAdoption: (id, gen) => sessions.isOccupantContinuedByAdoption(id, gen) });
  /** The daemon's wiring: a new oracle (as after a restart) restores a held limit from the store. */
  const newOracle = (restore: "store" | "unreadable" = "store") => new SeatActivityService({
    tmux: { readPaneLastActivity: async () => null }, defaultWindowSeconds: 3, now: () => new Date(clock.now),
    restoreUsageLimitEvidence: restore === "store"
      ? (seat, runtime) => restoredUsageLimitEvidence(store, seat, runtime)
      : () => { throw new Error("SQLITE_BUSY: database is locked"); },
  });
  let oracle = newOracle();
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("agentActivityStore" as never, store as never);
    c.set("activityHookToken" as never, "fixture-token" as never);
    c.set("sessionRegistry" as never, sessions as never);
    c.set("eventBus" as never, eventBus as never);
    c.set("seatActivityService" as never, oracle as never);
    await next();
  });
  app.route("/api/activity", activityRoutes);
  /** What Claude's relay posts for a hook event on the Claude seat. */
  async function post(hookEvent: string, subtype: string | null, over: Record<string, unknown> = {}) {
    const response = await app.request("/api/activity/hooks", { method: "POST",
      headers: { authorization: "Bearer fixture-token", "Content-Type": "application/json" },
      body: JSON.stringify({ sessionName: claudeSession, nodeId: claude.id, generation: generation(claude.id), runtime: "claude-code",
        hookEvent, subtype, sessionId: conversation, occurredAt: new Date(clock.now).toISOString(), ...over }) });
    expect(response.status).toBe(200);
  }
  /** A daemon restart: the in-memory ladder is gone; the first sweep declares each seat again, unless a hook reaches the
   *  route first (`beforeSweep`) and declares it there. */
  async function restart(restore: "store" | "unreadable" = "store", beforeSweep?: () => Promise<void>) {
    oracle = newOracle(restore);
    await beforeSweep?.();
    await oracle.pollAllRunningTmuxSeats(db);
  }
  /** Claude's own status file, read by the real self-report reader. */
  function claudeStatus(status: "busy" | "waiting", at: number) {
    const file = JSON.stringify({ name: claudeSession, status, statusUpdatedAt: at });
    const evidence = readClaudeSelfReportEvidence({ sessionsDir: "/sessions", sessionName: claudeSession, seatNodeId: claude.id,
      read: { listFiles: () => ["1.json"], readFile: () => file } });
    if (evidence) oracle.reportEvidence(evidence);
  }
  function idleSample(nodeId: string, sessionName: string) {
    oracle.reportEvidence({ seatNodeId: nodeId, sessionName, rung: "window-sampling", sourceId: "tmux:window-activity",
      seq: clock.now, observedAt: new Date(clock.now).toISOString(), activity: "idle-at-prompt" });
  }
  const codexIdleSample = () => idleSample(codex.id, codexSession);
  function seat(nodeId: string) {
    const state = oracle.getSeatState(nodeId)!;
    return { ...state, display: deriveDisplayActivity(state.activity, state.needsInput) };
  }
  const banner = { resetText: "try again at 6:00 PM", evidence: "You've hit your usage limit" };
  return { clock, reset, store, sessions, claude, codex, terminal, claudeSession, codexSession, terminalSession, generation, post,
    restart, claudeStatus, idleSample, codexIdleSample, seat, banner, oracle: () => oracle };
}

describe("a seat at its usage limit, across a daemon restart and on Codex", () => {
  it("restores a Claude seat's held limit after a restart: unknown with its reset, not working or needs-input", async () => {
    const f = fixture();
    const turnStart = f.clock.now;
    await f.post("UserPromptSubmit", null);
    f.clock.now += 1_000;
    await f.post("StopFailure", "rate_limit", { resetsAt: f.reset });
    f.clock.now += 3600_000;
    await f.restart();
    // Claude's own status still says what it last wrote before the limit, then its limit menu.
    f.claudeStatus("busy", turnStart);
    expect(f.seat(f.claude.id).display).toBe("unknown");
    f.claudeStatus("waiting", turnStart + 1_500);

    const state = f.seat(f.claude.id);
    expect(state.display).toBe("unknown");
    expect(state.decidedBy).toBe("lifecycle-hooks");
    expect(state.needsInput.count).toBe(0);
    expect(state.usageLimit).toEqual({ rung: "lifecycle-hooks", observedAt: new Date(turnStart + 1_000).toISOString(), resetsAt: f.reset });
  });

  it("restores the held limit when a hook reaches the route before the first sweep after a restart", async () => {
    const f = fixture();
    await f.post("UserPromptSubmit", null);
    f.clock.now += 1_000;
    const limitAt = f.clock.now;
    await f.post("StopFailure", "rate_limit", { resetsAt: f.reset });
    f.clock.now += 3600_000;
    // Claude's idle notification arrives first and declares the seat; an idle prompt isn't a new turn.
    await f.restart("store", () => f.post("Notification", "idle_prompt"));
    expect(f.seat(f.claude.id).display).toBe("unknown");
    expect(f.seat(f.claude.id).usageLimit).toEqual({ rung: "lifecycle-hooks", observedAt: new Date(limitAt).toISOString(), resetsAt: f.reset });
    f.clock.now += 1_000;
    await f.post("UserPromptSubmit", null); // a newer turn still ends it
    expect(f.seat(f.claude.id).usageLimit).toBeNull();
  });

  it("restores a limit recorded before a no-launch adoption: the same process, under its earlier generation", async () => {
    const f = fixture();
    await f.post("UserPromptSubmit", null);
    f.clock.now += 1_000;
    const limitAt = f.clock.now;
    await f.post("StopFailure", "rate_limit", { resetsAt: f.reset });
    const recorded = f.generation(f.claude.id);
    f.sessions.mintOccupantTenure(f.claude.id, "adopt"); // reconcile, bind or self-attach registers the live process again
    expect(f.generation(f.claude.id)).not.toBe(recorded);
    f.clock.now += 3600_000;
    await f.restart();
    expect(f.seat(f.claude.id).usageLimit).toEqual({ rung: "lifecycle-hooks", observedAt: new Date(limitAt).toISOString(), resetsAt: f.reset });
  });

  it("doesn't let another occupant's later record end this occupant's limit", async () => {
    const f = fixture();
    const prior = f.generation(f.claude.id);
    f.sessions.mintOccupantTenure(f.claude.id, "fresh"); // a launch: the earlier generation is a prior tenure now
    f.clock.now += 1_000;
    const limitAt = f.clock.now;
    await f.post("StopFailure", "rate_limit", { resetsAt: f.reset });
    f.clock.now += 1_000;
    await f.post("UserPromptSubmit", null, { generation: prior }); // the prior tenure's late post, dated after the limit
    f.clock.now += 3600_000;
    await f.restart();
    expect(f.seat(f.claude.id).usageLimit).toEqual({ rung: "lifecycle-hooks", observedAt: new Date(limitAt).toISOString(), resetsAt: f.reset });
  });

  it("reads unknown, claiming no limit, when a held limit's occupant can't be shown at a restart", async () => {
    const f = fixture();
    const before = f.clock.now;
    f.clock.now += 1_000;
    await f.post("StopFailure", "rate_limit", { resetsAt: f.reset, generation: "generation-not-in-the-ledger" });
    f.clock.now += 3600_000;
    await f.restart();
    f.claudeStatus("busy", before); // an older report must not decide
    expect(f.seat(f.claude.id).display).toBe("unknown");
    expect(f.seat(f.claude.id).usageLimit).toBeNull();
  });

  it("doesn't restore a limit that a newer turn already ended", async () => {
    const f = fixture();
    await f.post("StopFailure", "rate_limit", { resetsAt: f.reset });
    f.clock.now += 60_000;
    await f.post("UserPromptSubmit", null);
    f.clock.now += 3600_000;
    await f.restart();
    f.claudeStatus("busy", f.clock.now - 1_000);
    expect(f.seat(f.claude.id).display).toBe("working");
    expect(f.seat(f.claude.id).usageLimit).toBeNull();
  });

  it("reads unknown, never working, when the store can't be read at a restart, until a newer turn", async () => {
    const f = fixture();
    const before = f.clock.now;
    f.clock.now += 3600_000;
    await f.restart("unreadable");
    f.claudeStatus("busy", before); // an older report, from before the restart
    expect(f.seat(f.claude.id).display).toBe("unknown");
    expect(f.seat(f.claude.id).usageLimit).toBeNull(); // no limit is claimed: the store wasn't read
    f.clock.now += 1_000;
    f.claudeStatus("busy", f.clock.now); // a turn that started after the restart
    expect(f.seat(f.claude.id).display).toBe("working");
  });

  it("leaves a seat that can't post a typed limit to its own evidence when the store can't be read at a restart", async () => {
    // A terminal seat has no turn and no banner that could end an unread hold, so it must never get one.
    const f = fixture();
    f.clock.now += 3600_000;
    await f.restart("unreadable");
    f.idleSample(f.terminal.id, f.terminalSession);
    expect(f.seat(f.terminal.id).display).toBe("idle");
    expect(f.seat(f.terminal.id).decidedBy).toBe("window-sampling");
    expect(f.seat(f.terminal.id).usageLimit).toBeNull();
  });

  it("holds a Codex seat's banner as its usage limit, not idle, and ends it when a newer capture shows none", () => {
    const f = fixture();
    f.oracle().declareRungInventory({ seatNodeId: f.codex.id, sessionName: f.codexSession }, CODEX_ACTIVITY_RUNG_INVENTORY);
    const observe = (banner: typeof f.banner | null) => observeCodexLimitBanner({ store: f.store,
      resolveGeneration: () => f.generation(f.codex.id), oracle: f.oracle(), sessionName: f.codexSession, banner,
      observedAt: new Date(f.clock.now) });
    f.codexIdleSample();
    expect(f.seat(f.codex.id).display).toBe("idle");

    f.clock.now += 1_000;
    observe(f.banner);
    f.codexIdleSample();
    expect(f.seat(f.codex.id).display).toBe("unknown");
    expect(f.seat(f.codex.id).usageLimit).toEqual({ rung: "window-sampling", observedAt: new Date(f.clock.now).toISOString(), resetsAt: null });
    expect(f.store.getLatestForNode({ nodeId: f.codex.id, sessionName: f.codexSession })?.rawEvent).toBe("at_limit");

    f.clock.now += 30_000;
    observe(f.banner); // the same limit, still showing
    f.codexIdleSample();
    expect(f.seat(f.codex.id).display).toBe("unknown");
    f.clock.now += 1_000;
    observe(null);
    f.codexIdleSample();
    expect(f.seat(f.codex.id).display).toBe("idle");
    expect(f.seat(f.codex.id).usageLimit).toBeNull();
  });

  it("lets a real limit replace an unread restart placeholder, even one dated before it", async () => {
    const f = fixture();
    f.clock.now += 3600_000;
    await f.restart("unreadable");
    const limitAt = f.clock.now - 10_000; // a delayed post from before the restart
    await f.post("StopFailure", "rate_limit", { resetsAt: f.reset, occurredAt: new Date(limitAt).toISOString() });
    expect(f.seat(f.claude.id).usageLimit).toEqual({ rung: "lifecycle-hooks", observedAt: new Date(limitAt).toISOString(), resetsAt: f.reset });
  });

  it("restores a limit that a turn's start shares its instant with, as live holds it (only a strictly later turn ends it)", async () => {
    const f = fixture();
    const at = f.clock.now;
    await f.post("StopFailure", "rate_limit", { resetsAt: f.reset });
    await f.post("UserPromptSubmit", null); // the same instant, delivered after: it reads first on a restart
    const held = { rung: "lifecycle-hooks", observedAt: new Date(at).toISOString(), resetsAt: f.reset };
    expect(f.seat(f.claude.id).usageLimit).toEqual(held);
    f.clock.now += 3600_000;
    await f.restart();
    expect(f.seat(f.claude.id).usageLimit).toEqual(held);
  });

  describe("a Codex seat's banner episodes", () => {
    function codex(f: ReturnType<typeof fixture>) {
      f.oracle().declareRungInventory({ seatNodeId: f.codex.id, sessionName: f.codexSession }, CODEX_ACTIVITY_RUNG_INVENTORY);
      const observe = (banner: typeof f.banner | null) => observeCodexLimitBanner({ store: f.store,
        resolveGeneration: () => f.generation(f.codex.id), oracle: f.oracle(), sessionName: f.codexSession, banner,
        observedAt: new Date(f.clock.now) });
      const hook = (hookEvent: string, subtype: string | null = null) => expect(f.store.recordHookEvent({ runtime: "codex",
        sessionName: f.codexSession, hookEvent, subtype, generation: f.generation(f.codex.id),
        occurredAt: new Date(f.clock.now).toISOString() }).ok).toBe(true);
      const latest = () => f.store.getLatestForNode({ nodeId: f.codex.id, sessionName: f.codexSession });
      return { observe, hook, latest };
    }

    it("records the same banner again after a newer turn ended its episode, but not while the episode is still held", async () => {
      const f = fixture(); const c = codex(f);
      c.observe(f.banner);
      f.clock.now += 1_000;
      c.hook("UserPromptSubmit"); // a newer turn: the recorded episode is over
      f.clock.now += 1_000;
      const again = f.clock.now;
      c.observe(f.banner); // the same reset text, with no banner-free capture between
      expect(c.latest()).toMatchObject({ rawEvent: "at_limit" }); // a new typed row, after the turn's
      expect(f.store.heldUsageLimitForSession(f.codexSession, "codex")).toMatchObject({ rawEvent: "at_limit" });

      f.clock.now += 1_000;
      c.hook("Notification"); // neutral: it ends nothing
      f.clock.now += 1_000;
      c.observe(f.banner); // still the same held episode: not recorded again
      expect(c.latest()?.rawEvent).toBe("Notification");

      f.clock.now += 3600_000;
      await f.restart();
      f.codexIdleSample();
      expect(f.seat(f.codex.id).usageLimit).toEqual({ rung: "window-sampling", observedAt: new Date(again).toISOString(), resetsAt: null });
    });

    it("records the clear a banner-free capture shows behind a neutral notification, so a restart doesn't bring the limit back", async () => {
      const f = fixture(); const c = codex(f);
      c.observe(f.banner);
      f.clock.now += 1_000;
      c.hook("Notification"); // a neutral notification supersedes the limit row without ending it
      f.clock.now += 1_000;
      c.observe(null); // the banner is gone
      expect(c.latest()).toMatchObject({ rawEvent: "Notification", rawSubtype: "usage_limit_cleared" });
      f.clock.now += 3600_000;
      await f.restart();
      f.codexIdleSample();
      expect(f.seat(f.codex.id).usageLimit).toBeNull();
    });
  });

  it("restores a Codex seat's banner limit after a restart", async () => {
    const f = fixture();
    recordCodexLimitBanner({ store: f.store, resolveGeneration: () => f.generation(f.codex.id), sessionName: f.codexSession,
      banner: f.banner, now: () => new Date(f.clock.now) });
    const seenAt = f.clock.now;
    f.clock.now += 3600_000;
    await f.restart();
    f.codexIdleSample();
    expect(f.seat(f.codex.id).display).toBe("unknown");
    expect(f.seat(f.codex.id).usageLimit).toEqual({ rung: "window-sampling", observedAt: new Date(seenAt).toISOString(), resetsAt: null });
  });
});
