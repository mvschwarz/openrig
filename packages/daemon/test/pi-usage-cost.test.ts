// OPR.0.7.0.2 (cost reporting, Pi atom): Pi cost from PERSISTED session entries, counted once, with a fork's
// inherited history kept apart from the new occupant's spend. Hermetic: Pi 0.87.1-shaped entry fixtures, a fake
// runner IO, an in-memory database and the activity route; no Pi process, no account, no provider call.
import { describe, it, expect, afterEach } from "vitest";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { extractPiUsageFacts, parsePiSessionHeader, type PiSessionBoundary } from "../src/domain/pi-usage-facts.js";
import { PiUsageEntriesStore, validPiUsageFact } from "../src/domain/pi-usage-entries-store.js";
import { computeCostView, PI_COST_COVERAGE } from "../src/domain/usage-series.js";
import { activityRoutes } from "../src/routes/activity.js";
import { RunnerCore, parseRunnerArgs, type RunnerIo } from "../src/adapters/pi-runner.js";
import { buildPiRunnerCommand } from "../src/adapters/pi-runner-protocol.js";

const usage = (input: number, output: number, cost?: number) => ({
  input, output, cacheRead: 5, cacheWrite: 1, totalTokens: input + output + 6,
  ...(cost === undefined ? {} : { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } }),
});
const at = (s: number) => new Date(Date.UTC(2026, 9, 13, 16, 0, s)).toISOString();
const assistant = (id: string, s: number, cost: number | undefined, stopReason = "stop") => ({
  type: "message", id, parentId: null, timestamp: at(s),
  message: { role: "assistant", provider: "openrouter", model: "m-1", responseModel: "m-1-0801", usage: usage(100, 20, cost), stopReason },
});
/** One of each usage-bearing kind Pi 0.87.1 records, plus entries that carry none. */
const ENTRIES = [
  { type: "message", id: "u1", parentId: null, timestamp: at(1), message: { role: "user", content: "hi" } },
  assistant("a1", 2, 0.01),
  { type: "usage", id: "s1", parentId: "a1", timestamp: at(3), kind: "cache_warm", provider: "openrouter", model: "m-1", usage: usage(50, 0, 0.002) },
  { type: "message", id: "t1", parentId: "s1", timestamp: at(4), message: { role: "toolResult", usage: usage(10, 5, 0.001) } },
  { type: "message", id: "t2", parentId: "t1", timestamp: at(5), message: { role: "toolResult" } },
  { type: "compaction", id: "c1", parentId: "t2", timestamp: at(6), summary: "s", firstKeptEntryId: "a1", tokensBefore: 9, usage: usage(30, 10, 0.004) },
  { type: "branch_summary", id: "b1", parentId: "c1", timestamp: at(7), fromId: "a1", summary: "s", usage: usage(8, 2, 0.0005) },
  { type: "model_change", id: "m1", parentId: "b1", timestamp: at(8), provider: "p", modelId: "x" },
  assistant("a2", 9, 0.02, "error"),
  assistant("a3", 10, 0.03, "aborted"),
];
const OWN: PiSessionBoundary = { createdAt: at(0), parentSession: null };

