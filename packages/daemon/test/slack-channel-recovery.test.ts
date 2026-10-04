import { afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { createFullTestDb } from "./helpers/test-app.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { makeQueuePorts } from "../src/domain/gateway/slack/queue-access.js";
import { InboundRouter, handleEnvelope, type InboundDeps, type SlackEvent } from "../src/domain/gateway/slack/inbound.js";
import { ChannelRecovery } from "../src/domain/gateway/slack/channel-recovery.js";
import { ChannelCoverageStore, SeenStore, DeadLetterStore, InboundReceiptStore, slackMicros, type StateFsOps } from "../src/domain/gateway/slack/state-store.js";
import { startSocketInbound, type WsLike } from "../src/domain/gateway/slack/socket-inbound.js";
import type { FetchImpl } from "../src/domain/gateway/slack/slack-api.js";

const closes: (() => void)[] = [];
afterEach(() => { for (const close of closes.splice(0)) close(); vi.useRealTimers(); });
const event = (ts: string, extra: Partial<SlackEvent> = {}): SlackEvent => ({ type: "message", user: "U1", channel: "C1", ts, text: `task ${ts}`, ...extra });
function fixture() {
  const files = new Map<string, string>();
  const fsops: StateFsOps = {
    readFileSync: p => { if (!files.has(p)) throw Object.assign(new Error("absent"), { code: "ENOENT" }); return files.get(p)!; },
    writeFileSync: (p, d) => { files.set(p, d); }, appendFileSync: (p, d) => { files.set(p, (files.get(p) ?? "") + d); },
    rename: (from, to) => { files.set(to, files.get(from)!); files.delete(from); }, mkdirp: () => {},
  };
  const db = createFullTestDb(); closes.push(() => db.close());
  let queueDown = false;
  const repo = new QueueRepository(db, new EventBus(db), { validateRig: () => !queueDown });
  const seen = new SeenStore("/s/slack-inbound-seen.jsonl", fsops);
  const receipts = new InboundReceiptStore("/s/slack-inbound-receipts.jsonl", fsops);
  const dead = new DeadLetterStore<SlackEvent>("/s/dead", fsops);
  const store = new ChannelCoverageStore("/s/coverage", fsops);
  const deps: InboundDeps = { queue: makeQueuePorts(repo), seen, deadLetter: dead, destination: "owner@test",
    resolveSender: user => user === "U1" ? { admitted: true, source: "human-fixture@external" } : { admitted: false, teaching: "register" } };
  const router = new InboundRouter(deps);
  let now = 1_000_000;
  const history: SlackEvent[] = [];
  const queries: URL[] = [];
  let pageSize = 25;
  let response: ((url: URL) => Response | Promise<Response>) | undefined;
  const fetchImpl: FetchImpl = async (url) => {
    const u = new URL(url);
    if (u.pathname.endsWith("apps.connections.open")) return Response.json({ ok: true, url: "wss://fixture" });
    queries.push(u);
    if (response) return response(u);
    const oldest = slackMicros(u.searchParams.get("oldest"))!, latest = slackMicros(u.searchParams.get("latest"))!;
    const matches = history.filter(e => slackMicros(e.ts)! > oldest && slackMicros(e.ts)! < latest)
      .sort((a, b) => slackMicros(a.ts)! > slackMicros(b.ts)! ? -1 : 1);
    const messages = matches.slice(0, pageSize);
    return Response.json({ ok: true, messages, has_more: matches.length > messages.length });
  };
  const recovery = (token: string | null = "fixture-token", channel = "C1") => {
    const r = new ChannelRecovery({ token, channel, stateDir: "/s", store, router, fetchImpl, now: () => now });
    r.initialize(); closes.push(() => r.stop()); return r;
  };
  return { db, repo, files, fsops, seen, receipts, dead, store, router, deps, queries, fetchImpl, recovery, history,
    time: (t: number) => { now = t; }, page: (n: number) => { pageSize = n; },
    respond: (fn?: typeof response) => { response = fn; }, down: (v: boolean) => { queueDown = v; } };
}

it("recovers on socket connect, repeated short wakes and periodic retry through the real queue", async () => {
  vi.useFakeTimers(); const f = fixture(); const recovery = f.recovery();
  const sockets: WsLike[] = [];
  const h = startSocketInbound("fixture-app", f.router, { fetchImpl: f.fetchImpl, recovery, retryIntervalMs: 100,
    wsFactory: () => { const ws: WsLike = { send: vi.fn(), close: () => {}, onopen: null, onclose: null, onmessage: null, onerror: null }; sockets.push(ws); return ws; } });
  closes.unshift(() => h.stop());
  for (let wake = 1; wake <= 4; wake++) {
    f.history.push(event(`${1000 + wake}.000001`)); f.time((1001 + wake) * 1000);
    await vi.advanceTimersByTimeAsync(wake === 1 ? 0 : 1000);
    sockets.at(-1)!.onopen?.(); await vi.advanceTimersByTimeAsync(0);
    expect(f.repo.list({ limit: 100 })).toHaveLength(wake);
    sockets.at(-1)!.onclose?.();
  }
  await vi.advanceTimersByTimeAsync(1000); sockets.at(-1)!.onopen?.(); await vi.advanceTimersByTimeAsync(0);
  f.history.push(event("1006.000001")); f.time(1_007_000);
  await vi.advanceTimersByTimeAsync(100);
  expect(f.repo.list({ limit: 100 })).toHaveLength(5);
  expect(recovery.status().coverage?.coveredThrough).toBe("1007.000000");
  h.stop(); const calls = f.queries.length; await vi.advanceTimersByTimeAsync(1000); expect(f.queries).toHaveLength(calls);
});

it("marks recovered rows visibly with original time; ordinary live rows retain their body and fixed identity", async () => {
  const f = fixture(); const r = f.recovery(); f.history.push(event("1001.123456")); f.time(1_002_000); await r.run();
  const id = `qitem-slack-inbound-${createHash("sha256").update("C1:1001.123456").digest("hex").slice(0,20)}`;
  const row = f.repo.getById(id)!;
  expect(row.body).toContain("Recovered after a gap"); expect(row.body).toContain("1970-01-01T00:16:41.123Z");
  expect(row.body).toContain("1001.123456"); expect(row.sourceSession).toBe("human-fixture@external"); expect(row.destinationSession).toBe("owner@test");
  const live = await f.router.route(event("1003.000001")); expect(f.repo.getById(live.qitemId!)!.body).not.toContain("Recovered");
  await handleEnvelope({type:"events_api",payload:{event:event("1003.000001",{recoveredAfterGap:true})}},()=>{},f.router);
  await r.run(); expect(f.repo.list({ limit: 100 })).toHaveLength(2);
});

it("seeds newest accepted landing once, never newest received/live traffic, across channel switches", async () => {
  const f = fixture(); f.seen.mark("C1:900.000001", "landed"); f.seen.mark("C2:999.1", "landed");
  f.receipts.append({ generation: 1, status: "accepted", channel: "C1", eventTs: "950.000001" });
  f.receipts.append({ generation: 1, status: "received", channel: "C1", eventTs: "990.000001" });
  const r = f.recovery(); expect(r.status().coverage?.coverageStart).toBe("950.000001");
  expect(r.status().limits).toContain("older history unknown");
  await f.router.route(event("1200.000001")); f.time(1_300_000);
  expect(f.recovery().status().coverage?.coveredThrough).toBe("950.000001");
  f.recovery("fixture", "C2"); expect(f.recovery().status().coverage?.coverageStart).toBe("950.000001");
});

it("persists short-page progress across restart without letting newer live traffic erase the gap", async () => {
  const f = fixture(); f.page(1); const r = f.recovery();
  for (let i=1; i<=7; i++) f.history.push(event(`${1000+i}.000001`));
  f.time(1_010_000); await r.run(); expect(f.repo.list({ limit: 100 })).toHaveLength(4);
  expect(r.status().coverage).toMatchObject({ coveredThrough: "1000.000000", pending: { upper: "1010.000000", nextLatest: "1004.000001" } });
  await f.router.route(event("1050.000001")); r.stop(); f.time(1_060_000);
  const restart = f.recovery(); await restart.run();
  expect(f.repo.list({ limit: 100 })).toHaveLength(8); expect(restart.status().coverage?.coveredThrough).toBe("1010.000000");
  expect(f.queries[4]!.searchParams.get("latest")).toBe("1004.000001");
});

it("retains Retry-After across restart and reports missing scope and unavailable token", async () => {
  const f = fixture(); const r = f.recovery(); f.time(1_010_000);
  f.respond(() => Response.json({ ok: false }, { status: 429, headers: { "retry-after": "600" } })); await r.run();
  expect(r.status()).toMatchObject({ state: "backoff", reason: "rate-limited", coverage: { nextRetryAt: 1_610_000 } });
  const next = f.recovery(); await next.run(); expect(f.queries).toHaveLength(1);
  f.time(1_610_000); f.respond(() => Response.json({ ok: false, error: "missing_scope" })); await next.run();
  expect(next.status().reason).toBe("missing_scope");
  const absent = f.recovery(null); await absent.run(); expect(absent.status().reason).toBe("bot-token-unresolved"); expect(f.queries).toHaveLength(2);
});

it("does not checkpoint an in-flight live collision, including its failed owner", async () => {
  const f = fixture(); const r = f.recovery(); let release!: () => void;
  f.deps.files = { transfer: () => new Promise(resolve => { release = () => resolve({ stored: [], failed: [] }); }) };
  const ev = event("1001.000001", { files: [{}] }); f.history.push(ev); f.time(1_002_000);
  const live = f.router.route(ev); await r.run();
  expect(r.status().reason).toBe("landing-in-progress"); expect(r.status().coverage?.coveredThrough).toBe("1000.000000");
  f.down(true); release(); await live; expect(f.dead.readAll()).toHaveLength(1);
  f.deps.files = undefined; await r.run(); expect(r.status().deadLetteredThisProcess).toBe(1);
  f.down(false); await f.router.retryDeadLetters(); expect(f.repo.list({ limit: 100 })).toHaveLength(1); expect(f.dead.readAll()).toHaveLength(0);
});

it.each(["seen", "dead", "checkpoint"])("preserves the page after %s write failure; fixed IDs tolerate replay", async failure => {
  const f = fixture(); const r = f.recovery(); f.history.push(event("1001.000001")); f.time(1_002_000);
  const append = f.fsops.appendFileSync, rename = f.fsops.rename;
  if (failure === "dead") f.down(true);
  f.fsops.appendFileSync = (p, d) => { if ((failure === "seen" && p.endsWith("seen.jsonl")) || (failure === "dead" && p.endsWith("dead"))) throw new Error("disk"); append(p,d); };
  let writes=0; f.fsops.rename = (a,b) => { if (failure === "checkpoint" && ++writes === 2) throw new Error("disk"); rename(a,b); };
  await r.run(); expect(r.status().coverage?.coveredThrough).toBe("1000.000000");
  f.fsops.appendFileSync=append; f.fsops.rename=rename; f.down(false);
  r.stop(); const next=f.recovery(); await next.run(); expect(f.repo.list({ limit: 100 })).toHaveLength(1); expect(next.status().coverage?.coveredThrough).toBe("1002.000000");
});

it("filters bots, replies, edits and unknown senders; preserves files and exact boundary timestamps", async () => {
  const f=fixture(); const r=f.recovery();
  f.history.push(event("1000.000000"), event("1000.000001", {bot_id:"B"}), event("1000.000002",{thread_ts:"999.1"}),
    event("1000.000003",{subtype:"message_changed"}), event("1000.000004",{user:"unknown"}),
    event("1000.000005",{subtype:"file_share",text:"",files:[{name:"kept.txt"}]}), event("1001.000000"));
  f.time(1_001_000); await r.run(); expect(f.repo.list({limit:100})).toHaveLength(2);
  expect(f.repo.list({limit:100}).map(x=>x.body).join("\n")).toContain("FILE TRANSFER FAILED: kept.txt");
  f.time(1_002_000); await r.run(); expect(f.repo.list({limit:100})).toHaveLength(3);
  expect(f.dead.readAll()).toHaveLength(0);
});

it.each([
  { messages: [], has_more: true },
  { messages: [event("1000.000000"), event("1001.1")], has_more: true },
  { messages: [event("2000.1")], has_more: false },
  { messages: [], has_more: false, is_limited: true },
  { messages: [{ text: "missing timestamp" }], has_more: false },
])("leaves malformed, nonprogressing and retention-limited history incomplete: %j", async page => {
  const f=fixture(); const r=f.recovery(); f.time(1_010_000); f.respond(()=>Response.json({ok:true,...page}));
  await r.run(); expect(r.status().state).toBe("incomplete"); expect(r.status().coverage?.coveredThrough).toBe("1000.000000");
});

it("honors cursor continuation even on a short page and yields at deadline mid-page without losing earlier work", async () => {
  const f=fixture(); const r=f.recovery(); f.time(1_010_000);
  f.respond(u=>Response.json({ok:true, messages:u.searchParams.get("latest")==="1010.000000"?[event("1002.1")]:[event("1001.1")],
    response_metadata:{next_cursor:u.searchParams.get("latest")==="1010.000000"?"continued":""}}));
  await r.run(); expect(f.repo.list({limit:100})).toHaveLength(2);
  const g=fixture(); const mid=g.recovery(); g.history.push(event("1001.1",{files:[{}]}),event("1002.1")); g.time(1_010_000);
  g.deps.files={transfer:async()=>{g.time(1_030_000);return {stored:[],failed:[]};}};
  await mid.run(); expect(g.repo.list({limit:100})).toHaveLength(1); expect(mid.status().reason).toBe("pass-budget");
  const resumed=g.recovery(); await resumed.run(); expect(g.repo.list({limit:100})).toHaveLength(2); expect(resumed.status().coverage?.coveredThrough).toBe("1010.000000");
});

it("fences a stopped worker during file I/O and never reseeds a corrupt or unreadable store", async () => {
  const f=fixture(); const r=f.recovery(); f.history.push(event("1001.1",{files:[{}]})); f.time(1_010_000);
  let release!:()=>void; let entered!:()=>void; const started=new Promise<void>(resolve=>{entered=resolve;});
  f.deps.files={transfer:()=>new Promise(resolve=>{entered();release=()=>resolve({stored:[],failed:[]});})};
  const pass=r.run(); await started; r.stop(); release(); await pass;
  expect(f.repo.list({limit:100})).toHaveLength(0); expect(r.status().coverage?.coveredThrough).toBe("1000.000000");
  f.files.set("/s/coverage", "broken"); const bad=f.recovery(); expect(bad.status().state).toBe("unavailable"); expect(f.files.get("/s/coverage")).toBe("broken");
  f.fsops.readFileSync=()=>{throw Object.assign(new Error("denied"),{code:"EACCES"});};
  expect(f.recovery().status().state).toBe("unavailable");
});
