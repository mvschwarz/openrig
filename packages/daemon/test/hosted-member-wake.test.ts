// A hosted member (an outside tool on the team) whose roster entry declares a webhook is rung when work lands for it:
// a pointer to the row (never its body), the Authorization header from a secret, a timeout, and no redirect followed.
// A 2xx is "wake accepted", never delivered: pickup is the member's claim. Real SQLite, the real queue, a real local
// HTTP receiver. Native: no real tool was rung.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { hostedWakeFor, isHostedMemberAt, parseRoster, type RosterWake } from "../src/domain/rosters.js";
import { ringHostedWake } from "../src/domain/hosted-wake.js";
import { OutboxHandler, WAKE_INTENT_PREFIX } from "../src/domain/outbox-handler.js";
import { createStuckSweepStatus, runStuckSweep, STUCK_SWEEP_FINDING_TAG } from "../src/domain/queue-stuck-sweep.js";

type Received = { path: string; headers: IncomingMessage["headers"]; body: Record<string, unknown>; status: number };
type Reply = { status: number; headers?: Record<string, string> } | "hang";

describe("a hosted member with a webhook trigger is rung when work lands for it", () => {
  let server: Server;
  let url: string;
  let received: Received[];
  let reply: Reply;
  let dir: string;

  beforeEach(async () => {
    received = [];
    reply = { status: 202 };
    dir = mkdtempSync(join(tmpdir(), "hosted-wake-"));
    server = createServer((req, res) => {
      let data = "";
      req.on("data", (chunk) => { data += chunk; });
      req.on("end", () => {
        received.push({ path: req.url ?? "", headers: req.headers, body: data ? JSON.parse(data) as Record<string, unknown> : {}, status: reply === "hang" ? 0 : reply.status });
        if (reply === "hang") return;
        res.writeHead(reply.status, reply.headers);
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}/hook`;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });

  const wake: RosterWake = { webhook: { url_ref: "GROK_WAKE_URL", authorization_ref: "GROK_WAKE_AUTH" } };
  const env = () => ({ GROK_WAKE_URL: url, GROK_WAKE_AUTH: "Bearer test-only-value" });
  const ring = { qitemId: "qitem-1", destination: "grok@lab", summary: "Find the release notes", source: "lead@lab" };

  it("rings with a pointer to the row and the Authorization header, and records wake accepted, not delivered", async () => {
    const outcome = await ringHostedWake(ring, wake, { env: env() });
    expect(outcome).toEqual({ classified: "indeterminate", nudgeResult: "wake-accepted:webhook (GROK_WAKE_URL) answered 202; pickup is the member's claim on this row" });
    expect(received).toHaveLength(1);
    expect(received[0]!.headers.authorization).toBe("Bearer test-only-value");
    expect(received[0]!.body).toEqual({ source: "openrig.queue", schema_version: 1, event: "work-waiting",
      qitem_id: "qitem-1", destination: "grok@lab", summary: "Find the release notes", from: "lead@lab" });
    // The URL can itself be a credential: the recorded result names its secret, never the URL.
    expect(outcome.nudgeResult).not.toContain(url);
  });

  it("records a failed ring for an error, a redirect it doesn't follow, a missing secret and a trigger that doesn't answer", async () => {
    reply = { status: 500 };
    expect(await ringHostedWake(ring, wake, { env: env() })).toEqual({ classified: "failed", nudgeResult: "failed:webhook (GROK_WAKE_URL) answered 500" });

    reply = { status: 302, headers: { location: "/elsewhere" } };
    expect((await ringHostedWake(ring, wake, { env: env() })).nudgeResult).toBe("failed:webhook (GROK_WAKE_URL) answered 302, a redirect, which isn't followed");
    expect(received.map((r) => r.path)).toEqual(["/hook", "/hook"]);

    expect((await ringHostedWake(ring, wake, { env: {} })).nudgeResult).toBe("failed:webhook (GROK_WAKE_URL) isn't set: no webhook URL to ring");
    expect((await ringHostedWake(ring, wake, { env: { GROK_WAKE_URL: url } })).nudgeResult)
      .toBe("failed:webhook (GROK_WAKE_URL) not rung: its Authorization value (GROK_WAKE_AUTH) isn't set");
    expect(received).toHaveLength(2);

    reply = "hang";
    expect((await ringHostedWake(ring, wake, { env: env(), timeoutMs: 100 })).nudgeResult).toBe("failed:webhook (GROK_WAKE_URL) didn't answer within 100 ms");
  });

  it("through the queue: work for the member rings its trigger from the roster's secrets file, never its terminal, and a claim stays a separate fact", async () => {
    const db = new Database(":memory:");
    migrate(db, ALL_MIGRATIONS);
    // Real topology, so an address with no binding classifies as it does on a running daemon.
    db.prepare("INSERT INTO rigs (id, name) VALUES ('rig-lab', 'lab')").run();
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id, runtime, cwd) VALUES ('node-lead', 'rig-lab', 'lead', 'claude-code', '/tmp')").run();
    const secrets = join(dir, "grok.env");
    writeFileSync(secrets, `GROK_WAKE_URL=${url}\nGROK_WAKE_AUTH=Bearer test-only-value\n`, { mode: 0o600 });
    const declared: RosterWake = { webhook: { ...wake.webhook, secrets_env_file: secrets } };
    let typed = 0;
    let trigger: RosterWake | null = declared;
    const repo = new QueueRepository(db, new EventBus(db), {
      validateRig: () => true,
      loadHumanRegistry: () => ({ ok: true, entities: [] }),
      transport: { send: async () => { typed += 1; return { ok: true, verified: true }; } },
      hostedWake: (destination) => destination === "grok@lab" ? trigger : null,
      isHostedMember: (destination) => destination === "grok@lab",
    });
    expect(repo.classifyDestinationOf("grok@lab")).toEqual({ class: "hosted", wake: declared });
    // The create's own wake rings it (this repository has no outbox, so the wake runs inline).
    const row = await repo.create({ sourceSession: "lead@lab", destinationSession: "grok@lab", body: "the full brief", summary: "Find the release notes" });
    expect(typed).toBe(0);
    expect(received).toHaveLength(1);
    expect(received[0]!.body).toMatchObject({ qitem_id: row.qitemId, destination: "grok@lab", summary: "Find the release notes", from: "lead@lab" });
    expect(JSON.stringify(received[0]!.body)).not.toContain("the full brief");
    expect(repo.getById(row.qitemId)!.lastNudgeResult).toMatch(/^wake-accepted:webhook \(GROK_WAKE_URL\) answered 202/);
    repo.claim({ qitemId: row.qitemId, destinationSession: "grok@lab" });
    expect(repo.getById(row.qitemId)).toMatchObject({ state: "in-progress", lastNudgeResult: expect.stringMatching(/^wake-accepted:/) });

    // A hosted member with no trigger stays unroutable, so its person is told (step 1, unchanged). The member reads this
    // teaching too: it says how the member gets work, not to fix the address or register a person.
    trigger = null;
    const noTrigger = repo.classifyDestinationOf("grok@lab");
    expect(noTrigger).toEqual({ class: "unroutable", teaching: "unroutable: 'grok@lab' is a hosted member with no wake trigger, "
      + "so nothing can push work to it. It reads the queue when its owner next starts a session." });
    // An address no roster lists keeps the general teaching.
    expect(repo.classifyDestinationOf("nobody@lab")).toMatchObject({ class: "unroutable",
      teaching: expect.stringContaining("Fix the address, or register the human with `rig gateway human add`.") });
    db.close();
  });

  // Real topology and a repository whose trigger comes from a secrets file, as on a running daemon.
  // A repository over the same database stands in for the daemon after a restart; `transport: false` for one that
  // stops before sending.
  function hostedRepo(db: Database.Database, envLines: string, declared: RosterWake["webhook"] = wake.webhook, opts: { transport?: boolean } = {}) {
    db.prepare("INSERT OR IGNORE INTO rigs (id, name) VALUES ('rig-lab', 'lab')").run();
    db.prepare("INSERT OR IGNORE INTO nodes (id, rig_id, logical_id, runtime, cwd) VALUES ('node-lead', 'rig-lab', 'lead', 'claude-code', '/tmp')").run();
    const secrets = join(dir, "grok.env");
    writeFileSync(secrets, envLines, { mode: 0o600 });
    return new QueueRepository(db, new EventBus(db), {
      validateRig: () => true,
      loadHumanRegistry: () => ({ ok: true, entities: [] }),
      ...(opts.transport === false ? {} : { transport: { send: async () => ({ ok: true, verified: true }) } }),
      hostedWake: (destination) => destination === "grok@lab" ? { webhook: { ...declared, secrets_env_file: secrets } } : null,
    });
  }

  it("never records a credential: one in the URL goes in the header, and a failed ring's text, the row and the person's finding carry neither it nor the Authorization value", async () => {
    // Credentials in the URL become Basic auth, and the request URL carries none.
    const withCredentials = url.replace("http://", "http://member:pa55word@");
    const accepted = await ringHostedWake(ring, { webhook: { url_ref: "GROK_WAKE_URL" } }, { env: { GROK_WAKE_URL: withCredentials } });
    expect(accepted.classified).toBe("indeterminate");
    expect(received[0]!.headers.authorization).toBe(`Basic ${Buffer.from("member:pa55word").toString("base64")}`);

    // A trigger that can't be reached, through the queue and the stuck sweep to the person.
    const unreachable = withCredentials.replace(/:\d+\//, ":9/");
    const db = new Database(":memory:");
    migrate(db, ALL_MIGRATIONS);
    const repo = hostedRepo(db, `GROK_WAKE_URL=${unreachable}\nGROK_WAKE_AUTH=Bearer secret-auth-value\n`);
    const row = await repo.create({ sourceSession: "lead@lab", destinationSession: "grok@lab", body: "work", summary: "Work" });
    const recorded = repo.getById(row.qitemId)!.lastNudgeWireResult ?? "";
    expect(recorded).toMatch(/^failed:webhook \(GROK_WAKE_URL\) couldn't be reached \(/);
    await runStuckSweep({ db, queueRepo: repo, status: createStuckSweepStatus(), resolveOrchestrator: () => null, unclaimedAgeMinutes: 60,
      log: () => {}, isRegisteredHost: () => false, resolveOperatorSeat: () => "person@external", resolveRecoveryAgentSeat: () => null });
    const finding = repo.list({ limit: 50 }).find((item) => (item.tags ?? []).includes(STUCK_SWEEP_FINDING_TAG))!;
    expect(finding.destinationSession).toBe("person@external");
    for (const text of [accepted.nudgeResult, recorded, finding.body, finding.summary ?? ""]) {
      for (const secret of ["pa55word", "member:", "secret-auth-value", unreachable, withCredentials]) expect(text).not.toContain(secret);
    }
    db.close();
  });

  it("a ring the trigger accepted isn't rung again by startup recovery; a failed one is", async () => {
    for (const first of [202, 500]) {
      received.length = 0;
      reply = { status: first };
      const db = new Database(":memory:");
      migrate(db, ALL_MIGRATIONS);
      const repo = hostedRepo(db, `GROK_WAKE_URL=${url}\nGROK_WAKE_AUTH=Bearer test-only-value\n`);
      repo.attachOutbox(new OutboxHandler(db));
      const row = await repo.create({ sourceSession: "lead@lab", destinationSession: "grok@lab", body: "work", summary: "Work" });
      await vi.waitFor(() => expect(received).toHaveLength(1));
      await vi.waitFor(() => expect(repo.getById(row.qitemId)!.lastNudgeWireResult).toMatch(first === 202 ? /^wake-accepted:/ : /^failed:webhook/));
      reply = { status: 202 };
      // The daemon's startup recovery pass over current wake intents.
      await repo.drainPendingWakeIntents();
      expect(received).toHaveLength(first === 202 ? 1 : 2);
      expect(repo.getById(row.qitemId)!.lastNudgeWireResult).toMatch(/^wake-accepted:webhook \(GROK_WAKE_URL\) answered 202/);
      db.close();
    }
  });

  it("a new wake for the same row rings: parked on a blocker that completes, the member is rung again, and recovery adds none", async () => {
    const db = new Database(":memory:");
    migrate(db, ALL_MIGRATIONS);
    const repo = hostedRepo(db, `GROK_WAKE_URL=${url}\nGROK_WAKE_AUTH=Bearer test-only-value\n`);
    repo.attachOutbox(new OutboxHandler(db));
    const row = await repo.create({ sourceSession: "lead@lab", destinationSession: "grok@lab", body: "work", summary: "Work" });
    await vi.waitFor(() => expect(received).toHaveLength(1));
    // The member claims it over MCP, then parks it on another row.
    repo.claim({ qitemId: row.qitemId, destinationSession: "grok@lab" });
    const blocker = await repo.create({ sourceSession: "grok@lab", destinationSession: "lead@lab", body: "needs a file", summary: "Needs a file" });
    await repo.update({ qitemId: row.qitemId, actorSession: "grok@lab", state: "blocked", blockedOn: blocker.qitemId, transitionNote: "waiting on the file" });
    // The blocker completes: the row is unparked, and its new wake rings the member.
    await repo.update({ qitemId: blocker.qitemId, actorSession: "lead@lab", state: "done", closureReason: "no-follow-on", transitionNote: "file attached" });
    await vi.waitFor(() => expect(received.filter((r) => r.body.qitem_id === row.qitemId)).toHaveLength(2));
    await repo.drainPendingWakeIntents();
    expect(received.filter((r) => r.body.qitem_id === row.qitemId)).toHaveLength(2);
    db.close();
  });

  it("a new wake claimed but never sent before a restart rings on recovery, though the row's last ring was accepted; recovery of that one adds none", async () => {
    const db = new Database(":memory:");
    migrate(db, ALL_MIGRATIONS);
    const env = `GROK_WAKE_URL=${url}\nGROK_WAKE_AUTH=Bearer test-only-value\n`;
    const live = hostedRepo(db, env);
    live.attachOutbox(new OutboxHandler(db));
    const row = await live.create({ sourceSession: "lead@lab", destinationSession: "grok@lab", body: "work", summary: "Work" });
    await vi.waitFor(() => expect(received).toHaveLength(1));
    live.claim({ qitemId: row.qitemId, destinationSession: "grok@lab" });
    const blocker = await live.create({ sourceSession: "grok@lab", destinationSession: "lead@lab", body: "needs a file", summary: "Needs a file" });
    await live.update({ qitemId: row.qitemId, actorSession: "grok@lab", state: "blocked", blockedOn: blocker.qitemId, transitionNote: "waiting on the file" });
    // The blocker completes, and the daemon claims the new wake but stops before sending it.
    const stopping = hostedRepo(db, env, wake.webhook, { transport: false });
    const outbox = new OutboxHandler(db);
    stopping.attachOutbox(outbox);
    await stopping.update({ qitemId: blocker.qitemId, actorSession: "lead@lab", state: "done", closureReason: "no-follow-on", transitionNote: "file attached" });
    const fresh = db.prepare("SELECT outbox_id FROM outbox_entries WHERE audit_pointer = ? AND delivery_state = 'pending'").all(row.qitemId) as Array<{ outbox_id: string }>;
    expect(fresh).toHaveLength(1);
    expect(outbox.claimForDelivery(fresh[0]!.outbox_id)).toBe(true);
    // After the restart, the abandoned wake reads indeterminate, as a sent one would, and the row's last result is still
    // the first ring's acceptance; it rings anyway, because this intent never rang.
    expect(outbox.reconcileAbandonedSending(WAKE_INTENT_PREFIX)).toBe(1);
    expect(stopping.getById(row.qitemId)!.lastNudgeWireResult).toMatch(/^wake-accepted:/);
    const restarted = hostedRepo(db, env);
    restarted.attachOutbox(new OutboxHandler(db));
    await restarted.drainPendingWakeIntents();
    expect(received.filter((r) => r.body.qitem_id === row.qitemId)).toHaveLength(2);
    // Recovery of that accepted unblock doesn't ring a third time.
    await restarted.drainPendingWakeIntents();
    expect(received.filter((r) => r.body.qitem_id === row.qitemId)).toHaveLength(2);
    db.close();
  });

  it("after one wake was accepted and a later one failed, recovery rings only the failed one", async () => {
    const db = new Database(":memory:");
    migrate(db, ALL_MIGRATIONS);
    const env = `GROK_WAKE_URL=${url}\nGROK_WAKE_AUTH=Bearer test-only-value\n`;
    const live = hostedRepo(db, env);
    live.attachOutbox(new OutboxHandler(db));
    const row = await live.create({ sourceSession: "lead@lab", destinationSession: "grok@lab", body: "work", summary: "Work" });
    await vi.waitFor(() => expect(received).toHaveLength(1));
    live.claim({ qitemId: row.qitemId, destinationSession: "grok@lab" });
    const blocker = await live.create({ sourceSession: "grok@lab", destinationSession: "lead@lab", body: "needs a file", summary: "Needs a file" });
    await live.update({ qitemId: row.qitemId, actorSession: "grok@lab", state: "blocked", blockedOn: blocker.qitemId, transitionNote: "waiting on the file" });
    reply = { status: 500 };
    await live.update({ qitemId: blocker.qitemId, actorSession: "lead@lab", state: "done", closureReason: "no-follow-on", transitionNote: "file attached" });
    await vi.waitFor(() => expect(live.getById(row.qitemId)!.lastNudgeWireResult).toMatch(/^failed:webhook/));
    reply = { status: 202 };
    const restarted = hostedRepo(db, env);
    restarted.attachOutbox(new OutboxHandler(db));
    await restarted.drainPendingWakeIntents();
    // The first ring (202), the failed one (500), and only that one again on recovery (202).
    expect(received.filter((r) => r.body.qitem_id === row.qitemId).map((r) => r.status)).toEqual([202, 500, 202]);
    db.close();
  });

  it("the boot sweep's re-nudge of a row whose first ring was accepted rings again: it's a new wake, not a recovery", async () => {
    const db = new Database(":memory:");
    migrate(db, ALL_MIGRATIONS);
    const repo = hostedRepo(db, `GROK_WAKE_URL=${url}\nGROK_WAKE_AUTH=Bearer test-only-value\n`);
    const row = await repo.create({ sourceSession: "lead@lab", destinationSession: "grok@lab", body: "work", summary: "Work" });
    expect(received).toHaveLength(1);
    expect(repo.getById(row.qitemId)!.lastNudgeWireResult).toMatch(/^wake-accepted:/);
    await repo.recoverLostNudge(row.qitemId, "grok@lab", "lead@lab");
    expect(received).toHaveLength(2);
    db.close();
  });

  it("reads the trigger from the authored roster for a hosted member on this host only", () => {
    const roster = {
      version: 1, id: "lab", name: "Lab", purpose: "trials", curator: { seat: "lead@lab", host: "h1" }, updated_at: "2026-10-26",
      members: [
        { seat: "grok@lab", host: "h1", capabilities: ["x search"], engagement: ["queue"], use_when: "live search", why: "fast", hosted: true, wake },
        { seat: "other@lab", host: "h1", capabilities: ["a"], engagement: ["queue"], use_when: "u", why: "w", wake },
      ],
    };
    writeFileSync(join(dir, "lab.json"), JSON.stringify(roster));
    expect(hostedWakeFor("grok@lab", dir, "h1")).toEqual(wake);
    expect(hostedWakeFor("grok@lab", dir, "h2")).toBeNull();
    expect(hostedWakeFor("grok@lab", dir, null)).toBeNull();
    expect(hostedWakeFor("other@lab", dir, "h1")).toBeNull(); // not hosted
    // Listed as hosted, trigger or not, on this host only.
    expect(isHostedMemberAt("grok@lab", dir, "h1")).toBe(true);
    writeFileSync(join(dir, "lab.json"), JSON.stringify({ ...roster, members: [{ ...roster.members[0], wake: undefined }, roster.members[1]] }));
    expect(hostedWakeFor("grok@lab", dir, "h1")).toBeNull();
    expect(isHostedMemberAt("grok@lab", dir, "h1")).toBe(true);
    expect(isHostedMemberAt("grok@lab", dir, "h2")).toBe(false);
    expect(isHostedMemberAt("grok@lab", dir, null)).toBe(false);
    expect(isHostedMemberAt("other@lab", dir, "h1")).toBe(false);
    expect(() => parseRoster({ ...roster, members: [{ ...roster.members[0], wake: { webhook: { url: "https://example.invalid" } } }] }))
      .toThrow("A member's wake needs webhook.url_ref");
  });
});