describe("extractPiUsageFacts (Pi 0.87.1, session format v3)", () => {
  it("covers every usage-bearing kind Pi's own totals count, and only those", () => {
    const { facts, malformed } = extractPiUsageFacts(ENTRIES, OWN);
    expect(malformed).toBe(0);
    expect(facts.map((f) => [f.entryId, f.kind])).toEqual([
      ["a1", "assistant"], ["s1", "usage"], ["t1", "tool_result"], ["c1", "compaction"], ["b1", "branch_summary"], ["a2", "assistant"], ["a3", "assistant"],
    ]);
    expect(facts[0]).toMatchObject({ provider: "openrouter", model: "m-1-0801", input: 100, output: 20, cacheRead: 5, cacheWrite: 1, costTotal: 0.01, origin: "own" });
    expect(facts[1]).toMatchObject({ usageCategory: "cache_warm" });
  });

  it("keeps the usage of error and aborted turns, with their stop reason", () => {
    const { facts } = extractPiUsageFacts(ENTRIES, OWN);
    expect(facts.filter((f) => f.stopReason === "error" || f.stopReason === "aborted").map((f) => f.costTotal)).toEqual([0.02, 0.03]);
  });

  it("an entry without a cost is absent (null), never zero; malformed usage is counted and skipped without throwing", () => {
    const { facts, malformed } = extractPiUsageFacts([
      assistant("n1", 1, undefined),
      { type: "message", id: "bad", parentId: null, timestamp: at(2), message: { role: "assistant", usage: { input: "x" } } },
      { type: "usage", parentId: null, timestamp: at(3), usage: usage(1, 1, 0.1) },
      null, 7, "noise",
    ], OWN);
    expect(facts).toEqual([expect.objectContaining({ entryId: "n1", costTotal: null })]);
    expect(malformed).toBe(2);
  });

  it("origin: a fork's copied entries (older than the session header) are inherited; later ones are own; no header is unknown", () => {
    const fork: PiSessionBoundary = { createdAt: at(8), parentSession: "/state/pi/x/sessions/parent.jsonl" };
    const byId = Object.fromEntries(extractPiUsageFacts(ENTRIES, fork).facts.map((f) => [f.entryId, f.origin]));
    expect(byId).toMatchObject({ a1: "inherited", b1: "inherited", a2: "own", a3: "own" });
    expect(extractPiUsageFacts(ENTRIES, null).facts.every((f) => f.origin === "unknown")).toBe(true);
  });

  it("parses the session header line, and rejects anything else", () => {
    expect(parsePiSessionHeader(JSON.stringify({ type: "session", version: 3, id: "s", timestamp: at(1), cwd: "/w", parentSession: "/p.jsonl" })))
      .toEqual({ createdAt: at(1), parentSession: "/p.jsonl" });
    expect(parsePiSessionHeader(JSON.stringify({ type: "session", version: 3, id: "s", timestamp: at(1), cwd: "/w" }))).toEqual({ createdAt: at(1), parentSession: null });
    expect(parsePiSessionHeader(JSON.stringify(ENTRIES[1]))).toBeNull();
    expect(parsePiSessionHeader("not json")).toBeNull();
  });
});

const SESSION = "devpi-a@rig";
const SESSION_FILE = "/state/pi/devpi-a@rig/sessions/2026_0197.jsonl";
const HEADER = (parentSession?: string) => JSON.stringify({ type: "session", version: 3, id: "0197a2f0", timestamp: at(8), cwd: "/w", ...(parentSession ? { parentSession } : {}) });

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function runner(opts: { usageFacts?: boolean; runtime?: "pi" | "omp"; header?: string | null | (() => string | null); accept?: () => boolean } = {}) {
  const posted: Record<string, any>[] = [];
  const rpc: Record<string, unknown>[] = [];
  const io: RunnerIo = {
    sendRpc: (cmd) => rpc.push(cmd), mirrorLine: () => {}, mirrorAppend: () => {}, postActivity: () => {}, writeSidecar: () => {},
    sessionFileExists: () => true, now: () => at(0),
    postUsageFacts: async (payload) => { posted.push(payload); return opts.accept ? opts.accept() : true; },
    readFirstLine: () => (opts.header === undefined ? HEADER() : typeof opts.header === "function" ? opts.header() : opts.header),
  };
  const core = new RunnerCore(io, { sessionName: SESSION, nodeId: "node-1", generation: "gen-2" },
    { usageFacts: opts.usageFacts ?? true, runtime: opts.runtime ?? "pi" });
  core.start();
  core.handlePiLine(JSON.stringify({ type: "response", id: "pi-runner-get-state", success: true, data: { sessionFile: SESSION_FILE, sessionId: "0197a2f0" } }));
  const refresh = (entries: unknown[]) => core.handlePiLine(JSON.stringify({ type: "response", id: "pi-runner-cursor-refresh", success: true, command: "get_entries", data: { entries, leafId: null } }));
  return { core, posted, rpc, refresh };
}

