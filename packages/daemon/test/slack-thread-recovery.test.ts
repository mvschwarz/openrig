// #739 — missed replies in tracked threads and missed messages in mapped channels, recovered
// through the real router and queue with a fake Slack history.
import { afterEach, expect, it, vi } from "vitest";
import { createFullTestDb } from "./helpers/test-app.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { makeQueuePorts } from "../src/domain/gateway/slack/queue-access.js";
import { InboundRouter, handleEnvelope, type InboundDeps, type SlackEvent } from "../src/domain/gateway/slack/inbound.js";
import { SlackRecovery, ownedRecoveryChannels } from "../src/domain/gateway/slack/slack-recovery.js";
import { ChannelCoverageStore, ThreadCoverageStore, SeenStore, DeadLetterStore, slackMicros, type StateFsOps } from "../src/domain/gateway/slack/state-store.js";
import type { FetchImpl } from "../src/domain/gateway/slack/slack-api.js";
import { ThreadSeatMap, formatPostedStamp } from "../src/domain/gateway/slack/thread-seat-map.js";
import { makeThreadRouteResolver } from "../src/domain/gateway/slack/thread-routing.js";

const closes: (() => void)[] = [];
afterEach(() => { for (const close of closes.splice(0)) close(); });

const BASE = 1_792_000_000;
const ts = (seconds: number) => `${BASE + seconds}.000001`;
const at = (seconds: number) => (BASE + seconds) * 1000;
const ROOT = ts(0);
const DAY = 24 * 60 * 60;

function fixture() {
  const files = new Map<string, string>();
  const fsops: StateFsOps = {
    readFileSync: p => { if (!files.has(p)) throw Object.assign(new Error("absent"), { code: "ENOENT" }); return files.get(p)!; },
    writeFileSync: (p, d) => { files.set(p, d); }, appendFileSync: (p, d) => { files.set(p, (files.get(p) ?? "") + d); },
    rename: (from, to) => { files.set(to, files.get(from)!); files.delete(from); }, mkdirp: () => {},
  };
  const db = createFullTestDb(); closes.push(() => db.close());
  let now = at(100);
  let queueDown = false;
  const repo = new QueueRepository(db, new EventBus(db), { validateRig: () => !queueDown });
  const seen = new SeenStore("/s/slack-inbound-seen.jsonl", fsops);
  const dead = new DeadLetterStore<SlackEvent>("/s/dead", fsops);
  const channelStore = new ChannelCoverageStore("/s/coverage", fsops);
  const threadStore = new ThreadCoverageStore("/s/thread-coverage", fsops);
  const map = new ThreadSeatMap(db, () => new Date(now));
  const route = makeThreadRouteResolver({ map, unroutedDestination: "owner@test",
    resolveChannelDestination: channel => (channel === "C2" ? "c2-seat@test" : null) });
  const routed: string[] = [];
  const resolveHumanReply = vi.fn(async () => "resolved" as const);
  const deps: InboundDeps = { queue: makeQueuePorts(repo), seen, deadLetter: dead, destination: "owner@test",
    resolveSender: user => user === "U1" ? { admitted: true, source: "human-fixture@external" } : { admitted: false, teaching: "register" },
    resolveRoute: ev => { routed.push(`${ev.channel}:${ev.ts}`); return route(ev); },
    resolveHumanReply };
  const router = new InboundRouter(deps);
  const history: Record<string, SlackEvent[]> = {};
  const replies: Record<string, SlackEvent[]> = {};
  const queries: URL[] = [];
  let respond: ((url: URL) => Response | undefined) | undefined;
  const fetchImpl: FetchImpl = async url => {
    const u = new URL(url);
    queries.push(u);
    const custom = respond?.(u);
    if (custom) return custom;
    const oldest = slackMicros(u.searchParams.get("oldest"))!, latest = slackMicros(u.searchParams.get("latest"))!;
    const limit = Number(u.searchParams.get("limit"));
    const inRange = (e: SlackEvent) => slackMicros(e.ts)! > oldest && slackMicros(e.ts)! < latest;
    const byTs = (a: SlackEvent, b: SlackEvent) => slackMicros(a.ts)! < slackMicros(b.ts)! ? -1 : 1;
    if (u.pathname.endsWith("conversations.replies")) {
      // Oldest first, with the root whenever it falls in the range, as Slack returns a thread.
      const root = u.searchParams.get("ts")!;
      const thread = [{ type: "message", user: "U1", text: "root", ts: root, thread_ts: root },
        ...(replies[`${u.searchParams.get("channel")}:${root}`] ?? [])].filter(inRange).sort(byTs);
      return Response.json({ ok: true, messages: thread.slice(0, limit), has_more: thread.length > limit });
    }
    const channel = (history[u.searchParams.get("channel")!] ?? []).filter(inRange).sort(byTs).reverse();
    return Response.json({ ok: true, messages: channel.slice(0, limit), has_more: channel.length > limit });
  };
  const recovery = (opts: { channels?: Array<{ channel: string; seed?: "adoption" }>; relayed?: boolean } = {}) => {
    const r = new SlackRecovery({ channels: opts.channels ?? [{ channel: "C1" }], token: "fixture-token", stateDir: "/s", router,
      trackedThreads: (channels, closedSince) => map.trackedForRecovery(channels, closedSince),
      fetchImpl, now: () => now, channelStore, threadStore, ...(opts.relayed ? { relayed: true } : {}) });
    r.initialize();
    closes.push(() => r.stop());
    return r;
  };
  const track = (root: string, seat = "asker@test", channel = "C1") =>
    map.open({ threadTs: root, channel, human: "human-fixture@external", seat, conversationId: `q-${seat}-${root}` });
  // An ask: its queue row in `state`, and the thread root it posted.
  const ask = (root: string, state: string, seat = "asker@test") => {
    const id = `q-${seat}-${root}`, stamp = new Date(now).toISOString();
    db.prepare(`INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, body)
      VALUES (?, ?, ?, ?, 'human-fixture@external', ?, 'ask')`).run(id, stamp, stamp, seat, state);
    track(root, seat);
    return { settle: () => db.prepare(`UPDATE queue_items SET state = 'done', ts_updated = ? WHERE qitem_id = ?`).run(new Date(now).toISOString(), id) };
  };
  const reply = (seconds: number, root = ROOT, extra: Partial<SlackEvent> = {}): SlackEvent =>
    ({ type: "message", user: "U1", channel: "C1", text: `reply ${seconds}`, ts: ts(seconds), thread_ts: root, ...extra });
  const message = (seconds: number, channel = "C1"): SlackEvent =>
    ({ type: "message", user: "U1", channel, text: `task ${seconds}`, ts: ts(seconds) });
  const calls = (method: string) => queries.filter(u => u.pathname.endsWith(method));
  const rows = () => repo.list({ limit: 500 });
  return { db, files, seen, dead, map, router, deps, routed, resolveHumanReply, history, replies, queries, recovery, track, ask, reply, message,
    calls, rows, time: (ms: number) => { now = ms; }, advance: (ms: number) => { now += ms; },
    respond: (fn?: typeof respond) => { respond = fn; }, down: (v: boolean) => { queueDown = v; } };
}

