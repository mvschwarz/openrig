// #3964: a person's own Claude Code or Codex conversation (not a seat) hands work to its team with `--return-route auto`,
// and OpenRig issues it an address (`conversation-<12 hex>@kernel`, recorded as that work's `issued` or `issued-actor`
// return route). Nothing is pushed to that address: the conversation reads its own queue, through the openrig plugin's
// hooks or its own check, as a hosted member with no wake trigger does (#2864, #3222). So a seat's task there isn't a
// failed wake. Before, the sweep filed "wake failed (unroutable: … register the human)" for it within a minute, and the
// seat told the person their answer hadn't reached their conversation, though the hook had woken it (claude13's O2). Work
// the conversation leaves unclaimed past the unclaimed age is still reported, saying only what OpenRig knows, and an
// address OpenRig didn't issue here is reported as before.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository, type QueueItem } from "../src/domain/queue-repository.js";
import { issuedReturnAddress } from "../src/domain/return-route.js";
import { conversationKeyTag } from "../src/conversation-key-surface.js";
import { queueRoutes } from "../src/routes/queue.js";
import { createStuckSweepStatus, runStuckSweep, STUCK_SWEEP_FINDING_TAG, unclaimedBacklogTag } from "../src/domain/queue-stuck-sweep.js";

const SEAT = "dev-build@starter";
/** A client on this machine, as the CLI and the stdio MCP server reach the daemon. */
const LOCAL = { incoming: { socket: { remoteAddress: "127.0.0.1" } } };