describe("RunnerCore usage facts (--usage-facts)", () => {
  it("posts persisted-entry facts after a turn's refresh, each accepted entry once per process", async () => {
    const r = runner();
    r.refresh(ENTRIES.slice(0, 4));
    await settle();
    r.refresh(ENTRIES); // the next turn's refresh returns the whole session again
    expect(r.posted).toHaveLength(2);
    expect(r.posted[0]).toMatchObject({ sessionName: SESSION, nodeId: "node-1", generation: "gen-2", piSessionId: "0197a2f0", forked: false, malformed: 0 });
    expect(r.posted[0]!.facts.map((f: { entryId: string }) => f.entryId)).toEqual(["a1", "s1", "t1"]);
    expect(r.posted[1]!.facts.map((f: { entryId: string }) => f.entryId)).toEqual(["c1", "b1", "a2", "a3"]);
  });

  it("a failed post marks nothing: the next refresh sends the same entries again, and only success settles them", async () => {
    let up = false;
    const r = runner({ accept: () => up });
    r.refresh(ENTRIES.slice(0, 4)); // daemon restarting, timeout, 503 or 404
    await settle();
    up = true;
    r.refresh(ENTRIES.slice(0, 4));
    await settle();
    r.refresh(ENTRIES.slice(0, 4));
    await settle();
    expect(r.posted.map((p) => p.facts.map((f: { entryId: string }) => f.entryId))).toEqual([["a1", "s1", "t1"], ["a1", "s1", "t1"]]);
  });

  it("live message_update usage is never posted; only get_entries responses are", () => {
    const r = runner();
    r.core.handlePiLine(JSON.stringify({ type: "message_update", message: { role: "assistant", usage: usage(500, 50, 9.99) } }));
    r.core.handlePiLine(JSON.stringify({ type: "message_end", message: { role: "assistant", usage: usage(500, 50, 9.99) } }));
    expect(r.posted).toEqual([]);
  });

  it("a forked session marks the copied entries inherited from the header boundary", () => {
    const r = runner({ header: HEADER("/state/pi/parent.jsonl") });
    r.refresh(ENTRIES);
    expect(r.posted[0]).toMatchObject({ forked: true, sessionCreatedAt: at(8) });
    const origin = Object.fromEntries(r.posted[0]!.facts.map((f: { entryId: string; origin: string }) => [f.entryId, f.origin]));
    expect(origin).toMatchObject({ a1: "inherited", c1: "inherited", a2: "own" });
  });

  it("an unreadable header is read again on the next refresh; unknown facts are resent until their origin settles", async () => {
    let header: string | null = null;
    const r = runner({ header: () => header });
    r.refresh(ENTRIES);
    await settle();
    header = HEADER("/state/pi/parent.jsonl");
    r.refresh(ENTRIES);
    await settle();
    r.refresh(ENTRIES);
    await settle();
    expect(r.posted).toHaveLength(2);
    expect(r.posted[0]!.facts.every((f: { origin: string }) => f.origin === "unknown")).toBe(true);
    expect(r.posted[1]).toMatchObject({ forked: true });
    expect(Object.fromEntries(r.posted[1]!.facts.map((f: { entryId: string; origin: string }) => [f.entryId, f.origin]))).toMatchObject({ a1: "inherited", a2: "own" });
  });

  it("an unreadable header leaves origin unknown; the switch off and OMP post nothing", () => {
    const unknown = runner({ header: null });
    unknown.refresh(ENTRIES);
    expect(unknown.posted[0]).toMatchObject({ forked: null });
    expect(unknown.posted[0]!.facts.every((f: { origin: string }) => f.origin === "unknown")).toBe(true);
    const off = runner({ usageFacts: false });
    off.refresh(ENTRIES);
    expect(off.posted).toEqual([]);
    const omp = runner({ runtime: "omp" });
    omp.refresh(ENTRIES);
    expect(omp.posted).toEqual([]);
  });

  it("the cursor still advances as before, with or without the switch", () => {
    for (const usageFacts of [true, false]) {
      const r = runner({ usageFacts });
      r.refresh(ENTRIES);
      expect((r.core as unknown as { lastEntryId: string }).lastEntryId).toBe("a3");
    }
  });
});

describe("the runner command and args", () => {
  const base = { runnerEntryPath: "/d/pi-runner.js", sessionName: SESSION, stateRoot: "/s", cwd: "/w", trust: "no-approve" as const, launchId: "L" };
  it("adds --usage-facts only when on, and only for Pi; off is today's command byte for byte", () => {
    expect(buildPiRunnerCommand({ ...base, usageFacts: false })).toBe(buildPiRunnerCommand(base));
    expect(buildPiRunnerCommand({ ...base, usageFacts: true })).toBe(`${buildPiRunnerCommand(base)} --usage-facts`);
    expect(buildPiRunnerCommand({ ...base, runtime: "omp", usageFacts: true })).not.toContain("--usage-facts");
    expect(parseRunnerArgs(["--session-name", SESSION, "--state-root", "/s", "--cwd", "/w", "--launch-id", "L", "--no-approve", "--usage-facts"]).usageFacts).toBe(true);
    expect(parseRunnerArgs(["--session-name", SESSION, "--state-root", "/s", "--cwd", "/w", "--launch-id", "L", "--no-approve"]).usageFacts).toBeUndefined();
  });
});