it.each(["open", "closed"])("a missed reply in a %s decision thread lands once as a late reply and never answers the decision", async state => {
  const f = fixture();
  f.map.open({ threadTs: ROOT, channel: "C1", human: "human-fixture@external", seat: "asker@test", conversationId: "q-decision" });
  if (state === "closed") f.map.close(ROOT, "C1");
  f.replies[`C1:${ROOT}`] = [f.reply(50, ROOT, { text: "Approved, go ahead" })];
  const r = f.recovery();

  await r.run();

  expect(f.rows()).toHaveLength(1);
  expect(f.rows()[0]).toMatchObject({ destinationSession: "asker@test", sourceSession: "human-fixture@external" });
  for (const text of ["Recovered after a gap", "Approved, go ahead", "In reply to: q-decision", "It was not applied as an answer to q-decision"]) {
    expect(f.rows()[0]!.body).toContain(text);
  }
  expect(f.resolveHumanReply).not.toHaveBeenCalled();
  // A live envelope can't claim the recovered mark: a live reply still answers.
  await handleEnvelope({ type: "events_api", payload: { event: f.reply(60, ROOT, { recoveredThreadReply: true, recoveredAfterGap: true }) } }, () => {}, f.router);
  expect(f.resolveHumanReply).toHaveBeenCalledTimes(1);
  await r.run();
  expect(f.rows()).toHaveLength(2);
});

it("a reply that landed live and again in the thread scan lands once; coverage is the scanned interval from the root", async () => {
  const f = fixture(); f.track(ROOT);
  const live = f.reply(30);
  await handleEnvelope({ type: "events_api", payload: { event: live } }, () => {}, f.router);
  f.replies[`C1:${ROOT}`] = [live, f.reply(40)];
  const r = f.recovery();

  await r.run();

  expect(f.rows()).toHaveLength(2);
  expect(f.routed).toEqual([`C1:${ts(30)}`, `C1:${ts(40)}`]);
  expect(JSON.parse(f.files.get("/s/thread-coverage")!)[`C1:${ROOT}`]).toMatchObject({ coverageStart: ROOT, coveredThrough: `${BASE + 95}.000000` });
  f.time(at(200)); await r.run();
  expect(f.rows()).toHaveLength(2);
});

