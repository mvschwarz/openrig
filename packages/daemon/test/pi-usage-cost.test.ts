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
import { RunnerCore, parseRunnerArgs, readPiSessionEntryIds, type RunnerIo } from "../src/adapters/pi-runner.js";
import { appendFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { buildPiRunnerCommand } from "../src/adapters/pi-runner-protocol.js";

const usage = (input: number, output: number, cost?: number) => ({
  input, output, cacheRead: 5, cacheWrite: 1, totalTokens: input + output + 6,
  ...(cost === undefined ? {} : { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } }),
});
const at = (s: number, ms = 0) => new Date(Date.UTC(2026, 9, 13, 16, 0, s, ms)).toISOString();
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

  it("origin with the parent's ids: membership decides; without them a tie with the header is unknown", () => {
    const tie = [assistant("b7", 7, 0.1), assistant("n7", 7, 0.2), assistant("x1", 1, 0.3), assistant("p9", 9, 0.4)];
    const fork = { createdAt: at(7), parentSession: "/p.jsonl" };
    const byId = (boundary: PiSessionBoundary) => Object.fromEntries(extractPiUsageFacts(tie, boundary).facts.map((f) => [f.entryId, f.origin]));
    expect(byId(fork)).toEqual({ b7: "unknown", n7: "unknown", x1: "inherited", p9: "own" });
    // b7 and p9 are the parent's; x1 is before the header yet not the parent's: contradictory, so unknown.
    expect(byId({ ...fork, parentEntryIds: new Set(["b7", "p9"]) })).toEqual({ b7: "inherited", n7: "own", x1: "unknown", p9: "inherited" });
  });

  it("readPiSessionEntryIds (the runner's reader) answers only for a complete, valid regular file within the limit", async () => {
    const dir = mkdtempSync(nodePath.join(process.env.TMPDIR ?? tmpdir(), "pi-parent-"));
    try {
      const file = nodePath.join(dir, "parent.jsonl");
      const header = JSON.stringify({ type: "session", id: "sess-1", timestamp: at(0) });
      const good = [header, JSON.stringify(ENTRIES[0]), JSON.stringify(ENTRIES[1]), ""].join("\n");
      writeFileSync(file, good);
      expect([...(await readPiSessionEntryIds(file))!].sort()).toEqual(["a1", "u1"]);
      expect(await readPiSessionEntryIds(file, good.length - 1)).toBeNull(); // over the limit
      for (const bad of ["", good.slice(0, -1), good + "{torn\n", good.replace(header, "{}"), good + "null\n", good + JSON.stringify({ type: "message" }) + "\n"]) {
        writeFileSync(file, bad);
        expect(await readPiSessionEntryIds(file)).toBeNull();
      }
      expect(await readPiSessionEntryIds(nodePath.join(dir, "missing.jsonl"))).toBeNull();
      expect(await readPiSessionEntryIds(dir)).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("R5-F1: a parent that grows or shrinks during the read answers nothing; within or across the limit", async () => {
    const dir = mkdtempSync(nodePath.join(process.env.TMPDIR ?? tmpdir(), "pi-grow-"));
    try {
      const file = nodePath.join(dir, "parent.jsonl");
      const header = JSON.stringify({ type: "session", version: 3, id: "par", timestamp: at(0), cwd: "/w" });
      const rest = "\n" + JSON.stringify(ENTRIES[1]) + "\n"; // the copied a1 lands right after the stat
      const grow = () => appendFileSync(file, rest);
      // The measured schedule: the header without its newline at the stat, then the newline and a copied entry.
      writeFileSync(file, header);
      expect(await readPiSessionEntryIds(file, undefined, { afterStat: grow })).toBeNull();
      writeFileSync(file, header);
      expect(await readPiSessionEntryIds(file, header.length + 10, { afterStat: grow })).toBeNull(); // grows past the limit
      writeFileSync(file, header + "\n");
      expect(await readPiSessionEntryIds(file, undefined, { afterRead: grow })).toBeNull(); // grows after the read reached the end
      writeFileSync(file, header + rest);
      expect(await readPiSessionEntryIds(file, undefined, { afterStat: () => writeFileSync(file, header + "\n") })).toBeNull(); // shrinks
      writeFileSync(file, header + rest);
      expect([...(await readPiSessionEntryIds(file))!]).toEqual(["a1"]); // the settled file answers
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("readPiSessionEntryIds: a FIFO parent is refused at once, with no writer or with one streaming past the limit", async () => {
    const dir = mkdtempSync(nodePath.join(process.env.TMPDIR ?? tmpdir(), "pi-fifo-"));
    try {
      const fifo = nodePath.join(dir, "parent.jsonl");
      execFileSync("mkfifo", [fifo]);
      const started = Date.now();
      expect(await readPiSessionEntryIds(fifo)).toBeNull(); // no writer: would block a plain read forever
      const writer = spawn("sh", ["-c", `for i in $(seq 1 200); do echo '{"type":"message","id":"x'$i'"}'; done > "$1"`, "sh", fifo]);
      expect(await readPiSessionEntryIds(fifo, 32)).toBeNull();
      expect(Date.now() - started).toBeLessThan(2000);
      writer.kill();
      expect(await readPiSessionEntryIds("/dev/zero")).toBeNull(); // a device, never read
    } finally { rmSync(dir, { recursive: true, force: true }); }
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
    expect(parsePiSessionHeader(JSON.stringify({ type: "session", timestamp: "nonsense" }))).toBeNull();
    expect(parsePiSessionHeader(JSON.stringify({ type: "session", timestamp: at(1), parentSession: 42 }))).toBeNull();
    expect(parsePiSessionHeader(JSON.stringify({ type: "session", timestamp: at(1), parentSession: null }))).toEqual({ createdAt: at(1), parentSession: null });
    expect(parsePiSessionHeader("null")).toBeNull();
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

describe("runner → authenticated route → SQLite → cost view", () => {
  const TOKEN = "hook-token";
  function pipeline(header: () => string | null, parentIds: () => ReadonlySet<string> | null | Promise<ReadonlySet<string> | null> = () => null, parentReads = { n: 0 }) {
    const d = db();
    const hono = new Hono();
    hono.use("*", async (c, next) => {
      c.set("agentActivityStore" as never, { resolveSession: () => ({ sessionId: "sid", rigId: "r", nodeId: "node-1", sessionName: SESSION, runtime: "pi" }) } as never);
      c.set("activityHookToken" as never, TOKEN as never);
      c.set("sessionRegistry" as never, { db: d } as never);
      await next();
    });
    hono.route("/api/activity", activityRoutes);
    const io: RunnerIo = {
      sendRpc: () => {}, mirrorLine: () => {}, mirrorAppend: () => {}, postActivity: () => {}, writeSidecar: () => {},
      sessionFileExists: () => true, now: () => at(0), readFirstLine: header,
      readSessionEntryIds: async () => { parentReads.n += 1; return parentIds(); },
      postUsageFacts: async (payload) => (await hono.request("/api/activity/pi-usage", {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(payload) })).ok,
    };
    const core = new RunnerCore(io, { sessionName: SESSION, nodeId: "node-1" }, { usageFacts: true, runtime: "pi" });
    core.start();
    core.handlePiLine(JSON.stringify({ type: "response", id: "pi-runner-get-state", success: true, data: { sessionFile: SESSION_FILE, sessionId: "0197a2f0" } }));
    const refresh = async (entries: unknown[]) => {
      core.handlePiLine(JSON.stringify({ type: "response", id: "pi-runner-cursor-refresh", success: true, command: "get_entries", data: { entries, leafId: null } }));
      for (let i = 0; i < 6; i += 1) await settle();
    };
    const view = () => computeCostView(d, { nowIso: at(60) }).seats[0] as Record<string, any>;
    return { d, hono, refresh, view };
  }
  const forkHeader = (timestamp: unknown, parentSession: unknown = "/state/pi/parent.jsonl") =>
    JSON.stringify({ type: "session", version: 3, id: "0197a2f0", timestamp, cwd: "/w", parentSession });

  // Round 4: Pi stamps the fork header and a new entry with the same millisecond clock, so both a copied entry and a
  // new one can share the header's millisecond. The parent session's entry ids decide; a tie alone never does.
  const PARENT_IDS = new Set(["u1", "a1", "s1", "t1", "t2", "c1", "b1"]); // what forkFrom copied (b1 is stamped at(7))
  const NEW_AT_HEADER = assistant("n7", 7, 0.5); // appended after the fork in the header's own millisecond
  const forkEntries = [...ENTRIES.slice(0, 7), NEW_AT_HEADER, ...ENTRIES.slice(7)];

  it("F1: a copied entry and a new entry sharing the fork header's millisecond: copied is inherited, new is own", async () => {
    const reads = { n: 0 };
    const p = pipeline(() => forkHeader(at(7)), () => PARENT_IDS, reads);
    await p.refresh(forkEntries);
    await p.refresh(forkEntries);
    const seat = p.view();
    const origin = Object.fromEntries((p.d.prepare("SELECT entry_id, origin FROM pi_usage_entries").all() as Array<{ entry_id: string; origin: string }>)
      .map((row) => [row.entry_id, row.origin]));
    expect(origin).toEqual({ a1: "inherited", s1: "inherited", t1: "inherited", c1: "inherited", b1: "inherited", n7: "own", a2: "own", a3: "own" });
    expect(seat.costUsd).toBeCloseTo(0.55, 10); // the new $0.50 is the occupant's, beside a2 and a3
    expect(seat.entries).toMatchObject({ own: 3, inherited: { count: 5 }, unknownOrigin: { count: 0 } });
    expect(reads.n).toBe(1); // read once, to decide the ties
  });

  it("R4-F1: a parent read that never answers doesn't hold up the runner; the ties go as unknown meanwhile", async () => {
    const p = pipeline(() => forkHeader(at(7)), () => new Promise(() => {}));
    await p.refresh(forkEntries);
    expect(p.view()).toMatchObject({ entries: { own: 2, inherited: { count: 4 }, unknownOrigin: { count: 2 } } });
    await p.refresh(forkEntries); // still processing refreshes; no second read while one is under way
    expect(p.view().costUsd).toBeCloseTo(0.05, 10);
  });

  it("R4-F2 with the runner's real reader: an empty, malformed or torn parent leaves the ties unknown; once the parent is valid they settle", async () => {
    const dir = mkdtempSync(nodePath.join(process.env.TMPDIR ?? tmpdir(), "pi-parent-"));
    try {
      const file = nodePath.join(dir, "parent.jsonl");
      const valid = [JSON.stringify({ type: "session", version: 3, id: "par", timestamp: at(0), cwd: "/w" }),
        ...ENTRIES.slice(0, 7).map((e) => JSON.stringify(e)), ""].join("\n");
      for (const broken of ["", "{not json\n", valid.slice(0, -40), valid.replace(/"id":"t2"/, '"id":7')]) {
        writeFileSync(file, broken);
        const p = pipeline(() => forkHeader(at(7), file), () => readPiSessionEntryIds(file));
        await p.refresh(forkEntries);
        await p.refresh(forkEntries);
        expect(p.view()).toMatchObject({ entries: { own: 2, unknownOrigin: { count: 2 } } }); // b1 and n7: never charged
        writeFileSync(file, valid);
        await p.refresh(forkEntries);
        expect(p.view()).toMatchObject({ entries: { own: 3, inherited: { count: 5 }, unknownOrigin: { count: 0 } } });
        expect(p.view().costUsd).toBeCloseTo(0.55, 10);
        expect(p.d.prepare("SELECT origin FROM pi_usage_entries WHERE entry_id = 'b1'").get()).toEqual({ origin: "inherited" });
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("F1: with the parent unreadable a tie stays unknown (shown, not counted, not hidden as history) until it can be read", async () => {
    let parent: ReadonlySet<string> | null = null;
    const p = pipeline(() => forkHeader(at(7)), () => parent);
    await p.refresh(forkEntries);
    expect(p.view()).toMatchObject({ entries: { own: 2, inherited: { count: 4 }, unknownOrigin: { count: 2 } } }); // b1 and n7
    expect(p.view().costUsd).toBeCloseTo(0.05, 10);
    parent = PARENT_IDS;
    await p.refresh(forkEntries);
    expect(p.view()).toMatchObject({ entries: { own: 3, inherited: { count: 5 }, unknownOrigin: { count: 0 } } });
    expect((p.d.prepare("SELECT COUNT(*) AS n FROM pi_usage_entries").get() as { n: number }).n).toBe(8);
  });

  it("F1: the parent is read only when a tie needs deciding", async () => {
    const reads = { n: 0 };
    const p = pipeline(() => forkHeader(at(7, 500)), () => PARENT_IDS, reads); // no entry shares this millisecond
    await p.refresh(forkEntries);
    expect(reads.n).toBe(0);
    expect(p.view()).toMatchObject({ entries: { own: 2, inherited: { count: 6 } } }); // n7 at(7) is before at(7.5): history by time
  });

  it("R5-F1 through the runner: a parent caught mid-write leaves the tie unknown, never charged; it settles once the write completes", async () => {
    const dir = mkdtempSync(nodePath.join(process.env.TMPDIR ?? tmpdir(), "pi-grow-"));
    try {
      const file = nodePath.join(dir, "parent.jsonl");
      const valid = [JSON.stringify({ type: "session", version: 3, id: "par", timestamp: at(0), cwd: "/w" }),
        ...ENTRIES.slice(0, 7).map((e) => JSON.stringify(e)), ""].join("\n");
      const cut = valid.indexOf("\n"); // the header without its newline
      writeFileSync(file, valid.slice(0, cut));
      let grown = false;
      const p = pipeline(() => forkHeader(at(7), file), () => readPiSessionEntryIds(file, undefined, {
        afterStat: () => { if (!grown) { grown = true; appendFileSync(file, valid.slice(cut)); } } }));
      await p.refresh(forkEntries);
      expect(p.view()).toMatchObject({ entries: { own: 2, unknownOrigin: { count: 2 } } });
      expect(p.view().costUsd).toBeCloseTo(0.05, 10); // the copied b1 is not charged
      await p.refresh(forkEntries);
      expect(p.view()).toMatchObject({ entries: { own: 3, inherited: { count: 5 }, unknownOrigin: { count: 0 } } });
      expect(p.d.prepare("SELECT origin FROM pi_usage_entries WHERE entry_id = 'b1'").get()).toEqual({ origin: "inherited" });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("a tie that arrives while the parent read is under way settles when it completes, without another refresh", async () => {
    let release!: (ids: ReadonlySet<string>) => void;
    const reads = { n: 0 };
    const p = pipeline(() => forkHeader(at(7)), () => new Promise((resolve) => { release = resolve; }), reads);
    await p.refresh(forkEntries.filter((e) => e.id !== "n7")); // b1 ties: the read starts
    await p.refresh(forkEntries); // n7 arrives while it is under way
    release(PARENT_IDS);
    for (let i = 0; i < 6; i += 1) await settle();
    expect(reads.n).toBe(1);
    expect(p.view()).toMatchObject({ entries: { own: 3, inherited: { count: 5 }, unknownOrigin: { count: 0 } } });
  });

  it("F2: a header that parses but isn't valid is unknown (nothing counted as own); a later valid header settles it", async () => {
    for (const bad of [forkHeader("nonsense"), forkHeader(at(7), 42), JSON.stringify(null), JSON.stringify([1])]) {
      let header: string | null = bad;
      const p = pipeline(() => header, () => PARENT_IDS);
      await p.refresh(ENTRIES);
      expect(p.view()).toMatchObject({ status: "absent", entries: { own: 0, unknownOrigin: { count: 7 } } });
      header = forkHeader(at(7)); // read again on the next refresh
      await p.refresh(ENTRIES);
      expect(p.view()).toMatchObject({ status: "reported", entries: { own: 2, unknownOrigin: { count: 0 }, inherited: { count: 5 } } });
      expect((p.d.prepare("SELECT COUNT(*) AS n FROM pi_usage_entries").get() as { n: number }).n).toBe(7);
    }
  });

  it("N1: an authenticated JSON null (or array) body is a 400, not a server error", async () => {
    const p = pipeline(() => HEADER());
    for (const body of ["null", "[]", "7"]) {
      const res = await p.hono.request("/api/activity/pi-usage", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` }, body });
      expect(res.status).toBe(400);
    }
  });

  it("a late entry for an older Pi session doesn't switch the window back to it", () => {
    const d = db();
    const store = new PiUsageEntriesStore(d);
    const base = { seatSession: SESSION, nodeId: null, generation: null };
    store.record({ ...base, piSessionId: "old", facts: facts(OWN, [assistant("o1", 1, 0.1)]) }, at(20));
    store.record({ ...base, piSessionId: "new", facts: facts(OWN, [assistant("n1", 30, 0.5)]) }, at(40));
    store.record({ ...base, piSessionId: "old", facts: facts(OWN, [assistant("o2", 2, 0.2)]) }, at(50));
    expect(computeCostView(d, { nowIso: at(60) }).seats[0]).toMatchObject({ costUsd: 0.5, window: { piSessionId: "new" } });
  });
});