const dbs: Database.Database[] = [];
afterEach(() => { for (const d of dbs.splice(0)) d.close(); });
function db(): Database.Database {
  const d = createDb();
  migrate(d, ALL_MIGRATIONS);
  dbs.push(d);
  return d;
}
const facts = (boundary: PiSessionBoundary | null, entries = ENTRIES) => extractPiUsageFacts(entries, boundary).facts;

describe("PiUsageEntriesStore", () => {
  it("stores each (Pi session, entry) once: a replay or restart stores nothing new", () => {
    const store = new PiUsageEntriesStore(db());
    const input = { seatSession: SESSION, nodeId: "node-1", generation: "gen-2", piSessionId: "0197a2f0", facts: facts(OWN) };
    expect(store.record(input, at(20))).toEqual({ stored: 7, duplicates: 0 });
    expect(store.record(input, at(30))).toEqual({ stored: 0, duplicates: 7 });
  });

  it("an unknown origin settles to own or inherited when resent; a known origin never changes", () => {
    const d = db();
    const store = new PiUsageEntriesStore(d);
    const base = { seatSession: SESSION, nodeId: null, generation: null, piSessionId: "f" };
    store.record({ ...base, facts: facts(null) }, at(20));
    expect(store.record({ ...base, facts: facts({ createdAt: at(8), parentSession: "/p.jsonl" }) }, at(30))).toEqual({ stored: 7, duplicates: 0 });
    expect(store.record({ ...base, facts: facts(OWN) }, at(40))).toEqual({ stored: 0, duplicates: 7 });
    expect(store.record({ ...base, facts: facts(null) }, at(50))).toEqual({ stored: 0, duplicates: 7 });
    const origins = d.prepare("SELECT origin, COUNT(*) AS n FROM pi_usage_entries GROUP BY origin ORDER BY origin").all();
    expect(origins).toEqual([{ origin: "inherited", n: 5 }, { origin: "own", n: 2 }]);
  });

  it("validates a posted fact field by field", () => {
    const good = facts(OWN)[0]!;
    expect(validPiUsageFact(good)).toEqual(good);
    expect(validPiUsageFact({ ...good, kind: "invoice" })).toBeNull();
    expect(validPiUsageFact({ ...good, origin: "mine" })).toBeNull();
    expect(validPiUsageFact({ ...good, costTotal: "free" })).toBeNull();
    expect(validPiUsageFact({ ...good, costTotal: null })).toMatchObject({ costTotal: null });
  });
});