it("tracks a thread whose root or close is within seven days, never by the map's rebuild clock", async () => {
  const f = fixture();
  // The fixture's clock reads at(100), so the seven-day boundary sits at 100 - 7 days.
  const offsets = { recentRoot: 100 - 7 * DAY + 60, staleRoot: 100 - 7 * DAY - 60, oldClosed: -30 * DAY, rebuilt: -20 * DAY, untracked: -DAY };
  const root = (key: keyof typeof offsets) => ts(offsets[key]);
  f.track(root("recentRoot"), "a@test");
  f.track(root("staleRoot"), "b@test");
  f.track(root("oldClosed"), "c@test"); f.time(at(100 - DAY)); f.map.close(root("oldClosed"), "C1"); f.time(at(100));
  // A rebuild restamps opened_at with the rebuild clock; the root's own Slack time still decides.
  f.map.rebuildFromStamps([formatPostedStamp({ threadTs: root("rebuilt"), messageTs: root("rebuilt"), channel: "C1",
    human: "human-fixture@external", seat: "d@test", conversationId: "q-rebuilt" })]);
  for (const offset of Object.values(offsets)) f.replies[`C1:${ts(offset)}`] = [f.reply(offset + 10, ts(offset))];
  const r = f.recovery();

  await r.run();

  expect(f.calls("conversations.replies").map(u => u.searchParams.get("ts"))).toEqual([root("recentRoot"), root("oldClosed")]);
  // The old root closed yesterday is scanned from its root: eligibility isn't a seven-day history cap.
  expect(f.rows().map(row => row.destinationSession).sort()).toEqual(["a@test", "c@test"]);
});

it("keeps recovery counts for the connector's lifetime after a thread leaves the window", async () => {
  const f = fixture(); const root = ts(-30 * DAY);
  f.track(root); f.time(at(100 - DAY)); f.map.close(root, "C1"); f.time(at(100));
  f.replies[`C1:${root}`] = [f.reply(-30 * DAY + 10, root)];
  const r = f.recovery();
  await r.run();
  expect(r.status().acceptedThisProcess).toBe(1);

  f.time(at(100 + 7 * DAY)); await r.run();

  expect(r.status().threads).toMatchObject({ tracked: 0 });
  expect(r.status().acceptedThisProcess).toBe(1);
});

it("a thread Slack can't find isn't asked again each pass or after a restart, only once a day", async () => {
  const f = fixture(); f.track(ROOT);
  f.respond(u => u.pathname.endsWith("conversations.replies") ? Response.json({ ok: false, error: "thread_not_found" }) : undefined);
  const r = f.recovery();
  await r.run();
  f.time(at(1000)); await r.run();
  r.stop();
  f.time(at(2000)); const restarted = f.recovery(); await restarted.run();

  expect(f.calls("conversations.replies")).toHaveLength(1);
  expect(restarted.status().threads).toMatchObject({ incomplete: { thread_not_found: 1 } });
  f.time(at(100 + DAY + 1)); await restarted.run();
  expect(f.calls("conversations.replies")).toHaveLength(2);
});

it("a rate limit on replies holds every thread back across a restart, while channel history still runs", async () => {
  const f = fixture(); f.track(ts(1), "a@test"); f.track(ts(2), "b@test");
  f.replies[`C1:${ts(1)}`] = [f.reply(11, ts(1))]; f.replies[`C1:${ts(2)}`] = [f.reply(12, ts(2))];
  f.respond(u => u.pathname.endsWith("conversations.replies") ? Response.json({ ok: false }, { status: 429, headers: { "retry-after": "600" } }) : undefined);
  const first = f.recovery();
  await first.run();
  expect(f.calls("conversations.replies")).toHaveLength(1);
  first.stop(); f.respond();

  const restarted = f.recovery(); f.history.C1 = [f.message(108)]; f.time(at(120));
  await restarted.run();
  expect(f.calls("conversations.replies")).toHaveLength(1); // neither thread asks before the workspace hold ends
  expect(f.calls("conversations.history")).toHaveLength(1); // the other method still runs

  f.time(at(701)); await restarted.run();
  expect(f.calls("conversations.replies")).toHaveLength(3);
  expect(f.rows().map(row => row.destinationSession).filter(d => d !== "owner@test").sort()).toEqual(["a@test", "b@test"]);
});

it.each([
  ["an older daemon's unmarked deadline holds history for every channel until it passes", {}, 0],
  ["a deadline marked as not a rate limit holds only its own channel", { rateLimited: false }, 1],
])("%s", async (_name, marker, otherChannelCalls) => {
  const f = fixture();
  // Checkpoints as an older daemon saved them: a 429 on the default channel kept only its nextRetryAt.
  const covered = { coverageStart: `${BASE}.000000`, coveredThrough: `${BASE}.000000`, seedBasis: "feature-adoption" };
  f.files.set("/s/coverage", JSON.stringify({ C1: { ...covered, nextRetryAt: at(700), ...marker }, C2: covered }) + "\n");
  f.track(ts(1));
  const r = f.recovery({ channels: [{ channel: "C1" }, { channel: "C2", seed: "adoption" }] });

  await r.run();
  expect(f.calls("conversations.history").map(u => u.searchParams.get("channel"))).toEqual(otherChannelCalls ? ["C2"] : []);
  expect(f.calls("conversations.replies")).toHaveLength(1); // a history hold never holds thread replies

  f.time(at(699)); await r.run();
  expect(f.calls("conversations.history")).toHaveLength(otherChannelCalls ? 2 : 0);
  // The saved deadline is honoured as it is: never refreshed or extended by a pass or a restart.
  expect(JSON.parse(f.files.get("/s/coverage")!).C1.nextRetryAt).toBe(at(700));
  f.time(at(701)); await r.run();
  expect(f.calls("conversations.history").map(u => u.searchParams.get("channel"))).toContain("C1");
});

