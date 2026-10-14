// Slice 02 — System → Cost: the read and the presenter, against the daemon's own cost route over a real store (and
// plain served JSON for states that store can't hold). Every seat's first line is the line `rig usage cost` prints
// for the same response; every served kind, source, window, coverage, count and reason shows; a charge sits beside
// its estimate and is never added; tiny money never reads as zero; failures and absence say so; and the read is one
// GET of one route, starting nothing.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { createDb } from "../../daemon/src/db/connection.js";
import { migrate } from "../../daemon/src/db/migrate.js";
import { ALL_MIGRATIONS } from "../../daemon/src/db/all-migrations.js";
import { UsageSamplesStore } from "../../daemon/src/domain/usage-samples-store.js";
import { PiUsageEntriesStore } from "../../daemon/src/domain/pi-usage-entries-store.js";
import { telemetryRoutes } from "../../daemon/src/routes/telemetry.js";
import { costLine } from "../../cli/src/commands/usage.js";
import { readUsageCost, COST_ROUTE, type CostRead } from "../src/cost/cost-read.js";
import { costLines, costHeadLine, formatUsd } from "../src/cost/cost-model.js";

const NOW = "2026-10-14T05:00:00.000Z";
const at = (min: number) => new Date(Date.parse("2026-10-14T04:00:00.000Z") + min * 60_000).toISOString();

let db: Database.Database;
let trace: string[];
let override: ((path: string) => Response | null) | null;
let external: ReturnType<typeof vi.fn>;

function seed(d: Database.Database) {
  const samples = new UsageSamplesStore(d);
  const ctx = (seat: string, source: string, minute: number, session: string | null, cost: number | null, input = 1000, output = 50) =>
    samples.appendContextSample({ nodeId: "n", seatSession: seat, source, sampledAt: at(minute), totalInputTokens: input,
      totalOutputTokens: output, usedPercentage: 5, nativeSessionId: session, clientCostEstimateUsd: cost }, at(minute));
  // Claude: a reset inside one session, then a fresh estimate; a stale one; one with no cost reported.
  ctx("dev-claude@r", "claude_statusline_json", 50, "s1", 2.0);
  ctx("dev-claude@r", "claude_statusline_json", 52, "s1", 0.3);
  ctx("dev-claude@r", "claude_statusline_json", 58, "s1", 0.45, 2000, 80);
  ctx("tiny-claude@r", "claude_statusline_json", 58, "s2", 0.0041);
  ctx("old-claude@r", "claude_statusline_json", 0, "s9", 1.5);
  ctx("quiet-claude@r", "claude_statusline_json", 59, "s5", null);
  // Codex: tokens, no cost method. And a source with no cost.
  ctx("dev-codex@r", "codex_token_count_jsonl", 59, "t1", null, 4000, 300);
  ctx("misc@r", "other_source", 59, null, null);
  // Pi: a fork session with own, inherited and unknown-origin entries, and OpenRouter charges beside them.
  const pi = new PiUsageEntriesStore(d);
  const fact = (id: string, minute: number, cost: number | null, origin: "own" | "inherited" | "unknown", extra: Record<string, unknown> = {}) => ({
    entryId: id, parentEntryId: null, entryTimestamp: at(minute), kind: "assistant" as const, usageCategory: null, provider: "openrouter",
    model: "z-ai/glm-5.2", input: 100, output: 20, cacheRead: 5, cacheWrite: 1, costTotal: cost, stopReason: "stop", origin,
    api: "openai-completions", responseId: `gen-${id}`, ...extra });
  pi.record({ seatSession: "dev-pi@r", nodeId: null, generation: null, piSessionId: "pi-s1", facts: [
    fact("h1", 1, 0.2, "inherited"), fact("u1", 2, 0.03, "unknown"),
    fact("a1", 10, 0.01, "own"), fact("a2", 11, 0.002, "own"), fact("a3", 12, null, "own"), fact("a4", 13, 0.02, "own", { stopReason: "error" }),
    fact("m1", 14, 0.05, "own", { api: "anthropic-messages", responseId: "msg_1" }),
  ] }, at(20));
  const charge = (entryId: string, status: "charged" | "unavailable", total: number | null, reason: string | null = null) => ({
    entryId, generationId: `gen-${entryId}`, status, totalCostUsd: total, upstreamInferenceCostUsd: null, cacheDiscountUsd: null, isByok: false,
    providerName: "Z.AI", model: "z-ai/glm-5.2", apiType: "completions", workspaceId: status === "charged" ? "ws-1" : null, generationCreatedAt: at(10),
    credentialSource: "OPENROUTER_API_KEY (forwarded by OpenRig; Pi's credential observed before and after the request)", reason });
  pi.recordCharges({ seatSession: "dev-pi@r", piSessionId: "pi-s1", charges: [
    charge("a1", "charged", 0.012), charge("a2", "charged", 0.0004),
    charge("a3", "unavailable", null, "not available after 5 lookups (last: HTTP 404)"),
  ] }, at(21));
}

