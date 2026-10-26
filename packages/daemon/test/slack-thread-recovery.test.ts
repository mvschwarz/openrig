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
  const recovery = (opts: { channels?: Array<{ channel: string; seed?: "adoption" }> } = {}) => {
    const r = new SlackRecovery({ channels: opts.channels ?? [{ channel: "C1" }], token: "fixture-token", stateDir: "/s", router,
      trackedThreads: (channels, closedSince) => map.trackedForRecovery(channels, closedSince),
      fetchImpl, now: () => now, channelStore, threadStore });
    r.initialize();
    closes.push(() => r.stop());
    return r;
  };
  const track = (root: string, seat = "asker@test", channel = "C1") =>
    map.open({ threadTs: root, channel, human: "human-fixture@external", seat, conversationId: `q-${seat}-${root}` });
  const reply = (seconds: number, root = ROOT, extra: Partial<SlackEvent> = {}): SlackEvent =>
    ({ type: "message", user: "U1", channel: "C1", text: `reply ${seconds}`, ts: ts(seconds), thread_ts: root, ...extra });
  const message = (seconds: number, channel = "C1"): SlackEvent =>
    ({ type: "message", user: "U1", channel, text: `task ${seconds}`, ts: ts(seconds) });
  const calls = (method: string) => queries.filter(u => u.pathname.endsWith(method));
  const rows = () => repo.list({ limit: 500 });
  return { db, files, seen, dead, map, router, deps, routed, resolveHumanReply, history, replies, queries, recovery, track, reply, message,
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

  expect(f.calls("conversations.replies").map(u => u.searchParams.get("ts"))).toEqual([root("oldClosed"), root("recentRoot")]);
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

it("a thread Slack can't find stays incomplete without a call each pass until its mapping changes", async () => {
  const f = fixture(); f.track(ROOT);
  f.respond(u => u.pathname.endsWith("conversations.replies") ? Response.json({ ok: false, error: "thread_not_found" }) : undefined);
  const r = f.recovery();
  await r.run();
  f.time(at(1000)); await r.run();

  expect(f.calls("conversations.replies")).toHaveLength(1);
  expect(r.status().threads).toMatchObject({ incomplete: { thread_not_found: 1 } });
  f.map.close(ROOT, "C1"); f.time(at(1100)); await r.run();
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
  for (let i = 1; i <= 10; i++) { f.track(ts(i), `s${i}@test`); f.replies[`C1:${ts(i)}`] = [f.reply(i + 20, ts(i))]; }
  f.history.C1 = [];
  const r = f.recovery();
  for (let pass = 1; pass <= 4; pass++) {
    f.history.C1.push(f.message(100 + pass * 10 - 2)); f.time(at(105 + pass * 10));
    const before = f.calls("conversations.replies").length;
    await r.run();
    expect(f.calls("conversations.history")).toHaveLength(pass);
    expect(f.calls("conversations.replies").length - before).toBe(3);
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