it.each(["channel", "thread"])("a known non-429 error on one %s is saved as not a rate limit, and after a restart doesn't hold its peers", async kind => {
  const f = fixture();
  const covered = { coverageStart: `${BASE}.000000`, coveredThrough: `${BASE}.000000`, seedBasis: "feature-adoption" };
  const channels = kind === "channel" ? [{ channel: "C1" }, { channel: "C2", seed: "adoption" as const }] : [{ channel: "C1" }];
  if (kind === "channel") f.files.set("/s/coverage", JSON.stringify({ C1: covered, C2: covered }) + "\n");
  else { f.track(ts(1), "a@test"); f.track(ts(2), "b@test"); }
  const failing = (u: URL) => kind === "channel" ? u.searchParams.get("channel") === "C1" && u.pathname.endsWith("conversations.history")
    : u.searchParams.get("ts") === ts(1);
  f.respond(u => failing(u) ? Response.json({ ok: false, error: "missing_scope" }) : undefined);
  const first = f.recovery({ channels });
  await first.run();
  first.stop(); f.respond();
  const file = kind === "channel" ? "/s/coverage" : "/s/thread-coverage", key = kind === "channel" ? "C1" : `C1:${ts(1)}`;
  expect(JSON.parse(f.files.get(file)!)[key]).toMatchObject({ rateLimited: false, nextRetryAt: at(400) });
  const peerCalls = () => f.queries.filter(u => !failing(u) && u.pathname.endsWith(kind === "channel" ? "conversations.history" : "conversations.replies")).length;
  const before = peerCalls();

  f.time(at(200)); await f.recovery({ channels }).run();

  expect(peerCalls()).toBeGreaterThan(before); // the peer scans again before the failed source's deadline
  expect(f.queries.filter(failing)).toHaveLength(1); // the failed source waits for its own deadline
});

it("recovers a thread longer than a page in order across calls and passes, without a skip", async () => {
  const f = fixture(); f.track(ROOT);
  f.replies[`C1:${ROOT}`] = Array.from({ length: 70 }, (_, i) => f.reply(i + 1));
  const r = f.recovery();

  await r.run();
  expect(f.rows()).toHaveLength(59); // four calls of 15, the first carrying the root
  await r.run();

  expect(f.rows()).toHaveLength(70);
  expect(f.routed).toEqual(Array.from({ length: 70 }, (_, i) => `C1:${ts(i + 1)}`));
  expect(f.calls("conversations.replies").map(u => u.searchParams.get("limit"))).toEqual(["15", "15", "15", "15", "15"]);
  expect(JSON.parse(f.files.get("/s/thread-coverage")!)[`C1:${ROOT}`]).toMatchObject({ coveredThrough: `${BASE + 95}.000000` });
});

it("resumes after a restart mid-page from the last durable page, without a duplicate or a gap", async () => {
  const f = fixture(); f.track(ROOT);
  f.replies[`C1:${ROOT}`] = Array.from({ length: 30 }, (_, i) => f.reply(i + 1));
  const route = f.deps.resolveRoute!;
  // Each landing takes six seconds, so the pass's 15 seconds run out inside the first page.
  f.deps.resolveRoute = ev => { f.advance(6000); return route(ev); };
  const first = f.recovery();
  await first.run();
  expect(f.rows()).toHaveLength(3);
  expect(first.status().threads).toMatchObject({ incomplete: { "pass-budget": 1 } });
  first.stop();

  f.deps.resolveRoute = route;
  const restarted = f.recovery();
  await restarted.run(); await restarted.run();

  expect(f.rows()).toHaveLength(30);
  expect(f.routed).toEqual(Array.from({ length: 30 }, (_, i) => `C1:${ts(i + 1)}`));
  expect(f.dead.readAll()).toHaveLength(0);
});

it("a rate limit on thread replies holds back only replies; channel history still recovers", async () => {
  const f = fixture(); f.track(ts(1), "a@test"); f.track(ts(2), "b@test");
  f.replies[`C1:${ts(1)}`] = [f.reply(11, ts(1))];
  f.respond(u => u.pathname.endsWith("conversations.replies") ? Response.json({ ok: false }, { status: 429, headers: { "retry-after": "600" } }) : undefined);
  const r = f.recovery();
  f.history.C1 = [f.message(108)]; f.time(at(120));

  await r.run();

  expect(f.rows()).toHaveLength(1);
  expect(f.calls("conversations.replies")).toHaveLength(1); // the second thread waits on the method, unasked
  expect(r.status()).toMatchObject({ state: "scanned", threads: { backoff: { "rate-limited": 2 } } });
  f.history.C1.push(f.message(128)); f.time(at(140));
  await r.run();
  expect(f.rows()).toHaveLength(2);
  expect(f.calls("conversations.replies")).toHaveLength(1);
  expect(f.calls("conversations.history")).toHaveLength(2);
});

