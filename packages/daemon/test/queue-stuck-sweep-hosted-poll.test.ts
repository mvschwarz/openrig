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
import type { RosterMember, RosterWake } from "../src/domain/rosters.js";
import { createStuckSweepStatus, runStuckSweep, STUCK_SWEEP_FINDING_TAG, unclaimedBacklogTag } from "../src/domain/queue-stuck-sweep.js";

const MEMBER = "helper-a@hub";
const PERSON = "person@external";

describe("stuck sweep: a hosted member that polls for its work", () => {
  let db: Database.Database;
  let bus: EventBus;
  let repo: QueueRepository;

  function makeRepo(opts: { hostedWake?: (d: string) => RosterWake | null; resolveSessionAddresses?: (n: string) => string[];
    validateRig?: (d: string) => boolean; hostedMembers?: () => RosterMember[] } = {}): QueueRepository {
    return new QueueRepository(db, bus, {
      validateRig: opts.validateRig ?? (() => true),
      loadHumanRegistry: () => ({ ok: true, entities: [] }),
      isHostedMember: (d) => d === MEMBER,
      hostedWake: opts.hostedWake ?? (() => null),
      hostedMembers: opts.hostedMembers ?? (() => []),
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
    expect(notice!.body).toContain(`check-ins: unknown (no check-in cadence declared); no check-in since ${at.toISOString()}`);
    expect(notice!.body).toContain("no read of its own inbox has been observed in that time. Ask its owner to check it's running, or route the work to another seat");
    for (const row of rows) expect(notice!.body).toContain(`- ${row.qitemId}, unclaimed since ${row.tsCreated}, from lead@hub: work for ${MEMBER}`);
    expect(notice!.body).not.toMatch(/dead/i);
  });

  /** The member as its roster lists it, with the cadence its person stated at setup (or none). */
  const asListed = (checkInMinutes?: number): RosterMember[] => [{ seat: MEMBER, host: "hub", capabilities: ["research"],
    engagement: ["delegate"], use_when: "research", why: "it researches", hosted: true,
    ...(checkInMinutes === undefined ? {} : { check_in_minutes: checkInMinutes }) }];

  it("a stated cadence decides only the notice's check-in line, never when the notice is filed: overdue past twice it, checking in within it", async () => {
    const at = new Date(Date.now() - 3 * 3_600_000);
    repo = makeRepo({ hostedMembers: () => asListed(60) });
    repo.recordInboxCheckIn(MEMBER, at);
    await work(MEMBER, { ageMinutes: 61 });
    await sweep();
    expect(notices()[0]!.body).toContain(`check-ins: overdue: last check-in ${at.toISOString()}, expected every 60 min; its schedule may be off or waiting for an approval`);
    expect(notices()[0]!.body).toContain("why: nobody has claimed these rows, and it hasn't checked in as often as its setup expects.");

    // The same three-hour-old check-in is on time for a member expected every four hours, though older than the
    // unclaimed age that judges a member with no stated cadence.
    db.close();
    db = new Database(":memory:");
    migrate(db, ALL_MIGRATIONS);
    bus = new EventBus(db);
    repo = makeRepo({ hostedMembers: () => asListed(240) });
    seedSeat("lead@hub");
    repo.recordInboxCheckIn(MEMBER, at);
    await work(MEMBER, { ageMinutes: 61 });
    await sweep();
    expect(notices()[0]!.body).toContain("check-ins: checking in: its last check-in is within twice its expected 240 min");
  });

  it("the notice says what the hosted-members read says: an unusable cadence reads unknown with its reason, even with a fresh check-in", async () => {
    const member = { ...asListed()[0]!, check_in_problem: "check_in_minutes \"60\" isn't a positive whole number of minutes" };
    repo = makeRepo({ hostedMembers: () => [member] });
    repo.recordInboxCheckIn(MEMBER, new Date(Date.now() - 5 * 60_000));
    await work(MEMBER, { ageMinutes: 61 });
    await sweep();
    expect(repo.hostedMemberCheckIns()[0]).toMatchObject({ status: "unknown", reason: member.check_in_problem });
    expect(notices()[0]!.body).toContain(`check-ins: unknown (${member.check_in_problem}); it read its own inbox within the last 60 min`);
    expect(notices()[0]!.body).not.toContain("checking in");
  });

  it("check-in status is a status, never a refusal: work for an overdue or never-seen member queues and is recorded as before", async () => {
    repo = makeRepo({ hostedMembers: () => asListed(60) });
    repo.recordInboxCheckIn(MEMBER, new Date(Date.now() - 5 * 3_600_000));
    const overdue = await repo.create({ sourceSession: "lead@hub", destinationSession: MEMBER, body: "work", summary: "work" });
    const unlisted = makeRepo();
    const baseline = await unlisted.create({ sourceSession: "lead@hub", destinationSession: MEMBER, body: "work", summary: "work" });
    expect(repo.getById(overdue.qitemId)).toMatchObject({ state: "pending", destinationSession: MEMBER });
    expect(repo.getById(overdue.qitemId)!.lastNudgeResult).toBe(unlisted.getById(baseline.qitemId)!.lastNudgeResult);
    expect(repo.hostedMemberCheckIns().map((m) => m.status)).toEqual(["check-in-overdue"]);
  });

  it("the hosted-members read gives each member's status, last check-in and stated cadence", async () => {
    const members = [...asListed(60), { ...asListed()[0]!, seat: "helper-b@hub", check_in_on_request: true as const },
      { ...asListed(30)[0]!, seat: "helper-c@hub" }, { ...asListed()[0]!, seat: "helper-d@hub" }];
    repo = makeRepo({ hostedMembers: () => members });
    const at = new Date(Date.now() - 10 * 60_000);
    repo.recordInboxCheckIn(MEMBER, at);
    repo.recordInboxCheckIn("helper-b@hub", at);
    repo.recordInboxCheckIn("helper-d@hub", at);
    const res = await appFor(repo).request("/api/queue/hosted-members");
    expect(res.status).toBe(200);
    const body = await res.json() as { hostId: unknown; members: unknown };
    expect(body).toHaveProperty("hostId");
    expect(body.members).toEqual([
      { seat: MEMBER, rung: false, status: "checking-in", lastCheckInAt: at.toISOString(), expectedMinutes: 60, onRequest: false, reporter: "openrig-observed" },
      { seat: "helper-b@hub", rung: false, status: "on-request", lastCheckInAt: at.toISOString(), expectedMinutes: null, onRequest: true, reporter: "openrig-observed" },
      { seat: "helper-c@hub", rung: false, status: "no-check-in-yet", lastCheckInAt: null, expectedMinutes: 30, onRequest: false, reporter: "openrig-observed" },
      // States neither a cadence nor on request: unknown, with its last check-in, never on request, idle or overdue.
      { seat: "helper-d@hub", rung: false, status: "unknown", lastCheckInAt: at.toISOString(), expectedMinutes: null, onRequest: false,
        reporter: "openrig-observed", reason: "no check-in cadence declared" },
    ]);
  });

  it("a member that never checked in says so", async () => {
    await work(MEMBER, { ageMinutes: 61 });
    await sweep();
    expect(notices()[0]!.body).toContain("check-ins: no check-in yet; no check-in cadence declared");
  });

  it("polling without claiming: old work still surfaces, and the member's check-ins neither reset its age nor rewrite the notice", async () => {
    const old = await work(MEMBER, { ageMinutes: 61 });
    const young = await work();
    await poll();
    await sweep();
    const [notice] = notices();
    expect(notice!.body).toContain("check-ins: unknown (no check-in cadence declared); it read its own inbox within the last 60 min");
    expect(notice!.body).toContain("it's reading its own inbox, but this work is still unclaimed");
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
    ["a follow-through read that returns nothing", `as=${MEMBER}&handedOffFrom=qitem-none`, MEMBER, false],
    ["its own inbox filtered to one row's successors", `destinationSession=${MEMBER}&handedOffFrom=qitem-none`, MEMBER, true],
  ] as const)("check-in from %s: %s", async (_label, query, sender, counts) => {
    await poll(repo, query, sender);
    expect(repo.lastInboxCheckIn(MEMBER).state).toBe(counts ? "seen" : "never");
  });

  it("a follow-through read counts only when it returns a pending row handed to the member, not one it handed on", async () => {
    const handedOn = await repo.create({ sourceSession: "lead@hub", destinationSession: MEMBER, body: "x", nudge: false });
    await repo.handoff({ qitemId: handedOn.qitemId, fromSession: MEMBER, toSession: "lead@hub", nudge: false });
    await poll(repo, `as=${MEMBER}&handedOffFrom=${handedOn.qitemId}`);
    expect(repo.lastInboxCheckIn(MEMBER).state).toBe("never");

    const handedIn = await repo.create({ sourceSession: "orch@hub", destinationSession: "lead@hub", body: "y", nudge: false });
    await repo.handoff({ qitemId: handedIn.qitemId, fromSession: "lead@hub", toSession: MEMBER, nudge: false });
    await poll(repo, `as=${MEMBER}&handedOffFrom=${handedIn.qitemId}`);
    expect(repo.lastInboxCheckIn(MEMBER).state).toBe("seen");
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
    expect(notices()[0]!.body).toContain("check-ins: unknown (its check-ins couldn't be read)");
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

  // Review of #3049: an unreadable list is rebuilt from every row still waiting at the member, never left alone or
  // narrowed, so another creator's row still moves the notice on and never stays unseen.
  it.each(["missing", "malformed"] as const)("a notice to a creator whose list is %s still moves on for another creator's row", async (how) => {
    seedSeat("orch@hub");
    seedSeat("operator@hub");
    const noPerson = { resolveOperatorSeat: () => null, resolveRecoveryAgentSeat: () => "operator@hub" };
    const first = await work(MEMBER, { ageMinutes: 61 });
    await sweep(noPerson);
    const [toLead] = notices();
    expect(toLead!.destinationSession).toBe("lead@hub");
    const prefix = "Every row this notice stands for: ";
    const body = repo.getById(toLead!.qitemId)!.body.split("\n").filter((l) => !l.startsWith(prefix)).join("\n");
    db.prepare("UPDATE queue_items SET body = ? WHERE qitem_id = ?").run(how === "malformed" ? `${body}\n${prefix}[` : body, toLead!.qitemId);
    const other = await work(MEMBER, { from: "orch@hub", ageMinutes: 70 });
    await sweep(noPerson);
    const open = notices().filter((n) => n.state === "pending");
    expect(open.map((n) => n.destinationSession)).toEqual(["operator@hub"]);
    for (const row of [first, other]) expect(open[0]!.body).toContain(row.qitemId);
    expect(repo.getById(toLead!.qitemId)!.state).toBe("done");
  });

  it("a notice to a creator whose list is unreadable isn't moved on by another creator's row that doesn't qualify yet", async () => {
    seedSeat("orch@hub");
    seedSeat("operator@hub");
    const noPerson = { resolveOperatorSeat: () => null, resolveRecoveryAgentSeat: () => "operator@hub" };
    await work(MEMBER, { ageMinutes: 61 });
    await sweep(noPerson);
    const [toLead] = notices();
    const prefix = "Every row this notice stands for: ";
    const body = repo.getById(toLead!.qitemId)!.body.split("\n").filter((l) => !l.startsWith(prefix)).join("\n");
    db.prepare("UPDATE queue_items SET body = ? WHERE qitem_id = ?").run(body, toLead!.qitemId);
    await work(MEMBER, { from: "orch@hub", ageMinutes: 1 });
    await sweep(noPerson);
    expect(notices().filter((n) => n.state === "pending").map((n) => n.destinationSession)).toEqual(["lead@hub"]);
  });

  // Review of #3049: an old recipient the sweep no longer recognizes isn't proof the rows were its own. A notice the
  // operator agent got for two creators' rows keeps standing for both when the operator setting changes and its list
  // is unreadable, even with a raised threshold hiding both rows.
  it.each(["missing", "malformed"] as const)("a notice whose list is %s keeps every row when the operator it went to is no longer recognized", async (how) => {
    seedSeat("orch@hub");
    seedSeat("operator@hub");
    seedSeat("operator2@hub");
    const first = await work(MEMBER, { ageMinutes: 70 });
    const other = await work(MEMBER, { from: "orch@hub", ageMinutes: 70 });
    await sweep({ resolveOperatorSeat: () => null, resolveRecoveryAgentSeat: () => "operator@hub" });
    const [toOperator] = notices();
    expect(toOperator!.destinationSession).toBe("operator@hub");
    const prefix = "Every row this notice stands for: ";
    const body = repo.getById(toOperator!.qitemId)!.body.split("\n").filter((l) => !l.startsWith(prefix)).join("\n");
    db.prepare("UPDATE queue_items SET body = ? WHERE qitem_id = ?").run(how === "malformed" ? `${body}\n${prefix}[` : body, toOperator!.qitemId);
    await sweep({ resolveOperatorSeat: () => null, resolveRecoveryAgentSeat: () => "operator2@hub", unclaimedAgeMinutes: 120 });
    const open = notices().filter((n) => n.state === "pending");
    expect(open.length).toBeGreaterThan(0);
    for (const row of [first, other]) expect(open.some((n) => repo.getById(n.qitemId)!.body.includes(row.qitemId))).toBe(true);
  });

  it("a creator's notice that grows with another creator's row in place loses the creator mark", async () => {
    seedSeat("orch@hub");
    seedSeat("operator@hub");
    const first = await work(MEMBER, { ageMinutes: 70 });
    await sweep({ resolveOperatorSeat: () => null, resolveRecoveryAgentSeat: () => "operator@hub" });
    const [toLead] = notices();
    expect(toLead!.destinationSession).toBe("lead@hub");
    expect(toLead!.tags).toContain("stuck-sweep-backlog-to-creator:lead@hub");
    // lead@hub becomes the recovery agent: it sees any row, so another creator's row joins its notice in place.
    const other = await work(MEMBER, { from: "orch@hub", ageMinutes: 70 });
    await sweep({ resolveOperatorSeat: () => null, resolveRecoveryAgentSeat: () => "lead@hub" });
    expect(repo.getById(toLead!.qitemId)!.body).toContain(other.qitemId);
    expect((repo.getById(toLead!.qitemId)!.tags ?? []).some((t) => t.startsWith("stuck-sweep-backlog-to-creator"))).toBe(false);
    // Then the setting changes back and the list is unreadable: the other creator's row is still stood for.
    const prefix = "Every row this notice stands for: ";
    const body = repo.getById(toLead!.qitemId)!.body.split("\n").filter((l) => !l.startsWith(prefix)).join("\n");
    db.prepare("UPDATE queue_items SET body = ? WHERE qitem_id = ?").run(body, toLead!.qitemId);
    await sweep({ resolveOperatorSeat: () => null, resolveRecoveryAgentSeat: () => "operator@hub", unclaimedAgeMinutes: 120 });
    const open = notices().filter((n) => n.state === "pending");
    for (const row of [first, other]) expect(open.some((n) => repo.getById(n.qitemId)!.body.includes(row.qitemId))).toBe(true);
  });

  it("the creator mark alone proves provenance: a member that gains a wake keeps its creator's notice to that creator's rows", async () => {
    seedSeat("orch@hub");
    seedSeat("operator@hub");
    const noPerson = { resolveOperatorSeat: () => null, resolveRecoveryAgentSeat: () => "operator@hub" };
    await work(MEMBER, { ageMinutes: 70 });
    await sweep(noPerson);
    const [toLead] = notices();
    expect(toLead!.tags).toContain("stuck-sweep-backlog-to-creator:lead@hub");
    const prefix = "Every row this notice stands for: ";
    const body = repo.getById(toLead!.qitemId)!.body.split("\n").filter((l) => !l.startsWith(prefix)).join("\n");
    db.prepare("UPDATE queue_items SET body = ? WHERE qitem_id = ?").run(body, toLead!.qitemId);
    // The member gains a wake (no longer polled), and another creator's young row arrives with its wake verified.
    repo = makeRepo({ hostedWake: (d) => (d === MEMBER ? { webhook: { url_ref: "HELPER_A_WAKE" } } as RosterWake : null) });
    await work(MEMBER, { from: "orch@hub", ageMinutes: 5, result: "verified" });
    await sweep(noPerson);
    const toLeadNow = notices().filter((n) => n.state === "pending" && n.destinationSession === "lead@hub");
    for (const n of toLeadNow) expect(repo.getById(n.qitemId)!.body).not.toContain("orch@hub");
  });

  // Review of #3049: the mark names the creator the sweep filed the notice to. A notice that changes hands (a queue handoff
  // carries its tags; a fallback changes its destination in place) still stands for that creator's rows, never for the
  // rows of whoever holds it now, even with its list gone and a raised threshold hiding them.
  it.each(["handoff", "fallback"] as const)("a marked notice that changes hands by %s, its list unreadable, still stands for the creator's rows", async (how) => {
    seedSeat("orch@hub");
    seedSeat("operator@hub");
    seedSeat("helper@hub");
    const noPerson = { resolveOperatorSeat: () => null, resolveRecoveryAgentSeat: () => "operator@hub" };
    const first = await work(MEMBER, { ageMinutes: 90 });
    await sweep(noPerson);
    const [toLead] = notices();
    expect(toLead!.destinationSession).toBe("lead@hub");
    if (how === "handoff") {
      // Handed on with no tags of its own and a body of its own: the successor carries the key and the mark, no list.
      const { created } = await repo.handoff({ qitemId: toLead!.qitemId, fromSession: "lead@hub", toSession: "helper@hub",
        body: "Can you look at this member's backlog?", nudge: false });
      expect(created.tags).toEqual(toLead!.tags);
    } else {
      repo.routeToFallback(toLead!.qitemId, "helper@hub", "lead@hub stopped");
      const prefix = "Every row this notice stands for: ";
      const body = repo.getById(toLead!.qitemId)!.body.split("\n").filter((l) => !l.startsWith(prefix)).join("\n");
      db.prepare("UPDATE queue_items SET body = ? WHERE qitem_id = ?").run(body, toLead!.qitemId);
    }
    const pass = await sweep({ ...noPerson, unclaimedAgeMinutes: 120 });
    expect(pass.outcome).not.toBe("failed");
    // The creator's row still waits, and an open notice's rebuilt list stands for it.
    expect(repo.getById(first.qitemId)!.state).toBe("pending");
    const open = notices().filter((n) => ["pending", "in-progress", "blocked"].includes(n.state));
    expect(open.some((n) => repo.getById(n.qitemId)!.body.split("\n")
      .some((l) => l.startsWith("Every row this notice stands for: ") && l.includes(first.qitemId)))).toBe(true);
  });

  // Review of #3049: a notice with two creator marks (tags passed by hand on a handoff or create) names no creator, so
  // with its list unreadable it is rebuilt from every unresolved row, never from the first mark's rows alone.
  it("a notice with two creator marks and an unreadable list stands for every unresolved row", async () => {
    seedSeat("orch@hub");
    seedSeat("operator@hub");
    const noPerson = { resolveOperatorSeat: () => null, resolveRecoveryAgentSeat: () => "operator@hub" };
    const first = await work(MEMBER, { ageMinutes: 90 });
    await sweep(noPerson);
    const [toLead] = notices();
    expect(toLead!.tags).toContain("stuck-sweep-backlog-to-creator:lead@hub");
    const other = await work(MEMBER, { from: "orch@hub", ageMinutes: 90 });
    const prefix = "Every row this notice stands for: ";
    const body = repo.getById(toLead!.qitemId)!.body.split("\n").filter((l) => !l.startsWith(prefix)).join("\n");
    db.prepare("UPDATE queue_items SET body = ?, tags = json_insert(tags, '$[#]', ?) WHERE qitem_id = ?")
      .run(body, "stuck-sweep-backlog-to-creator:orch@hub", toLead!.qitemId);
    await sweep({ ...noPerson, unclaimedAgeMinutes: 120 });
    const open = notices().filter((n) => ["pending", "in-progress", "blocked"].includes(n.state));
    for (const row of [first, other]) expect(open.some((n) => repo.getById(n.qitemId)!.body.includes(row.qitemId))).toBe(true);
  });

  it("a member's notice to the one creator of its rows is marked even when that creator is also the recovery agent", async () => {
    await work(MEMBER, { ageMinutes: 70 });
    await sweep({ resolveOperatorSeat: () => null, resolveRecoveryAgentSeat: () => "lead@hub" });
    const [toLead] = notices();
    expect(toLead!.destinationSession).toBe("lead@hub");
    expect(toLead!.tags).toContain("stuck-sweep-backlog-to-creator:lead@hub");
  });

  it("a notice to a creator lists only that creator's rows: another creator's row moves every row to the next recipient", async () => {
    seedSeat("orch@hub");
    seedSeat("operator@hub");
    const noPerson = { resolveOperatorSeat: () => null, resolveRecoveryAgentSeat: () => "operator@hub" };
    const first = await work(MEMBER, { ageMinutes: 61 });
    await sweep(noPerson);
    const [toLead] = notices();
    expect(toLead!.destinationSession).toBe("lead@hub");

    // Another row from the same creator joins it in place.
    const second = await work(MEMBER, { ageMinutes: 62 });
    await sweep(noPerson);
    expect(notices().map((n) => n.qitemId)).toEqual([toLead!.qitemId]);
    expect(repo.getById(toLead!.qitemId)!.body).toContain(second.qitemId);

    // A row from another creator never reaches lead@hub: that notice closes, and one notice for every row goes on.
    const other = await work(MEMBER, { from: "orch@hub", ageMinutes: 70 });
    await sweep(noPerson);
    const closed = repo.getById(toLead!.qitemId)!;
    expect(closed.body).not.toContain(other.qitemId);
    expect(closed.state).toBe("done");
    const open = notices().filter((n) => n.state === "pending");
    expect(open.map((n) => n.destinationSession)).toEqual(["operator@hub"]);
    for (const row of [first, second, other]) expect(open[0]!.body).toContain(row.qitemId);

    // The operator agent sees any row: a further creator's row joins its notice in place.
    seedSeat("third@hub");
    const third = await work(MEMBER, { from: "third@hub", ageMinutes: 71 });
    await sweep(noPerson);
    expect(notices().filter((n) => n.state === "pending").map((n) => n.qitemId)).toEqual([open[0]!.qitemId]);
    expect(repo.getById(open[0]!.qitemId)!.body).toContain(third.qitemId);
    expect(perRow()).toEqual([]);
  });

  it("a re-file whose new notice can't be created leaves the old notice as it was, so no row loses its notice", async () => {
    seedSeat("orch@hub");
    seedSeat("operator@hub");
    let refuseOperator = false;
    repo = makeRepo({ validateRig: (d) => !(refuseOperator && d === "operator@hub") });
    const noPerson = { resolveOperatorSeat: () => null, resolveRecoveryAgentSeat: () => "operator@hub" };
    const first = await work(MEMBER, { ageMinutes: 61 });
    await sweep(noPerson);
    const [toLead] = notices();
    expect(toLead!.destinationSession).toBe("lead@hub");

    // The re-file's create fails: the old notice stays open and isn't rewritten, so it never lists the other row.
    const other = await work(MEMBER, { from: "orch@hub", ageMinutes: 70 });
    refuseOperator = true;
    const failed = await sweep(noPerson);
    expect(failed.outcome).toBe("failed");
    expect(repo.getById(toLead!.qitemId)!.body).toBe(toLead!.body);

    // The other creator's row is claimed before the next passes: the first row is still on exactly one open notice.
    repo.claim({ qitemId: other.qitemId, destinationSession: MEMBER });
    refuseOperator = false;
    await sweep(noPerson);
    await sweep(noPerson);
    const open = notices().filter((n) => n.state === "pending" && n.body.includes(first.qitemId));
    expect(open.map((n) => n.qitemId)).toEqual([toLead!.qitemId]);
    expect(repo.getById(toLead!.qitemId)!.state).toBe("pending");
    expect(notices().every((n) => n.destinationSession !== "lead@hub" || !n.body.includes(other.qitemId))).toBe(true);
    expect(perRow()).toEqual([]);
  });
});