beforeEach(() => {
  db = createDb();
  migrate(db, ALL_MIGRATIONS);
  seed(db);
  trace = [];
  override = null;
  external = vi.fn(() => { throw new Error("unexpected external operation"); });
  vi.stubGlobal("fetch", external);
});
afterEach(() => { vi.unstubAllGlobals(); db.close(); });

function daemonFetch(): typeof fetch {
  const app = new Hono();
  app.route("/api/telemetry", telemetryRoutes({ db: () => db, nowIso: () => NOW }));
  return (async (url: string, init?: RequestInit) => {
    const u = new URL(String(url));
    trace.push(`${init?.method ?? "GET"} ${u.pathname}${u.search}`);
    const forced = override?.(u.pathname);
    if (forced) return forced;
    return app.request(u.pathname + u.search, init);
  }) as unknown as typeof fetch;
}
async function read(): Promise<CostRead> { return { status: await readUsageCost(daemonFetch(), "http://fixture", { authorization: "Bearer t" }) }; }
const text = (r: CostRead, width = 4000) => costLines(r, width).map((l) => l.text).join("\n");
const served = async () => (await (await daemonFetch()("http://fixture" + COST_ROUTE)).json()) as { seats: Array<Record<string, any>>; note: string };

describe("System → Cost: the presenter over the daemon's cost route", () => {
  it("each seat's first line is the line rig usage cost prints for the same response", async () => {
    const body = await served();
    expect(body.seats.map((s) => s.seatSession).sort()).toEqual(["dev-claude@r", "dev-codex@r", "dev-pi@r", "misc@r", "old-claude@r", "quiet-claude@r", "tiny-claude@r"]);
    const out = text(await read()).split("\n").map((l) => l.trim());
    for (const seat of body.seats) {
      expect(costHeadLine(seat as never)).toBe(costLine(seat as never));
      expect(out).toContain(costLine(seat as never));
    }
    expect(out).toContain(body.note);
  });

  it("shows every served kind, source, coverage, reason and note verbatim, and each window", async () => {
    const body = await served();
    const out = text(await read());
    const strings: string[] = [];
    const walk = (v: unknown, k = "") => {
      if (typeof v === "string" && ["kind", "source", "coverage", "reason", "note", "nativeSessionId", "piSessionId", "since", "asOf"].includes(k)) strings.push(v);
      else if (Array.isArray(v)) v.forEach((x) => walk(x, k));
      else if (v && typeof v === "object") for (const [kk, vv] of Object.entries(v)) walk(vv, kk);
    };
    walk(body);
    expect(strings.length).toBeGreaterThan(20);
    for (const s of strings) expect(out).toContain(s);
    // every unavailable and not-covered reason the charge carries, with its count
    expect(out).toContain("unavailable: not available after 5 lookups (last: HTTP 404) (1)");
    expect(out).toContain("not covered: Pi's anthropic-messages API: its response id isn't a documented OpenRouter generation id (1)");
  });

  it("Claude: the cumulative estimate for its native session, with its reset count, and an old one marked stale, never $0", async () => {
    const out = text(await read());
    expect(out).toContain(`dev-claude@r  $0.45 client-side estimate (Claude statusline) for session s1 since ${at(52)}, as of ${at(58)}, 1 reset`);
    expect(out).toContain("tiny-claude@r  <$0.01 client-side estimate (Claude statusline) for session s2");
    expect(out).toContain("resets in this session: 1 · fresh (");
    expect(out).toMatch(/old-claude@r {2}\$1\.50 client-side estimate .*STALE \(\d+s old; kept as history\)/);
    expect(out).toContain("stale: 3600s old, kept as history");
    expect(out).toContain("quiet-claude@r  cost: not reported (Claude's statusline has reported no cost for this session)");
  });

  it("Codex: tokens and the method's no-cost note, and no dollars", async () => {
    const lines = text(await read()).split("\n");
    const at0 = lines.findIndex((l) => l.includes("dev-codex@r"));
    const block = lines.slice(at0, lines.findIndex((l, i) => i > at0 && /^ {2}\S/.test(l)));
    expect(block[0]).toContain("tokens in 4000 / out 300  cost:");
    expect(block.join("\n")).not.toContain("$");
  });

  it("Pi: own, inherited and unknown kept apart; the OpenRouter charge beside its estimate, never added; tiny money not zero", async () => {
    const out = text(await read());
    expect(out).toContain("dev-pi@r  $0.08 model-priced estimate (Pi persisted entries, 5 own entries) for Pi session pi-s1");
    expect(out).toContain("1 inherited from the fork, not counted ($0.20); 1 of unknown origin, not counted ($0.03)");
    expect(out).toContain("own 5 (counted; 1 without a cost, 1 error/aborted) · inherited 1 ($0.20) and unknown origin 1 ($0.03): shown apart, not counted");
    expect(out).toContain("provider charge, beside the estimate and never added to it: partial · $0.01 USD (Pi's estimate for the same requests: $0.01)");
    expect(out).toContain("requests: 5 OpenRouter · 4 covered · 2 charged · 1 pending · 1 unavailable · 1 not covered");
    expect(out).toContain("account context: credential OPENROUTER_API_KEY (forwarded by OpenRig; Pi's credential observed before and after the request) · workspace ws-1 · BYOK requests 0");
    expect(out).not.toContain("$0.00");
    expect(formatUsd(0.0004)).toBe("<$0.01");
    expect(formatUsd(0)).toBe("$0.00"); // a real zero still reads as zero
  });

  it("partial, pending, unavailable, none and not-covered charge states, as served", async () => {
    const seat = (providerCharge: Record<string, unknown>) => ({ seatSession: "p@r", runtime: "pi", status: "reported", costUsd: 0.2,
      kind: "model-priced estimate", source: "Pi persisted session entries (usage.cost.total)", window: { piSessionId: "s", since: at(1), asOf: at(2) },
      entries: { own: 2 }, tokens: { input: 1, output: 1 }, providerCharge: { kind: "provider charge", source: "OpenRouter GET /api/v1/generation (data.total_cost, USD)", ...providerCharge } });
    const body = { seats: [
      seat({ status: "pending", requests: { openRouter: 2, covered: 2, charged: 0, pending: 2, unavailable: { count: 0, reasons: {} }, notCovered: { count: 0, reasons: {} } }, accountContext: {} }),
      seat({ status: "unavailable", requests: { openRouter: 1, covered: 1, charged: 0, pending: 0, unavailable: { count: 1, reasons: { "the generating credential isn't established: x": 1 } }, notCovered: { count: 0, reasons: {} } }, accountContext: { credentialSources: ["not established"] } }),
      seat({ status: "not-applicable", requests: { openRouter: 0, covered: 0, charged: 0, pending: 0, unavailable: { count: 0, reasons: {} }, notCovered: { count: 0, reasons: {} } }, accountContext: {} }),
    ], note: "n" };
    override = (p) => (p === COST_ROUTE ? Response.json(body) : null);
    const out = text(await read());
    for (const s of body.seats) expect(out.split("\n").map((l) => l.trim())).toContain(costLine(s as never));
    expect(out).toContain("never added to it: pending · no charge established");
    expect(out).toContain("never added to it: unavailable · no charge established");
    expect(out).toContain("unavailable: the generating credential isn't established: x (1)");
    expect(out).toContain("account context: credential not established");
  });

  it("no seats, a 404 (an older daemon), a 503, no answer, or not a cost view: each says so", async () => {
    db.exec("DELETE FROM usage_samples; DELETE FROM pi_usage_charges; DELETE FROM pi_usage_entries;");
    expect(text(await read())).toContain("no usage samples yet: no seat has reported tokens or cost");
    override = () => new Response("Not Found", { status: 404 });
    expect(text(await read())).toContain("This daemon doesn't serve the cost view (no /api/telemetry/usage/cost: HTTP 404).");
    override = () => Response.json({ error: "telemetry_unavailable" }, { status: 503 });
    expect(text(await read())).toContain("Cost unavailable: telemetry_unavailable. Nothing is inferred from the missing read.");
    override = () => Response.json({ rows: [] });
    expect(text(await read())).toContain("Cost unavailable: the response was not a cost view.");
    const down = { status: await readUsageCost((async () => { throw new Error("connect ECONNREFUSED"); }) as unknown as typeof fetch, "http://x", {}) };
    expect(text(down)).toContain("Cost unavailable: connect ECONNREFUSED.");
    expect(text(undefined as never)).toContain("Not read yet.");
  });

  it("the read is one GET of the cost route, and starts nothing else", async () => {
    await read();
    await read();
    expect(trace).toEqual([`GET ${COST_ROUTE}`, `GET ${COST_ROUTE}`]);
    expect(external).not.toHaveBeenCalled();
  });

  it("wraps to narrow terminals without losing a fact", async () => {
    const narrow = costLines(await read(), 60).map((l) => l.text);
    expect(narrow.every((l) => l.length <= 60)).toBe(true);
    expect(narrow.join(" ").replace(/\s+/g, " ")).toContain("not covered: Pi's anthropic-messages API");
  });
});