it.each(["missing_scope", "not_in_channel", "thread_not_found"])("%s leaves the thread waiting with its reason while live inbound lands", async error => {
  const f = fixture(); f.track(ROOT);
  f.replies[`C1:${ROOT}`] = [f.reply(10)];
  f.respond(u => u.pathname.endsWith("conversations.replies") ? Response.json({ ok: false, error }) : undefined);
  const r = f.recovery();

  await r.run();

  expect(f.rows()).toHaveLength(0);
  // A transient or permission error backs off and retries; a missing thread stays incomplete without spending calls.
  expect(r.status().threads).toMatchObject(error === "thread_not_found" ? { incomplete: { [error]: 1 } } : { backoff: { [error]: 1 } });
  await handleEnvelope({ type: "events_api", payload: { event: f.message(99) } }, () => {}, f.router);
  expect(f.rows()).toHaveLength(1);
});

it("channels and threads take turns under one budget: every thread is reached and the channel is visited every pass", async () => {
  const f = fixture();
  for (let i = 1; i <= 10; i++) { f.ask(ts(i), "pending", `s${i}@test`); f.replies[`C1:${ts(i)}`] = [f.reply(i + 20, ts(i))]; }
  f.history.C1 = [];
  const r = f.recovery();
  for (let pass = 1; pass <= 4; pass++) {
    f.history.C1.push(f.message(100 + pass * 10 - 2)); f.time(at(105 + pass * 10));
    const before = f.calls("conversations.replies").length;
    await r.run();
    expect(f.calls("conversations.history")).toHaveLength(pass);
    // Three thread calls a pass until each thread has had its scan since boot: the last pass has one left.
    expect(f.calls("conversations.replies").length - before).toBe(pass < 4 ? 3 : 1);
    if (pass === 1) expect(r.status().threads).toMatchObject({ tracked: 10, scanned: 3, pending: 7 });
    if (pass === 1) expect(r.status().threads.oldestPendingSeconds).toBeGreaterThan(100);
  }
  for (let i = 1; i <= 10; i++) expect(f.rows().some(row => row.destinationSession === `s${i}@test`)).toBe(true);
  expect(f.rows().filter(row => row.destinationSession === "owner@test")).toHaveLength(4);
});

it("a channel backlog and waiting threads alternate call by call, so each kind keeps half a pass", async () => {
  const f = fixture();
  for (let i = 1; i <= 5; i++) { f.track(ts(i), `s${i}@test`); f.replies[`C1:${ts(i)}`] = [f.reply(i + 20, ts(i))]; }
  f.history.C1 = Array.from({ length: 60 }, (_, i) => f.message(101 + i));
  const r = f.recovery(); f.time(at(170));

  await r.run();

  expect(f.calls("conversations.history")).toHaveLength(2);
  expect(f.calls("conversations.replies")).toHaveLength(2);
  expect(r.status()).toMatchObject({ state: "incomplete", reason: "pass-budget" }); // the channel has more, next pass
});

it("a newly mapped channel starts at adoption, not at a landing, and recovers into its inbound seat", async () => {
  const f = fixture();
  f.seen.mark(`C2:${ts(90)}`, "landed");
  const r = f.recovery({ channels: [{ channel: "C1" }, { channel: "C2", seed: "adoption" }] });
  expect(r.status().channels[0]).toMatchObject({ channel: "C2", coverage: { coverageStart: `${BASE + 100}.000000`, seedBasis: "feature-adoption" } });
  f.history.C2 = [f.message(95, "C2"), f.message(112, "C2")]; f.time(at(120));

  await r.run();

  expect(f.rows()).toHaveLength(1); // the post before adoption is older history, unknown
  expect(f.rows()[0]).toMatchObject({ destinationSession: "c2-seat@test" });
  expect(r.status().channels[0]).toMatchObject({ channel: "C2", state: "scanned" });
});

it("recovers the machine's own channels, never one it relays to another machine", () => {
  expect(ownedRecoveryChannels({ channel: "C1", channelMap: [{ channel: "C2" }, { channel: "C3" }, { channel: "C2" }],
    forwardChannels: [{ channel: "C3", host: "vps" }] })).toEqual(["C1", "C2"]);
  expect(ownedRecoveryChannels({ channel: null, channelMap: [{ channel: "C2" }], forwardChannels: "not a list" })).toEqual(["C2"]);
});

it.each([
  { label: "the socket default channel keeps main's answer", channels: [{ channel: "C1" }], channel: "C1", answers: true },
  { label: "a newly mapped channel's lands late and never answers", channels: [{ channel: "C1" }, { channel: "C2", seed: "adoption" as const }], channel: "C2", answers: false },
  { label: "a relay receiver's default lands late and never answers", channels: [{ channel: "C1", seed: "adoption" as const }], channel: "C1", answers: false },
])("recovered broadcast reply: $label", async ({ channels, channel, answers }) => {
  const f = fixture(); const root = ts(10);
  f.map.open({ threadTs: root, channel, human: "human-fixture@external", seat: "asker@test", conversationId: "q-decision" });
  f.history[channel] = [f.reply(110, root, { channel, subtype: "thread_broadcast", text: "Approved" })];
  const r = f.recovery({ channels }); f.time(at(120));

  await r.run();

  expect(f.rows()).toHaveLength(1);
  expect(f.rows()[0]!.body).toContain("In reply to: q-decision");
  expect(f.resolveHumanReply).toHaveBeenCalledTimes(answers ? 1 : 0);
  if (!answers) expect(f.rows()[0]!.body).toContain("It was not applied as an answer to q-decision");
});

