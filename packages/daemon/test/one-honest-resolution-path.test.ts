import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import type { ExecFn } from "../src/adapters/tmux.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SessionTransport } from "../src/domain/session-transport.js";
import { EventBus } from "../src/domain/event-bus.js";
import { Reconciler } from "../src/domain/reconciler.js";
import { transportRoutes } from "../src/routes/transport.js";
import { PsProjectionService } from "../src/domain/ps-projection.js";
import { createFullTestDb } from "./helpers/test-app.js";

// OPR.0.5.4.2 — one honest resolution path. The deterministic injected-exec
// reproduction (diagnosis row 2b986f35) inverted into regression tests: the
// adapter's probe classifies three error classes and the shared resolution
// path must surface each as itself — a transport blip may never read as a
// dead seat, and no absence verdict may be fabricated from a blip.
//
// The four specimens are the real error shapes tmux produces (classifier
// source: adapters/tmux.ts isNoServerError / isSessionAbsenceError /
// isTmuxTransportAbsentError):
const NO_SERVER = () => new Error("no server running on /private/tmp/tmux-501/default");
const SOCKET_GONE = () => new Error("error connecting to /private/tmp/tmux-501/default (No such file or directory)");
const SESSION_GONE = () => new Error("can't find session: dev-impl@my-rig");
const PERMISSION = () => new Error("permission denied");

const failingExec = (make: () => Error): ExecFn => async () => {
  throw make();
};

const SEAT = "dev-impl@my-rig";

describe("adapter gate: probeSession classifies instead of collapsing", () => {
  it("no-server → transport answer, not absence", async () => {
    const adapter = new TmuxAdapter(failingExec(NO_SERVER));
    const probe = await adapter.probeSession(SEAT);
    expect(probe.state).toBe("transport_unavailable");
  });

  it("socket-gone → transport answer, not absence", async () => {
    const adapter = new TmuxAdapter(failingExec(SOCKET_GONE));
    const probe = await adapter.probeSession(SEAT);
    expect(probe.state).toBe("transport_unavailable");
  });

  it("can't find session → positive absence", async () => {
    const adapter = new TmuxAdapter(failingExec(SESSION_GONE));
    const probe = await adapter.probeSession(SEAT);
    expect(probe.state).toBe("absent");
  });

  it("permission denied → fail-closed throw, distinct from both classes", async () => {
    const adapter = new TmuxAdapter(failingExec(PERMISSION));
    await expect(adapter.probeSession(SEAT)).rejects.toThrow("permission denied");
  });

  it("present session → present", async () => {
    const adapter = new TmuxAdapter(async () => "");
    const probe = await adapter.probeSession(SEAT);
    expect(probe.state).toBe("present");
  });

  // Mini-req 6 disposition pin: the wider hasSession population keeps its
  // collapsed semantics; this slice must not change them out from under the
  // 28 unbound call sites.
  it("hasSession keeps the collapsed view for unbound consumers", async () => {
    await expect(new TmuxAdapter(failingExec(NO_SERVER)).hasSession(SEAT)).resolves.toBe(false);
    await expect(new TmuxAdapter(failingExec(SESSION_GONE)).hasSession(SEAT)).resolves.toBe(false);
    await expect(new TmuxAdapter(failingExec(PERMISSION)).hasSession(SEAT)).rejects.toThrow();
  });
});

