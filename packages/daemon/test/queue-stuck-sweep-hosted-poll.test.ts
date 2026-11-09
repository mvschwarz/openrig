// A hosted member with no wake trigger picks up its work by polling the queue (an outside executor reads its own inbox).
// Nothing can push work to it, by design, so its rows' unroutable wakes aren't failed deliveries: no finding per row.
// Two clocks stay separate. Its own inbox reads (check-ins, recorded by the list route) say whether it's reading its
// queue; each row's own age, which a check-in never resets, decides when unclaimed work surfaces, in one standing
// notice per member.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { QueueRepository, type QueueItem } from "../src/domain/queue-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { queueRoutes } from "../src/routes/queue.js";
import type { RosterWake } from "../src/domain/rosters.js";
import { createStuckSweepStatus, runStuckSweep, STUCK_SWEEP_FINDING_TAG, unclaimedBacklogTag } from "../src/domain/queue-stuck-sweep.js";

const MEMBER = "helper-a@hub";
const PERSON = "person@external";

describe("stuck sweep: a hosted member that polls for its work", () => {
  let db: Database.Database;
  let bus: EventBus;
  let repo: QueueRepository;

  function makeRepo(opts: { hostedWake?: (d: string) => RosterWake | null; resolveSessionAddresses?: (n: string) => string[] } = {}): QueueRepository {
    return new QueueRepository(db, bus, {
      validateRig: () => true,
      loadHumanRegistry: () => ({ ok: true, entities: [] }),
      isHostedMember: (d) => d === MEMBER,
      hostedWake: opts.hostedWake ?? (() => null),
      ...(opts.resolveSessionAddresses ? { resolveSessionAddresses: opts.resolveSessionAddresses } : {}),
    });
  }

  /** Bound agent seats, so the member (no terminal, a roster entry with no trigger) classifies as it does on a daemon. */
  function seedSeat(name: string): void {
    const id = name.split("@")[0]!;
    db.prepare("INSERT OR IGNORE INTO rigs (id, name) VALUES ('rig-hub', 'hub')").run();
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id, runtime, cwd) VALUES (?, 'rig-hub', ?, 'claude-code', '/tmp')").run(`node-${id}`, id);
    db.prepare("INSERT INTO sessions (id, node_id, session_name, status, created_at) VALUES (?, ?, ?, 'running', '2026-07-02 12:00:00')").run(`sess-${id}`, `node-${id}`, name);
    db.prepare("INSERT INTO bindings (id, node_id, attachment_type, tmux_session, tmux_pane) VALUES (?, ?, 'tmux', ?, ?)").run(`bind-${id}`, `node-${id}`, name, `%${id.length}`);
  }

  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db, ALL_MIGRATIONS);
    bus = new EventBus(db);
    repo = makeRepo();
    seedSeat("lead@hub");
  });
  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  function appFor(r: QueueRepository): Hono {
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("eventBus" as never, bus as never);
      c.set("queueRepo" as never, r as never);
      await next();
    });
    app.route("/api/queue", queueRoutes());
    return app;
  }
  /** The member's executor reading the queue, as the MCP list tool does for an external caller (`as`, active rows). */
  async function poll(r: QueueRepository = repo, query = `as=${MEMBER}&activeOnly=1&compact=1&limit=100`, sender: string | null = MEMBER): Promise<Response> {
    const res = await appFor(r).request(`/api/queue/list?${query}`, { headers: sender ? { "X-OpenRig-Session": sender } : {} });
    expect(res.status).toBe(200);
    return res;
  }

  /** Work for a destination; its wake recorded as the daemon records it (the member's teaching, or the given result). */
  async function work(dest = MEMBER, opts: { from?: string; ageMinutes?: number; result?: string } = {}): Promise<QueueItem> {
    const row = await repo.create({ sourceSession: opts.from ?? "lead@hub", destinationSession: dest, body: "work", summary: `work for ${dest}`, nudge: false });
    let result = opts.result;
    if (!result) {
      const cls = repo.classifyDestinationOf(dest);
      expect(cls.class).toBe("unroutable");
      if (cls.class === "unroutable") result = cls.teaching;
    }
    db.prepare("UPDATE queue_items SET last_nudge_attempt = ?, last_nudge_result = ? WHERE qitem_id = ?").run(new Date().toISOString(), result, row.qitemId);
    if (opts.ageMinutes) {
      db.prepare("UPDATE queue_items SET ts_created = ? WHERE qitem_id = ?").run(new Date(Date.now() - opts.ageMinutes * 60_000).toISOString(), row.qitemId);
    }
    return repo.getById(row.qitemId)!;
  }

  async function sweep(overrides: Record<string, unknown> = {}) {
    return runStuckSweep({ db, queueRepo: repo, status: createStuckSweepStatus(), resolveOrchestrator: () => null, unclaimedAgeMinutes: 60,
      log: () => {}, isRegisteredHost: () => false, resolveRecoveryAgentSeat: () => null, resolveOperatorSeat: () => PERSON, ...overrides });
  }
  const findings = (): QueueItem[] => repo.list({ limit: 500 }).filter((i) => (i.tags ?? []).includes(STUCK_SWEEP_FINDING_TAG));
  const notices = (): QueueItem[] => findings().filter((i) => (i.tags ?? []).includes(unclaimedBacklogTag(MEMBER)));
  const perRow = (): QueueItem[] => findings().filter((i) => !(i.tags ?? []).includes(unclaimedBacklogTag(MEMBER)));

  it("ordinary polling: several items, read and claimed as they come, make no finding at all", async () => {
    const rows = [await work(), await work(), await work()];
    await poll();
    repo.claim({ qitemId: rows[0]!.qitemId, destinationSession: MEMBER });
    repo.claim({ qitemId: rows[1]!.qitemId, destinationSession: MEMBER });
    await sweep();
    expect(findings()).toEqual([]);
  });

  it("stopped polling: work past the unclaimed age gets one notice to the person, saying when the member last checked in", async () => {
    const at = new Date(Date.now() - 3 * 3_600_000);
    repo.recordInboxCheckIn(MEMBER, at);
    const rows = [await work(MEMBER, { ageMinutes: 61 }), await work(MEMBER, { ageMinutes: 90 })];
    await sweep();
    expect(perRow()).toEqual([]);
    const [notice, ...more] = notices();
    expect(more).toEqual([]);
    expect(notice!.destinationSession).toBe(PERSON);
    expect(notice!.sourceSession).toBe(MEMBER);
    expect(notice!.body).toContain(`check-ins: no check-in observed since ${at.toISOString()}`);
    expect(notice!.body).toContain("no read of its own inbox has been observed in that time. Ask its owner to check it's running, or route the work to another seat");
    for (const row of rows) expect(notice!.body).toContain(`- ${row.qitemId}, unclaimed since ${row.tsCreated}, from lead@hub: work for ${MEMBER}`);
    expect(notice!.body).not.toMatch(/dead/i);
  });

  it("a member that never checked in says so", async () => {
    await work(MEMBER, { ageMinutes: 61 });
    await sweep();
    expect(notices()[0]!.body).toContain("check-ins: no check-in observed yet");
  });

  it("polling without claiming: old work still surfaces, and the member's check-ins neither reset its age nor rewrite the notice", async () => {
    const old = await work(MEMBER, { ageMinutes: 61 });
    const young = await work();
    await poll();
    await sweep();
    const [notice] = notices();
    expect(notice!.body).toContain("check-ins: checking in: it read its own inbox within the last 60 min");
    expect(notice!.body).toContain("it's checking in, but this work is still unclaimed");
    expect(notice!.body).toContain(`- ${old.qitemId}, unclaimed since ${old.tsCreated}`);
    expect(notice!.body).not.toContain(young.qitemId);
    expect(perRow()).toEqual([]);

    await poll();
    await sweep();
    expect(notices()).toHaveLength(1);
    expect(repo.getById(notice!.qitemId)!.body).toBe(notice!.body);
  });

  it.each([
    ["the member's own inbox, empty", `destinationSession=${MEMBER}`, MEMBER, true],
    ["the MCP list tool's own read", `as=${MEMBER}&activeOnly=1&compact=1&limit=100`, MEMBER, true],
    ["a filtered, paginated read of its pending rows", `destinationSession=${MEMBER}&state=pending&limit=1`, MEMBER, true],
    ["a read that can't return pending rows", `destinationSession=${MEMBER}&state=done`, MEMBER, false],
    ["another actor reading the member's inbox", `destinationSession=${MEMBER}`, "lead@hub", false],
    ["a read with no sender", `destinationSession=${MEMBER}`, null, false],
    ["the attention view", `destinationSession=${MEMBER}&attention=1`, MEMBER, false],
    ["the member's rows with someone else", `destinationSession=${MEMBER}&as=lead@hub`, MEMBER, false],
    ["a team read", "rig=hub", MEMBER, false],
    ["a read of only what the member sent", `as=${MEMBER}&sourceSession=${MEMBER}`, MEMBER, false],
    ["the member's own rows from one sender", `as=${MEMBER}&sourceSession=lead@hub`, MEMBER, true],
    ["its own inbox filtered to rows it sent itself", `destinationSession=${MEMBER}&sourceSession=${MEMBER}`, MEMBER, true],
  ] as const)("check-in from %s: %s", async (_label, query, sender, counts) => {
    await poll(repo, query, sender);
    expect(repo.lastInboxCheckIn(MEMBER).state).toBe(counts ? "seen" : "never");
  });

  it("a check-in that can't be written never fails the read, is logged once, and the notice says it's unknown", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    db.exec("DROP TABLE queue_inbox_checkins");
    const row = await work(MEMBER, { ageMinutes: 61 });
    const listed = await (await poll()).json() as Array<{ qitemId: string }>;
    expect(listed.map((r) => r.qitemId)).toContain(row.qitemId);
    await poll();
    expect(errors.mock.calls.filter((call) => String(call[0]).includes("inbox check-in not recorded"))).toHaveLength(1);
    expect(repo.lastInboxCheckIn(MEMBER)).toEqual({ state: "unknown" });
    await sweep();
    expect(notices()[0]!.body).toContain("check-ins: unknown: its check-ins couldn't be read");
  });

  it("after a restart the stale check-in is still known, and the first new read records at once", async () => {
    const at = new Date(Date.now() - 3 * 3_600_000);
    repo.recordInboxCheckIn(MEMBER, at);
    const restarted = makeRepo();
    expect(restarted.lastInboxCheckIn(MEMBER)).toEqual({ state: "seen", at: at.toISOString() });
    await poll(restarted);
    const now = restarted.lastInboxCheckIn(MEMBER);
    expect(now.state === "seen" && Date.parse(now.at) > at.getTime()).toBe(true);
  });

  it("a reconnect under another name of the same seat counts for that seat", async () => {
    const alias = "helper-a@hub@host-1";
    const r = makeRepo({ resolveSessionAddresses: (n) => (n === MEMBER || n === alias ? [MEMBER, alias] : [n]) });
    await poll(r, `destinationSession=${MEMBER}`, alias);
    expect(r.lastInboxCheckIn(MEMBER).state).toBe("seen");
  });

  it("an explicit hold and a claim each take a row off the notice, and the notice closes when none is left", async () => {
    const [held, claimed] = [await work(MEMBER, { ageMinutes: 61 }), await work(MEMBER, { ageMinutes: 62 })];
    await sweep();
    const [notice] = notices();
    expect(notice!.body).toContain("unclaimed: 2 rows");
    await repo.update({ qitemId: held.qitemId, actorSession: MEMBER, state: "blocked", blockedOn: "external:vendor" } as never);
    await sweep();
    expect(repo.getById(notice!.qitemId)!.body).toContain("unclaimed: 1 row");
    expect(repo.getById(notice!.qitemId)!.body).not.toContain(held.qitemId);
    repo.claim({ qitemId: claimed.qitemId, destinationSession: MEMBER });
    await sweep();
    expect(repo.getById(notice!.qitemId)!.state).toBe("done");
    expect(perRow()).toEqual([]);
  });

  it("a real ring failure for a member with a trigger keeps its own finding, which goes to the person", async () => {
    repo = makeRepo({ hostedWake: (d) => (d === MEMBER ? { webhook: { url_ref: "HELPER_A_WAKE" } } as RosterWake : null) });
    expect(repo.classifyDestinationOf(MEMBER).class).toBe("hosted");
    const row = await work(MEMBER, { result: "failed:webhook (HELPER_A_WAKE) answered 500" });
    await sweep();
    expect(notices()).toEqual([]);
    const [finding] = perRow();
    expect(finding!.summary).toBe(`Stuck sweep: undelivered-wake on ${row.qitemId} (0 min)`);
    expect(finding!.destinationSession).toBe(PERSON);
  });

  it("an unroutable address that no roster lists keeps a finding per row", async () => {
    const row = await work("typo@hub");
    await sweep();
    expect(notices()).toEqual([]);
    const [finding] = perRow();
    expect(finding!.summary).toBe(`Stuck sweep: undelivered-wake on ${row.qitemId} (0 min)`);
    expect(finding!.body).toContain("typo@hub has no wake route on this daemon");
  });

  it("a route the member declares takes its rows, one finding each", async () => {
    const row = await work(MEMBER, { ageMinutes: 61 });
    await sweep({ resolveOrchestrator: (s: string) => (s === MEMBER ? "lead@hub" : null) });
    expect(notices()).toEqual([]);
    const [finding] = perRow();
    expect(finding!.summary).toBe(`Stuck sweep: unclaimed-obligation on ${row.qitemId} (61 min)`);
    expect(finding!.destinationSession).toBe("lead@hub");
  });

  it("with no person, the notice goes to the rows' creator when they share one, else to the operator agent", async () => {
    seedSeat("orch@hub");
    seedSeat("operator@hub");
    await work(MEMBER, { ageMinutes: 61 });
    await sweep({ resolveOperatorSeat: () => null, resolveRecoveryAgentSeat: () => "operator@hub" });
    expect(notices()[0]!.destinationSession).toBe("lead@hub");

    db.prepare("UPDATE queue_items SET state = 'done' WHERE qitem_id = ?").run(notices()[0]!.qitemId);
    await work(MEMBER, { from: "orch@hub", ageMinutes: 70 });
    await sweep({ resolveOperatorSeat: () => null, resolveRecoveryAgentSeat: () => "operator@hub" });
    const open = notices().filter((n) => n.state === "pending");
    expect(open.map((n) => n.destinationSession)).toEqual(["operator@hub"]);
  });
});