it("live broadcast and thread replies still answer in a newly covered channel", async () => {
  const f = fixture(); const root = ts(10);
  f.map.open({ threadTs: root, channel: "C2", human: "human-fixture@external", seat: "asker@test", conversationId: "q-decision" });
  f.recovery({ channels: [{ channel: "C1" }, { channel: "C2", seed: "adoption" }] });

  await handleEnvelope({ type: "events_api", payload: { event: f.reply(110, root, { channel: "C2", subtype: "thread_broadcast" }) } }, () => {}, f.router);
  await handleEnvelope({ type: "events_api", payload: { event: f.reply(111, root, { channel: "C2" }) } }, () => {}, f.router);

  expect(f.resolveHumanReply).toHaveBeenCalledTimes(2);
});

it.each(["thread reply", "broadcast reply in a newly covered channel"])("a recovered %s that was dead-lettered still never answers after retry", async kind => {
  const f = fixture(); const root = ts(10);
  f.map.open({ threadTs: root, channel: "C1", human: "human-fixture@external", seat: "asker@test", conversationId: "q-decision" });
  if (kind === "thread reply") f.replies[`C1:${root}`] = [f.reply(50, root)];
  else f.history.C1 = [f.reply(110, root, { subtype: "thread_broadcast" })];
  const r = f.recovery({ channels: [{ channel: "C1", seed: "adoption" }] }); f.time(at(120));
  f.down(true);
  await r.run();
  expect(f.dead.readAll()).toHaveLength(1);

  f.down(false); await f.router.retryDeadLetters();

  expect(f.rows()).toHaveLength(1);
  expect(f.resolveHumanReply).not.toHaveBeenCalled();
  expect(f.rows()[0]!.body).toContain("It was not applied as an answer to q-decision");
});

it("a missed reply on an open ask is recovered in the first pass after boot, ahead of 100 older threads, and again after a restart", async () => {
  const f = fixture();
  // A week of settled asks, newer and older than the open one, none scanned since they closed.
  for (let i = 0; i < 100; i++) {
    const root = ts(-6 * DAY + i * 3000);
    f.ask(root, "done", `old${i}@test`); f.replies[`C1:${root}`] = [f.reply(-6 * DAY + i * 3000 + 10, root)];
  }
  const open = ts(-3 * DAY - 1);
  f.ask(open, "pending", "asker@test");
  f.replies[`C1:${open}`] = [f.reply(50, open, { text: "Yes, ship it" })];
  const first = f.recovery();

  await first.run();

  expect(f.calls("conversations.replies")[0]!.searchParams.get("ts")).toBe(open);
  expect(f.rows().filter(row => row.destinationSession === "asker@test")).toHaveLength(1);
  // The rest follow newest first.
  expect(f.calls("conversations.replies").slice(1).map(u => u.searchParams.get("ts")))
    .toEqual([ts(-6 * DAY + 99 * 3000), ts(-6 * DAY + 98 * 3000), ts(-6 * DAY + 97 * 3000)]);
  f.time(at(400)); await first.run();
  first.stop();

  // Down for an hour; the person replies again meanwhile.
  f.replies[`C1:${open}`].push(f.reply(1000, open, { text: "And the docs too" }));
  f.time(at(3700));
  const restarted = f.recovery();
  await restarted.run();

  const asker = f.rows().filter(row => row.destinationSession === "asker@test");
  expect(asker).toHaveLength(2);
  expect(asker.map(row => row.body).join("\n")).toContain("And the docs too");
  expect(f.calls("conversations.replies").at(-3)!.searchParams.get("ts")).toBe(open);
  expect(f.resolveHumanReply).not.toHaveBeenCalled();
});

it("asks still waiting on the person go first, newest first, then the rest; nothing is scanned again while connected", async () => {
  const f = fixture();
  for (let i = 1; i <= 5; i++) f.ask(ts(i), "pending", `open${i}@test`);
  f.ask(ts(10), "done", "settled@test");
  const r = f.recovery();
  f.advance(5000); // past the settle margin, so a scan covers through boot (the boundary has its own test)
  const order = async () => { const before = f.calls("conversations.replies").length; await r.run(); f.advance(10_000);
    return f.calls("conversations.replies").slice(before).map(u => u.searchParams.get("ts")); };

  // (The first pass has four thread calls: the channel has no gap yet.)
  expect(await order()).toEqual([ts(5), ts(4), ts(3), ts(2)]);
  expect(await order()).toEqual([ts(1), ts(10)]);
  // Replies while connected arrive live, so a thread scanned since boot isn't asked again every pass.
  expect(await order()).toEqual([]);
});