describe("stuck sweep: a task at a conversation address OpenRig issued", () => {
  let db: Database.Database;
  let bus: EventBus;
  let repo: QueueRepository;
  let typed: string[];

  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db, ALL_MIGRATIONS);
    bus = new EventBus(db);
    repo = new QueueRepository(db, bus, { validateRig: () => true, loadHumanRegistry: () => ({ ok: true, entities: [] }) });
    typed = [];
    repo.attachTransport({ send: async (destination: string) => {
      typed.push(destination);
      return { ok: true, verified: true, sent: true, inputPhase: "written" };
    } } as never);
    // The team's seat, bound to a terminal, so an address with no binding classifies as it does on a daemon.
    db.prepare("INSERT INTO rigs (id, name) VALUES ('rig-starter', 'starter')").run();
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id, runtime, cwd) VALUES ('node-build', 'rig-starter', 'dev-build', 'claude-code', '/tmp')").run();
    db.prepare("INSERT INTO sessions (id, node_id, session_name, status, created_at) VALUES ('sess-build', 'node-build', ?, 'running', '2026-11-26 05:00:00')").run(SEAT);
    db.prepare("INSERT INTO bindings (id, node_id, attachment_type, tmux_session, tmux_pane) VALUES ('bind-build', 'node-build', 'tmux', ?, '%1')").run(SEAT);
  });
  afterEach(() => db.close());

  /** The person's conversation hands its goal over with `--return-route auto` from this machine, as the CLI and the MCP
   *  server do: with no identity of its own (`issued-actor`), or under a seat's identity (`issued`). Returns the address. */
  async function handOver(qitemId: string, sender?: string): Promise<string> {
    const app = new Hono();
    app.use("*", async (c, next) => { c.set("queueRepo" as never, repo as never); c.set("eventBus" as never, bus as never); await next(); });
    app.route("/api/queue", queueRoutes());
    const res = await app.request("/api/queue/create", {
      method: "POST",
      headers: { "content-type": "application/json", ...(sender ? { "x-openrig-session": sender } : {}) },
      body: JSON.stringify({ qitemId, destinationSession: "operator-agent@kernel", body: "Goal: add word counts", summary: "the goal",
        nudge: false, returnRoute: "auto", tags: [conversationKeyTag("claude:1a2b3c4d.5000:4242")] }),
    }, LOCAL);
    expect(res.status).toBe(201);
    const row = await res.json() as { returnRoute: string; returnRouteBasis: string };
    expect(row).toMatchObject({ returnRoute: issuedReturnAddress(qitemId), returnRouteBasis: sender ? "issued" : "issued-actor" });
    return row.returnRoute;
  }

  /** A seat's question for that address, created and woken as a seat's `rig queue create` is. */
  async function ask(destination: string, ageMinutes = 0): Promise<QueueItem> {
    const row = await repo.create({ sourceSession: SEAT, destinationSession: destination, body: "Which author should the commit use?",
      summary: "the commit's author" });
    if (ageMinutes) age(row.qitemId, ageMinutes);
    return repo.getById(row.qitemId)!;
  }
  function age(qitemId: string, minutes: number): void {
    const at = new Date(Date.now() - minutes * 60_000).toISOString();
    db.prepare("UPDATE queue_items SET ts_created = ?, ts_updated = ?, claimed_at = CASE WHEN claimed_at IS NULL THEN NULL ELSE ? END WHERE qitem_id = ?")
      .run(at, at, at, qitemId);
    db.prepare("UPDATE queue_transitions SET ts = ? WHERE qitem_id = ?").run(at, qitemId);
  }
  const sweep = () => runStuckSweep({ db, queueRepo: repo, status: createStuckSweepStatus(), unclaimedAgeMinutes: 60, log: () => {},
    isRegisteredHost: () => false, resolveRecoveryAgentSeat: () => null, resolveOperatorSeat: () => null });
  const findings = (): QueueItem[] => repo.list({ limit: 500 }).filter((r) => (r.tags ?? []).includes(STUCK_SWEEP_FINDING_TAG));
  /** Each finding as its reader sees it: where it went, and its why. */
  const read = (rows: QueueItem[]) => rows.map((r) => ({ to: r.destinationSession, why: r.body.split("\n").find((l) => l.startsWith("why:")) ?? r.body }));

  it.each([
    ["no identity of its own (issued-actor)", undefined],
    ["a seat's identity (issued)", "lead@kernel"],
  ] as const)("a seat's task at the address issued to a conversation with %s waits for it to read it: no finding, nothing typed", async (_label, sender) => {
    const address = await handOver("qitem-goal-1", sender);
    const task = await ask(address);
    await sweep();
    expect(read(findings())).toEqual([]);
    expect(typed).toEqual([]);
    // The wake record says what OpenRig knows: no wake was sent, and the work waits for the conversation's own read.
    expect(task.lastNudgeResult).toMatch(new RegExp(`^awaiting-pickup: '${address}' is an address OpenRig issued to a person's own conversation`));
    expect(task.lastNudgeResult).not.toMatch(/register the human|Fix the address|delivered|woken/);
  });

  it("an address OpenRig didn't issue here, of the same shape, is reported as before", async () => {
    await handOver("qitem-goal-1");
    const stray = issuedReturnAddress("qitem-goal-on-no-row-here");
    const task = await ask(stray);
    expect(task.lastNudgeResult).toMatch(new RegExp(`^unroutable: '${stray}' has no terminal transport on this daemon and names no registered human`));
    await sweep();
    expect(read(findings())).toEqual([{ to: SEAT, why: expect.stringContaining(`why: wake failed (unroutable: '${stray}' has no terminal transport`) }]);
    expect(findings()[0]!.body).toContain("Fix the address, or register the human");
  });

  it("an address recorded only as a route the caller named, or carried from another host, isn't one OpenRig issued here", async () => {
    const named = issuedReturnAddress("qitem-named");
    const carried = issuedReturnAddress("qitem-carried");
    await repo.create({ sourceSession: "lead@kernel", destinationSession: "operator-agent@kernel", body: "goal", nudge: false,
      returnRoute: named, returnRouteBasis: "named" });
    await repo.create({ sourceSession: "lead@kernel", destinationSession: "operator-agent@kernel", body: "goal", nudge: false,
      returnRoute: `${carried}@host-b`, returnRouteBasis: "issued" });
    for (const address of [named, carried]) expect((await ask(address)).lastNudgeResult).toMatch(/^unroutable: /);
    await sweep();
    const whys = read(findings()).map((f) => f.why);
    expect(whys).toHaveLength(2);
    expect(whys).toEqual(expect.arrayContaining([named, carried].map((address) => expect.stringContaining(`wake failed (unroutable: '${address}'`))));
  });

  it("work it leaves unclaimed past the unclaimed age is still reported, in one notice to the seat that sent it, saying only what OpenRig knows", async () => {
    const address = await handOver("qitem-goal-1");
    const rows = [await ask(address, 61), await ask(address, 90)];
    const young = await ask(address);
    await sweep();
    const [notice, ...more] = findings();
    expect(more).toEqual([]);
    expect(notice).toMatchObject({ destinationSession: SEAT, sourceSession: address });
    expect(notice!.tags).toContain(unclaimedBacklogTag(address));
    expect(notice!.body).toContain(`conversation: ${address} (an address OpenRig issued to a person's own conversation, not a seat`);
    expect(notice!.body).toContain("why: nobody has claimed these rows, and OpenRig can't tell whether the conversation has read them");
    for (const row of rows) expect(notice!.body).toContain(`- ${row.qitemId}, unclaimed since ${row.tsCreated}, from ${SEAT}: the commit's author`);
    expect(notice!.body).not.toContain(young.qitemId);
    expect(notice!.body).not.toMatch(/hosted member|check-ins|Fix the address|register the human|unreachable|delivered/i);

    // The conversation claims its work as its address, and the notice closes itself.
    for (const row of rows) repo.claim({ qitemId: row.qitemId, destinationSession: address });
    await sweep();
    expect(repo.getById(notice!.qitemId)!.state).toBe("done");
  });

  it("a task the conversation claimed and hasn't moved goes to the seat that sent it, without telling it to fix the address", async () => {
    const address = await handOver("qitem-goal-1");
    const task = await ask(address);
    repo.claim({ qitemId: task.qitemId, destinationSession: address });
    age(task.qitemId, 20);
    await sweep();
    const [finding, ...more] = findings();
    expect(more).toEqual([]);
    expect(finding).toMatchObject({ destinationSession: SEAT });
    expect(finding!.body).toContain("STUCK SWEEP FINDING (stalled-after-claim)");
    expect(finding!.body).toContain(`; ${address} is an address OpenRig issued to a person's own conversation`);
    expect(finding!.body).not.toMatch(/fix the address|hosted member/i);
  });
});
