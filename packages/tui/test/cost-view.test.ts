// Slice 02 — System → Cost: the read and the presenter, against the daemon's own cost route over a real store (and
// plain served JSON for states that store can't hold). Every seat's first line is the line `rig usage cost` prints
// for the same response; every served kind, source, window, coverage, count and reason shows; a charge sits beside
// its estimate and is never added; tiny money never reads as zero; failures and absence say so; and the read is one
// GET of one route, starting nothing.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { costLine } from "../../cli/src/commands/usage.js";
import { DaemonClient } from "../src/daemon-client.js";
import type { CostRead } from "../src/cost/cost-read.js";
import { costLines, costHeadLine, formatUsd } from "../src/cost/cost-model.js";
import { at, costApp, seededDb } from "./helpers/cost-fixture.js";

const COST_ROUTE = "/api/telemetry/usage/cost";

let db: Database.Database;
let trace: string[];
let override: ((path: string) => Response | null) | null;
let external: ReturnType<typeof vi.fn>;

beforeEach(() => {
  db = seededDb();
  trace = [];
  override = null;
  external = vi.fn(() => { throw new Error("unexpected external operation"); });
  vi.stubGlobal("fetch", external);
});
afterEach(() => { vi.unstubAllGlobals(); db.close(); });

function daemonFetch(): typeof fetch {
  const app = costApp(() => db);
  return (async (url: string, init?: RequestInit) => {
    const u = new URL(String(url));
    trace.push(`${init?.method ?? "GET"} ${u.pathname}${u.search}`);
    const forced = override?.(u.pathname);
    if (forced) return forced;
    return app.request(u.pathname + u.search, init);
  }) as unknown as typeof fetch;
}
async function read(): Promise<CostRead> { return { status: await new DaemonClient({ baseUrl: "http://fixture", fetchImpl: daemonFetch(), headers: { authorization: "Bearer t" } }).usageCost() }; }
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
    const down = { status: await new DaemonClient({ baseUrl: "http://x", fetchImpl: (async () => { throw new Error("connect ECONNREFUSED"); }) as unknown as typeof fetch }).usageCost() };
    expect(text(down)).toContain("Cost unavailable: connect ECONNREFUSED.");
    expect(text(undefined as never)).toContain("Not read yet.");
  });

  it("a 200 whose seats aren't all seat objects is not a cost view: null, a number, a string, an array, or a seat without its name or status", async () => {
    for (const bad of [null, 1, "x", [], {}, { seatSession: "a@r" }, { status: "reported" }, { seatSession: 1, status: "reported" }]) {
      override = (p) => (p === COST_ROUTE ? Response.json({ seats: [{ seatSession: "ok@r", status: "absent", reason: "r" }, bad], note: "n" }) : null);
      const r = await read();
      expect(r.status).toEqual({ status: 200, error: "the response was not a cost view" });
      expect(() => costLines(r, 120)).not.toThrow();
      expect(text(r)).toContain("Cost unavailable: the response was not a cost view.");
      expect(text(r)).not.toContain("ok@r");
    }
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