it("a waiting ask scanned since boot is scanned again within the hour, a settled thread within the day", async () => {
  const f = fixture();
  f.ask(ts(1), "pending", "open@test");
  f.ask(ts(2), "done", "settled@test");
  const r = f.recovery();
  f.advance(5000); // past the settle margin, so a scan covers through boot (the boundary has its own test)
  await r.run();
  const scanned = () => f.calls("conversations.replies").map(u => u.searchParams.get("ts"));
  expect(scanned()).toEqual([ts(1), ts(2)]);

  f.time(at(100 + 59 * 60)); await r.run();
  expect(scanned()).toHaveLength(2);
  f.time(at(100 + 61 * 60)); await r.run();
  expect(scanned()).toEqual([ts(1), ts(2), ts(1)]);
  f.time(at(100 + DAY + 60)); await r.run();
  expect(scanned().slice(3).sort()).toEqual([ts(1), ts(2)]);
});

it("a settled thread is due again after the socket reconnects from a gap, not a day later", async () => {
  const f = fixture();
  f.ask(ts(1), "done", "settled@test");
  const r = f.recovery();
  f.advance(5000); // past the settle margin, so a scan covers through boot (the boundary has its own test)
  await r.run();
  f.time(at(400)); await r.run();
  expect(f.calls("conversations.replies")).toHaveLength(1);

  // The socket drops for longer than Slack retries; a reply lands in the settled thread meanwhile.
  f.replies[`C1:${ts(1)}`] = [f.reply(500, ts(1), { text: "one more thing" })];
  f.time(at(1200)); r.connected();
  f.advance(5000); await r.run();

  expect(f.calls("conversations.replies")).toHaveLength(2);
  expect(f.rows().filter(row => row.destinationSession === "settled@test")).toHaveLength(1);
  f.time(at(1500)); await r.run();
  expect(f.calls("conversations.replies")).toHaveLength(2);
});

it("a settled thread is scanned once after each boot and then daily, not every pass, and a reply after close still lands", async () => {
  const f = fixture();
  const done = f.ask(ts(1), "pending", "settled@test");
  f.ask(ts(2), "pending", "open@test");
  const r = f.recovery();
  f.advance(5000); // past the settle margin, so a scan covers through boot (the boundary has its own test)
  await r.run();
  done.settle();
  const settledCalls = () => f.calls("conversations.replies").filter(u => u.searchParams.get("ts") === ts(1)).length;
  expect(settledCalls()).toBe(1);

  f.time(at(400)); await r.run();
  f.time(at(700)); await r.run();
  expect(settledCalls()).toBe(1); // caught up while this process listened live: nothing to recover
  expect(r.status().threads).toMatchObject({ tracked: 2, settled: 1, settledRescanHours: 24 });
  r.stop();

  // Off for a while; a reply arrives in the settled thread meanwhile.
  f.replies[`C1:${ts(1)}`] = [f.reply(800, ts(1), { text: "one more thing" })];
  f.time(at(1000));
  const restarted = f.recovery();
  f.advance(5000); await restarted.run();
  expect(settledCalls()).toBe(2);
  expect(f.rows().filter(row => row.destinationSession === "settled@test")).toHaveLength(1);

  f.time(at(1300)); await restarted.run();
  expect(settledCalls()).toBe(2);
  f.time(at(1000 + DAY + 10)); await restarted.run();
  expect(settledCalls()).toBe(3);
});

it("a thread about to leave the seven-day window is scanned first after boot, so its missed reply isn't lost", async () => {
  const f = fixture();
  for (let i = 1; i <= 5; i++) f.ask(ts(i), "pending", `open${i}@test`);
  // Posted seven days ago less an hour: it leaves the window within the hour.
  const expiring = ts(100 - 7 * DAY + 3600);
  f.ask(expiring, "done", "old@test");
  f.replies[`C1:${expiring}`] = [f.reply(50, expiring)];
  const r = f.recovery();

  await r.run();

  expect(f.calls("conversations.replies")[0]!.searchParams.get("ts")).toBe(expiring);
  expect(f.rows().filter(row => row.destinationSession === "old@test")).toHaveLength(1);
  // The waiting asks follow, newest first.
  expect(f.calls("conversations.replies").slice(1).map(u => u.searchParams.get("ts"))).toEqual([ts(5), ts(4), ts(3)]);
});

it("a reply in the last five seconds before a reconnect is recovered on the next pass, not left for the daily backstop", async () => {
  const f = fixture();
  f.ask(ts(1), "done", "settled@test");
  const r = f.recovery();
  f.time(at(400)); await r.run();
  f.time(at(700)); await r.run();
  expect(f.calls("conversations.replies")).toHaveLength(1);

  // A reply three seconds before live delivery resumes: a scan at the connect stops at the settle margin, before it.
  f.replies[`C1:${ts(1)}`] = [f.reply(1197, ts(1), { text: "just before" })];
  f.time(at(1200)); r.connected();
  await r.run();
  expect(f.calls("conversations.replies").at(-1)!.searchParams.get("latest")).toBe(`${BASE + 1195}.000000`);
  expect(f.rows().filter(row => row.destinationSession === "settled@test")).toHaveLength(0);

  f.time(at(1210)); await r.run();
  expect(f.rows().filter(row => row.destinationSession === "settled@test")).toHaveLength(1);
  const calls = f.calls("conversations.replies").length;
  f.time(at(1500)); await r.run();
  expect(f.calls("conversations.replies")).toHaveLength(calls);
});