describe("one path at the verbs: send and capture surface the transport outcome", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;

  beforeEach(() => {
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
  });

  afterEach(() => {
    db.close();
  });

  function seedSeat() {
    const rig = rigRepo.createRig("my-rig");
    const node = rigRepo.addNode(rig.id, "dev.impl", { role: "worker", runtime: "claude-code" });
    const session = sessionRegistry.registerSession(node.id, SEAT);
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateBinding(node.id, { tmuxSession: SEAT, tmuxPane: "%5" });
    return { rig, node, session };
  }

  function transportOver(make: () => Error): SessionTransport {
    // The REAL adapter over an injected failing exec — the diagnosis repro
    // shape, not a stubbed error at the seam under test.
    return new SessionTransport({
      db,
      rigRepo,
      sessionRegistry,
      tmuxAdapter: new TmuxAdapter(failingExec(make)),
    });
  }

  const verdictRows = () =>
    db.prepare("SELECT * FROM seat_identity_verdicts").all() as Array<{ reason: string }>;

  it("send under no-server surfaces tmux_unavailable, never session_missing", async () => {
    seedSeat();
    const result = await transportOver(NO_SERVER).send(SEAT, "hello");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("tmux_unavailable");
  });

  it("send under socket-gone surfaces tmux_unavailable, never session_missing", async () => {
    seedSeat();
    const result = await transportOver(SOCKET_GONE).send(SEAT, "hello");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("tmux_unavailable");
  });

  it("capture under no-server surfaces tmux_unavailable, never session_missing", async () => {
    seedSeat();
    const result = await transportOver(NO_SERVER).capture(SEAT);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("tmux_unavailable");
  });

  it("send under genuine absence still surfaces session_missing", async () => {
    seedSeat();
    const result = await transportOver(SESSION_GONE).send(SEAT, "hello");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("session_missing");
  });

  describe("error text names what was actually checked (queue-create bar)", () => {
    it("transport text states the failed reach AND that existence was not determined", async () => {
      seedSeat();
      const result = await transportOver(NO_SERVER).send(SEAT, "hello");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toMatch(/could not be reached|not reachable/i);
      expect(result.error).toMatch(/not determined/i);
      // No false world-conclusion: the text may not claim the session is gone.
      expect(result.error).not.toMatch(/not found/i);
    });

    it("session-missing text states its positive tmux evidence", async () => {
      seedSeat();
      const result = await transportOver(SESSION_GONE).send(SEAT, "hello");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toMatch(/tmux reports no session/i);
    });
  });

  // Walk and nudge inherit the gate through the same shared path (mini-req 3):
  // every walk piece POSTs /api/transport/send (packages/cli/src/commands/walk.ts
  // — piece send and staged-text Enter submit both post this route), and the
  // queue's nudge path wires the SAME SessionTransport instance via
  // QueueRepository.attachTransport (startup.ts). This is the representative
  // execution of that route under an injected no-server condition.
  it("walk's route (/api/transport/send) surfaces the transport outcome under no-server", async () => {
    seedSeat();
    const app = new Hono();
    const transport = transportOver(NO_SERVER);
    app.use("*", async (c, next) => {
      c.set("sessionTransport" as never, transport);
      await next();
    });
    app.route("/api/transport", transportRoutes());

    const res = await app.request("/api/transport/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: SEAT, text: "hello" }),
    });
    const body = (await res.json()) as { reason?: string; error?: string };
    expect(body.reason).toBe("tmux_unavailable");
    expect(body.error).toMatch(/not determined/i);
  });

  describe("no fabricated verdicts (mini-req 5)", () => {
    it("a transport blip against a live registered seat writes NO absence verdict and ps does not down-rank it", async () => {
      seedSeat();
      await transportOver(NO_SERVER).send(SEAT, "hello");
      expect(verdictRows()).toHaveLength(0);
      // The EFFECT, not just the indicator (proof item 4): the live seat stays
      // projected as running after the blip.
      const entry = new PsProjectionService({ db }).getEntries()[0]!;
      expect(entry.runningCount).toBe(1);
      expect(entry.status).toBe("running");
    });

    it("a socket-gone blip likewise writes NO absence verdict and ps does not down-rank it", async () => {
      seedSeat();
      await transportOver(SOCKET_GONE).capture(SEAT);
      expect(verdictRows()).toHaveLength(0);
      const entry = new PsProjectionService({ db }).getEntries()[0]!;
      expect(entry.runningCount).toBe(1);
      expect(entry.status).toBe("running");
    });

    it("genuine session absence still writes the verdict and ps down-ranks the seat", async () => {
      seedSeat();
      await transportOver(SESSION_GONE).send(SEAT, "hello");
      const rows = verdictRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.reason).toBe("session_missing");
      // Opposite discriminator: positive absence DOES change the projection.
      const entry = new PsProjectionService({ db }).getEntries()[0]!;
      expect(entry.runningCount).toBe(0);
      expect(entry.status).not.toBe("running");
    });
  });
});

describe("cold-start preserved: boot reconciliation still detaches under a dead server (mini-req 2)", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let eventBus: EventBus;

  beforeEach(() => {
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    eventBus = new EventBus(db);
  });

  afterEach(() => {
    db.close();
  });

  function seedRunningSession() {
    const rig = rigRepo.createRig("my-rig");
    const node = rigRepo.addNode(rig.id, "dev.impl", { role: "worker", runtime: "claude-code" });
    const session = sessionRegistry.registerSession(node.id, SEAT);
    sessionRegistry.updateStatus(session.id, "running");
    return { rig, node, session };
  }

  it("no-server: stale rows are detached, not errored", async () => {
    const { rig } = seedRunningSession();
    const reconciler = new Reconciler({
      db,
      sessionRegistry,
      eventBus,
      tmuxAdapter: new TmuxAdapter(failingExec(NO_SERVER)),
    });
    const result = await reconciler.reconcile(rig.id);
    expect(result.detached).toBe(1);
    expect(result.errors).toEqual([]);
  });

  it("socket-gone: stale rows are detached, not errored", async () => {
    const { rig } = seedRunningSession();
    const reconciler = new Reconciler({
      db,
      sessionRegistry,
      eventBus,
      tmuxAdapter: new TmuxAdapter(failingExec(SOCKET_GONE)),
    });
    const result = await reconciler.reconcile(rig.id);
    expect(result.detached).toBe(1);
    expect(result.errors).toEqual([]);
  });

  it("permission denied stays fail-closed: errored, never detached", async () => {
    const { rig } = seedRunningSession();
    const reconciler = new Reconciler({
      db,
      sessionRegistry,
      eventBus,
      tmuxAdapter: new TmuxAdapter(failingExec(PERMISSION)),
    });
    const result = await reconciler.reconcile(rig.id);
    expect(result.detached).toBe(0);
    expect(result.errors).toHaveLength(1);
  });
});