describe("computeCostView, Pi seats", () => {
  it("sums the own entries' model-priced estimate across every kind; error/abort usage is in it and counted", () => {
    const d = db();
    new PiUsageEntriesStore(d).record({ seatSession: SESSION, nodeId: "n", generation: "g", piSessionId: "0197a2f0", facts: facts(OWN) }, at(20));
    const [seat] = computeCostView(d, { nowIso: at(60) }).seats;
    expect(seat).toMatchObject({
      seatSession: SESSION, runtime: "pi", status: "reported", kind: "model-priced estimate", source: "Pi persisted session entries (usage.cost.total)",
      window: { piSessionId: "0197a2f0", since: at(2), asOf: at(10) }, coverage: PI_COST_COVERAGE,
      kinds: { assistant: 3, usage: 1, tool_result: 1, compaction: 1, branch_summary: 1 },
      entries: { own: 7, ownWithoutCost: 0, errorOrAborted: 2, inherited: { count: 0, costUsd: null }, unknownOrigin: { count: 0, costUsd: null } },
    });
    expect((seat as { costUsd: number }).costUsd).toBeCloseTo(0.01 + 0.002 + 0.001 + 0.004 + 0.0005 + 0.02 + 0.03, 10);
  });

  it("a fork: inherited entries are shown apart and never added to the new occupant's total", () => {
    const d = db();
    new PiUsageEntriesStore(d).record({ seatSession: SESSION, nodeId: "n", generation: "g", piSessionId: "fork-1",
      facts: facts({ createdAt: at(8), parentSession: "/p.jsonl" }) }, at(20));
    const [seat] = computeCostView(d, { nowIso: at(60) }).seats as Array<Record<string, any>>;
    expect(seat!.costUsd).toBeCloseTo(0.05, 10);
    expect(seat!.entries.own).toBe(2);
    expect(seat!.entries.inherited.count).toBe(5);
    expect(seat!.entries.inherited.costUsd).toBeCloseTo(0.0175, 10);
  });

  it("unknown origin is kept apart; a session whose own entries carry no cost reads absent, never $0", () => {
    const d = db();
    const store = new PiUsageEntriesStore(d);
    store.record({ seatSession: "u@rig", nodeId: null, generation: null, piSessionId: "s-u", facts: facts(null) }, at(20));
    store.record({ seatSession: "n@rig", nodeId: null, generation: null, piSessionId: "s-n", facts: facts(OWN, [assistant("x1", 1, undefined)]) }, at(20));
    const seats = Object.fromEntries(computeCostView(d, { nowIso: at(60) }).seats.map((s) => [s.seatSession, s as Record<string, any>]));
    expect(seats["u@rig"]).toMatchObject({ status: "absent", reason: "no own entries with usage are stored for this Pi session yet", entries: { own: 0, unknownOrigin: { count: 7 } } });
    expect(seats["n@rig"]).toMatchObject({ status: "absent", reason: "Pi recorded no cost on this session's own entries", entries: { own: 1, ownWithoutCost: 1 } });
    expect(seats["n@rig"]).not.toHaveProperty("costUsd");
  });

  it("the latest Pi session is the window; an earlier session stays stored as history", () => {
    const d = db();
    const store = new PiUsageEntriesStore(d);
    store.record({ seatSession: SESSION, nodeId: null, generation: null, piSessionId: "old", facts: facts(OWN) }, at(20));
    store.record({ seatSession: SESSION, nodeId: null, generation: null, piSessionId: "new", facts: facts(OWN, [assistant("z1", 30, 0.5)]) }, at(40));
    expect(computeCostView(d, { nowIso: at(60) }).seats[0]).toMatchObject({ costUsd: 0.5, window: { piSessionId: "new" } });
    expect((d.prepare("SELECT COUNT(*) AS n FROM pi_usage_entries").get() as { n: number }).n).toBe(8);
  });

  it("without the table, no Pi rows appear and nothing fails", () => {
    const d = createDb();
    dbs.push(d);
    d.exec("CREATE TABLE usage_samples (id INTEGER PRIMARY KEY, lane TEXT, seat_session TEXT, source TEXT, sampled_at TEXT, captured_at TEXT, total_input_tokens INTEGER, total_output_tokens INTEGER)");
    expect(computeCostView(d, { nowIso: at(60) }).seats).toEqual([]);
  });
});

describe("POST /api/activity/pi-usage", () => {
  const TOKEN = "hook-token";
  function app(runtime: string | null = "pi") {
    const d = db();
    const fakeStore = { resolveSession: (q: { sessionName?: string | null }) => (q.sessionName === SESSION && runtime
      ? { sessionId: "sid", rigId: "r", nodeId: "node-1", sessionName: SESSION, runtime } : null) };
    const hono = new Hono();
    hono.use("*", async (c, next) => {
      c.set("agentActivityStore" as never, fakeStore as never);
      c.set("activityHookToken" as never, TOKEN as never);
      c.set("sessionRegistry" as never, { db: d } as never);
      await next();
    });
    hono.route("/api/activity", activityRoutes);
    const post = (body: unknown, token = TOKEN) => hono.request("/api/activity/pi-usage", {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    return { d, post };
  }
  const body = { sessionName: SESSION, nodeId: "node-1", generation: "gen-2", piSessionId: "0197a2f0", facts: facts(OWN), malformed: 0 };

  it("stores the facts once; a repeated post (replay, restart) stores nothing new", async () => {
    const a = app();
    expect(await (await a.post(body)).json()).toEqual({ ok: true, stored: 7, duplicates: 0, rejected: 0 });
    expect(await (await a.post(body)).json()).toEqual({ ok: true, stored: 0, duplicates: 7, rejected: 0 });
    expect(a.d.prepare("SELECT seat_session, occupant_generation FROM pi_usage_entries LIMIT 1").get()).toEqual({ seat_session: SESSION, occupant_generation: "gen-2" });
  });

  it("refuses a wrong token, an unknown or non-Pi seat, and a malformed body; counts rejected facts", async () => {
    expect((await app().post(body, "nope")).status).toBe(401);
    expect((await app(null).post(body)).status).toBe(404);
    expect((await app("claude-code").post(body)).status).toBe(404);
    expect((await app().post({ sessionName: SESSION })).status).toBe(400);
    expect(await (await app().post({ ...body, facts: [...body.facts, { entryId: "x" }] })).json()).toMatchObject({ stored: 7, rejected: 1 });
  });
});