it("threads that keep failing ahead of a reachable waiting ask can't take its turn pass after pass", async () => {
  const f = fixture();
  // Four newer waiting asks Slack refuses every time, enough to fill a pass's thread calls, and an older one it answers.
  const failing = [ts(11), ts(12), ts(13), ts(14)];
  failing.forEach((root, i) => f.ask(root, "pending", `failing${i}@test`));
  f.ask(ts(1), "pending", "reachable@test");
  f.replies[`C1:${ts(1)}`] = [f.reply(50, ts(1), { text: "the answer" })];
  f.respond(u => u.pathname.endsWith("conversations.replies") && failing.includes(u.searchParams.get("ts")!)
    ? Response.json({ ok: false, error: "not_in_channel" }) : undefined);
  const r = f.recovery();

  await r.run();
  expect(f.calls("conversations.replies").map(u => u.searchParams.get("ts"))).toEqual([ts(14), ts(13), ts(12), ts(11)]);
  expect(f.rows().filter(row => row.destinationSession === "reachable@test")).toHaveLength(0);

  // Every failing thread's 300-second retry is due again at the next pass; the reachable one still goes first.
  f.time(at(100 + 301)); await r.run();
  const second = f.calls("conversations.replies").slice(4).map(u => u.searchParams.get("ts"));
  expect(second[0]).toBe(ts(1));
  expect(f.rows().filter(row => row.destinationSession === "reachable@test")).toHaveLength(1);
});

it("a reply on the newest waiting ask just before a reconnect is recovered on the next pass, though the connect's own pass stopped short", async () => {
  const f = fixture();
  // Ten waiting asks, more than a pass's four thread calls.
  for (let i = 1; i <= 10; i++) f.ask(ts(i), "pending", `open${i}@test`);
  const r = f.recovery();
  f.advance(5000);
  for (let pass = 0; pass < 3; pass++) { await r.run(); f.advance(300_000); }
  expect(new Set(f.calls("conversations.replies").map(u => u.searchParams.get("ts"))).size).toBe(10);

  // A reply three seconds before live delivery resumes, and a pass at the connect itself, which stops short of it.
  f.replies[`C1:${ts(10)}`] = [f.reply(1997, ts(10), { text: "just before" })];
  f.time(at(2000)); r.connected();
  const before = f.calls("conversations.replies").length;
  await r.run();
  const atConnect = f.calls("conversations.replies").slice(before).map(u => u.searchParams.get("ts"));
  expect(atConnect[0]).toBe(ts(10));
  expect(atConnect.length).toBeLessThan(10);
  expect(f.rows().filter(row => row.destinationSession === "open10@test")).toHaveLength(0);

  // Its call made progress, so it keeps its place ahead of the six threads not yet asked since the connect.
  f.time(at(2300));
  const next = f.calls("conversations.replies").length;
  await r.run();
  expect(f.calls("conversations.replies")[next]!.searchParams.get("ts")).toBe(ts(10));
  expect(f.rows().filter(row => row.destinationSession === "open10@test")).toHaveLength(1);
});

it("a waiting ask whose backlog needs a second page keeps its place ahead of threads not yet asked", async () => {
  const f = fixture();
  for (let i = 1; i <= 10; i++) f.ask(ts(i), "pending", `open${i}@test`);
  // The newest ask has twenty missed replies: more than a page.
  f.replies[`C1:${ts(10)}`] = Array.from({ length: 20 }, (_, i) => f.reply(11 + i, ts(10)));
  const r = f.recovery();
  f.advance(5000);

  await r.run();
  const first = f.calls("conversations.replies").map(u => u.searchParams.get("ts"));
  expect(first[0]).toBe(ts(10));
  expect(first.length).toBeLessThan(10);
  expect(f.rows().filter(row => row.destinationSession === "open10@test").length).toBeLessThan(20);

  f.advance(300_000);
  await r.run();
  expect(f.calls("conversations.replies")[first.length]!.searchParams.get("ts")).toBe(ts(10));
  expect(f.rows().filter(row => row.destinationSession === "open10@test")).toHaveLength(20);
});

it("on a machine the hub relays to, which can't see a gap in relayed events, a settled thread's backstop is three hours", async () => {
  const f = fixture();
  f.ask(ts(1), "done", "settled@test");
  const r = f.recovery({ channels: [{ channel: "C1", seed: "adoption" }], relayed: true });
  r.adoptRelayed("C1", at(100));
  f.advance(5000); // past the settle margin, so a scan covers through boot (the boundary has its own test)
  await r.run();
  const scans = () => f.calls("conversations.replies").length;
  expect(scans()).toBe(1);

  f.time(at(100 + 2 * 3600)); await r.run();
  expect(scans()).toBe(1);
  expect(r.status().threads).toMatchObject({ settled: 1, settledRescanHours: 3 });
  f.time(at(100 + 3 * 3600 + 60)); await r.run();
  expect(scans()).toBe(2);
});
