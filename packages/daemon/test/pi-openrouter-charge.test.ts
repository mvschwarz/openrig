// OPR.0.7.0.2 (cost reporting, K4): OpenRouter's actual charge for a Pi request, shown beside its labelled Pi
// estimate, tied to that request (Pi's recorded generation id) and the credential that generated it, never added
// to the estimate or counted again on replay or restart. Hermetic: Pi 0.87.1-shaped entries, fixture OpenRouter
// replies, the real runner core, authenticated routes, a migrated SQLite store and the cost view. No network,
// no key, no account.
import { describe, it, expect, afterEach } from "vitest";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { activityRoutes } from "../src/routes/activity.js";
import { computeCostView, type PiProviderChargeView } from "../src/domain/usage-series.js";
import { RunnerCore, parseRunnerArgs, type RunnerIo } from "../src/adapters/pi-runner.js";
import { buildPiRunnerCommand } from "../src/adapters/pi-runner-protocol.js";
import { judgeChargeProvenance, piCredentialEvidence, piCredentialSource, type PiCredentialEvidence, type PiCredentialSource } from "../src/adapters/pi-readiness.js";
import { OpenRouterChargeLookup, openRouterGenerationFetcher, OPENROUTER_CHARGE_MAX_ATTEMPTS, type GenerationReply } from "../src/adapters/pi-openrouter-charge.js";
import { openRouterChargeTarget, parseOpenRouterGeneration } from "../src/domain/openrouter-charge.js";
import { PiUsageEntriesStore, validPiProviderCharge } from "../src/domain/pi-usage-entries-store.js";

const TOKEN = "hook-token";
const SESSION = "devpi-a@rig";
const SESSION_FILE = "/state/pi/devpi-a@rig/sessions/2026_0197.jsonl";
const at = (s: number) => new Date(Date.UTC(2026, 9, 13, 21, 0, s)).toISOString();
const usage = (cost: number) => ({ input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } });
const turn = (id: string, s: number, opts: { cost: number; responseId?: string; api?: string; provider?: string }) => ({
  type: "message", id, parentId: null, timestamp: at(s),
  message: { role: "assistant", api: opts.api ?? "openai-completions", provider: opts.provider ?? "openrouter", model: "z-ai/glm-5.2",
    responseId: opts.responseId, usage: usage(opts.cost), stopReason: "stop" },
});
const ENTRIES = [
  { type: "message", id: "u1", parentId: null, timestamp: at(1), message: { role: "user", content: "hi" } },
  turn("a1", 2, { cost: 0.01, responseId: "gen-1760389202-aaa" }),
  turn("a2", 3, { cost: 0.02, responseId: "gen-1760389203-bbb" }),
  turn("m1", 4, { cost: 0.05, api: "anthropic-messages", responseId: "msg_01XYZ" }), // not a documented generation id
  turn("z1", 5, { cost: 0.07, provider: "zai", responseId: "chatcmpl-1" }), // not OpenRouter
];
const generation = (id: string, total: number, extra: Record<string, unknown> = {}) => ({ status: 200, body: { data: {
  id, total_cost: total, usage: total, upstream_inference_cost: null, cache_discount: 0, is_byok: false, provider_name: "Z.AI",
  model: "z-ai/glm-5.2", api_type: "completions", workspace_id: "ws-fixture", created_at: at(2), ...extra } } });

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const settleAll = async () => { for (let i = 0; i < 12; i += 1) await settle(); };
const MANAGED: PiCredentialSource = { kind: "managed-env", provider: "openrouter", envVar: "OPENROUTER_API_KEY" };

const dbs: Database.Database[] = [];
afterEach(() => { for (const d of dbs.splice(0)) d.close(); });

/** The production pieces wired together; only the OpenRouter replies, the credential source and timers are fixtures. */
function pipeline(opts: {
  replies?: (id: string, attempt: number) => GenerationReply;
  /** Pi's OpenRouter credential source in each observation (launch, then each refresh). */
  source?: () => PiCredentialSource;
  extensions?: () => PiCredentialEvidence["extensions"];
  fingerprint?: () => string;
  db?: Database.Database;
  postChargesOk?: () => boolean;
  openRouterCharge?: boolean;
  header?: string;
} = {}) {
  const d = opts.db ?? (() => { const fresh = createDb(); migrate(fresh, ALL_MIGRATIONS); dbs.push(fresh); return fresh; })();
  const hono = new Hono();
  hono.use("*", async (c, next) => {
    c.set("agentActivityStore" as never, { resolveSession: () => ({ sessionId: "sid", rigId: "r", nodeId: "node-1", sessionName: SESSION, runtime: "pi" }) } as never);
    c.set("activityHookToken" as never, TOKEN as never);
    c.set("sessionRegistry" as never, { db: d } as never);
    await next();
  });
  hono.route("/api/activity", activityRoutes);
  const post = (path: string, body: unknown, token = TOKEN) => hono.request(`/api/activity/${path}`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  const lookups: string[] = [];
  const attempts = new Map<string, number>();
  const timers: Array<() => void> = [];
  // Observations: the first (at start) is before every fixture entry; later ones fall between the entries.
  let observations = 0;
  const evidence = (): PiCredentialEvidence => ({
    at: Date.parse(observations++ === 0 ? at(0) : at(1)),
    source: (opts.source ?? (() => MANAGED))(), extensions: (opts.extensions ?? (() => "none"))(), fingerprint: (opts.fingerprint ?? (() => "same"))(),
  });
  const notices: string[] = [];
  const newLookup = () => new OpenRouterChargeLookup({
    fetchGeneration: async (id) => {
      lookups.push(id);
      const n = (attempts.get(id) ?? 0) + 1;
      attempts.set(id, n);
      return (opts.replies ?? ((gid) => generation(gid, gid.endsWith("aaa") ? 0.012 : 0.03)))(id, n);
    },
    postCharges: async (piSessionId, charges) => {
      if (opts.postChargesOk && !opts.postChargesOk()) return false;
      const res = await post("pi-usage-charges", { sessionName: SESSION, nodeId: "node-1", piSessionId, charges });
      return res.ok ? new Set(((await res.json()) as { acknowledged: string[] }).acknowledged) : false;
    },
    schedule: (fn) => { timers.push(fn); },
    notice: (line) => { notices.push(line); },
  });
  let lookup = newLookup();
  const io: RunnerIo = {
    sendRpc: () => {}, mirrorLine: () => {}, mirrorAppend: () => {}, postActivity: () => {}, writeSidecar: () => {},
    sessionFileExists: () => true, now: () => at(0),
    readFirstLine: () => opts.header ?? JSON.stringify({ type: "session", version: 3, id: "0197a2f0", timestamp: at(0), cwd: "/w" }),
    postUsageFacts: async (payload) => {
      const res = await post("pi-usage", payload);
      if (!res.ok) return false;
      return { charged: ((await res.json()) as { charged?: string[] }).charged ?? [] };
    },
    enqueueChargeLookups: (piSessionId, items, charged) => lookup.enqueue(piSessionId, items, charged),
    credentialEvidence: evidence,
  };
  const start = () => {
    const core = new RunnerCore(io, { sessionName: SESSION, nodeId: "node-1" },
      { usageFacts: true, runtime: "pi", openRouterCharge: opts.openRouterCharge ?? true });
    core.start();
    core.handlePiLine(JSON.stringify({ type: "response", id: "pi-runner-get-state", success: true, data: { sessionFile: SESSION_FILE, sessionId: "0197a2f0" } }));
    return core;
  };
  let core = start();
  const refresh = async (entries: unknown[] = ENTRIES) => {
    core.handlePiLine(JSON.stringify({ type: "response", id: "pi-runner-cursor-refresh", success: true, command: "get_entries", data: { entries, leafId: null } }));
    await settleAll();
  };
  const restart = () => { observations = 0; lookup = newLookup(); core = start(); }; // a new runner process: nothing remembered in memory
  const runTimers = async () => { for (const fn of timers.splice(0)) fn(); await settleAll(); };
  const seat = () => computeCostView(d, { nowIso: at(60) }).seats[0] as Record<string, any>;
  const charge = () => seat().providerCharge as PiProviderChargeView;
  const rows = () => d.prepare("SELECT entry_id, generation_id, status, total_cost_usd, reason, credential_source FROM pi_usage_charges ORDER BY entry_id").all();
  return { d, post, lookups, timers, notices, refresh, restart, runTimers, seat, charge, rows };
}

describe("K4: the request's OpenRouter charge beside its Pi estimate", () => {
  it("each own OpenRouter completion is looked up by the generation id Pi recorded, and shown beside, never added to, the estimate", async () => {
    const p = pipeline();
    await p.refresh();
    expect(p.lookups).toEqual(["gen-1760389202-aaa", "gen-1760389203-bbb"]); // not the anthropic-messages id, not zai
    const seat = p.seat();
    expect(seat.costUsd).toBeCloseTo(0.01 + 0.02 + 0.05 + 0.07, 10); // the estimate is unchanged by any charge
    expect(p.charge()).toMatchObject({
      kind: "provider charge", source: "OpenRouter GET /api/v1/generation (data.total_cost, USD)", status: "reported",
      requests: { openRouter: 3, covered: 2, charged: 2, pending: 0, unavailable: { count: 0 },
        notCovered: { count: 1, reasons: { "Pi's anthropic-messages API: its response id isn't a documented OpenRouter generation id": 1 } } },
      accountContext: { credentialSources: ["OPENROUTER_API_KEY (forwarded by OpenRig; Pi's credential observed before and after the request)"], workspaceIds: ["ws-fixture"], byokRequests: 0 },
    });
    expect(p.charge().costUsd).toBeCloseTo(0.042, 10);
    expect(p.charge().estimateForChargedUsd).toBeCloseTo(0.03, 10); // Pi's estimate for exactly those two requests
  });

  it("replay and restart: a repeated refresh or a new runner never looks up or stores a charge again", async () => {
    const p = pipeline();
    await p.refresh();
    await p.refresh();
    p.restart(); // a new runner process: catch-up posts the same entries again
    await p.refresh();
    expect(p.lookups).toHaveLength(2);
    expect(p.rows()).toHaveLength(2);
    expect(p.charge().costUsd).toBeCloseTo(0.042, 10);
  });

  it("a fork's inherited request is the parent occupant's: never looked up here", async () => {
    const p = pipeline({ header: JSON.stringify({ type: "session", version: 3, id: "0197a2f0", timestamp: at(2) + "", cwd: "/w", parentSession: "/p.jsonl" }) });
    await p.refresh(ENTRIES.filter((e) => e.id !== "a1")); // a2 (after the header) is own; nothing before it ties
    await p.refresh([{ type: "message", id: "u0", parentId: null, timestamp: at(1), message: { role: "user", content: "x" } },
      turn("old", 1, { cost: 0.4, responseId: "gen-parent-1" }), ...ENTRIES.filter((e) => e.id !== "a1")]);
    expect(p.lookups).not.toContain("gen-parent-1");
    expect(p.lookups).toContain("gen-1760389203-bbb");
  });

  it("not there yet (404, timeout, 429, 5xx): pending, retried later, then charged; the estimate stays meanwhile", async () => {
    const p = pipeline({ replies: (id, n) => n === 1 ? { status: 404, body: null } : n === 2 ? { error: "timeout" } : generation(id, 0.5) });
    await p.refresh([turn("a1", 2, { cost: 0.01, responseId: "gen-x-1" })]);
    expect(p.seat()).not.toHaveProperty("providerCharge"); // no outcome yet: the view is the estimate alone
    await p.runTimers();
    expect(p.seat()).not.toHaveProperty("providerCharge");
    await p.runTimers();
    expect(p.charge()).toMatchObject({ status: "reported", costUsd: 0.5, requests: { charged: 1, pending: 0 } });
    expect(p.seat().costUsd).toBeCloseTo(0.01, 10);
  });

  it("lookup failure says unavailable, with the reason, and keeps the estimate; ordinary work continues", async () => {
    const cases: Array<[string, (id: string, n: number) => GenerationReply, string]> = [
      ["never found", () => ({ status: 404, body: null }), `not available after ${OPENROUTER_CHARGE_MAX_ATTEMPTS} lookups (last: HTTP 404)`],
      ["refused", () => ({ status: 401, body: null }), "the generating key can't read this generation (HTTP 401)"],
      ["malformed", () => ({ status: 200, body: { data: { id: "gen-x-1", total_cost: "free" } } }), "malformed reply: no total_cost"],
      ["not JSON", () => ({ status: 200, body: null }), "malformed reply"],
      ["another generation", () => generation("gen-other", 0.5), "the reply names a different generation"],
      ["network down", () => ({ error: "network" }), `not available after ${OPENROUTER_CHARGE_MAX_ATTEMPTS} lookups (last: network)`],
    ];
    for (const [, replies, reason] of cases) {
      const p = pipeline({ replies });
      await p.refresh([turn("a1", 2, { cost: 0.01, responseId: "gen-x-1" })]);
      for (let i = 0; i < OPENROUTER_CHARGE_MAX_ATTEMPTS; i += 1) await p.runTimers();
      expect(p.charge()).toMatchObject({ status: "unavailable", requests: { unavailable: { count: 1, reasons: { [reason]: 1 } } } });
      expect(p.charge()).not.toHaveProperty("costUsd");
      expect(p.seat()).toMatchObject({ status: "reported" });
      expect(p.seat().costUsd).toBeCloseTo(0.01, 10);
      expect(p.lookups.length).toBeLessThanOrEqual(OPENROUTER_CHARGE_MAX_ATTEMPTS);
    }
  });

  it("account context: with a credential OpenRig doesn't hold (stored sign-in or key, models.json, unknown), nothing is looked up", async () => {
    for (const kind of ["stored-sign-in", "stored-key", "models-key", "unknown"] as const) {
      const source: PiCredentialSource = kind === "unknown" ? { kind } : { kind, provider: "openrouter" };
      const p = pipeline({ source: () => source });
      await p.refresh();
      expect(p.lookups).toEqual([]);
      expect(p.charge()).toMatchObject({ status: "unavailable", requests: { unavailable: { count: 2, reasons: {
        [`the generating credential isn't established: Pi's OpenRouter credential around the request was ${kind}, not the key OpenRig forwarded`]: 2 } } } });
      expect(p.charge().accountContext.credentialSources).toEqual(["not established"]);
    }
  });

  it("F1: provenance comes from the observations around the request, never from a later read", async () => {
    // A stored key at the request (first observation), removed before the lookup: never charged as the forwarded key.
    let current: PiCredentialSource = { kind: "stored-key", provider: "openrouter" };
    const p = pipeline({ source: () => current });
    current = MANAGED; // launch saw the stored key; the refresh after the request sees the env key
    await p.refresh([turn("a1", 2, { cost: 0.01, responseId: "gen-x-1" })]);
    expect(p.lookups).toEqual([]);
    expect(p.charge().requests.unavailable.reasons).toEqual({
      "the generating credential isn't established: Pi's OpenRouter credential around the request was stored-key, not the key OpenRig forwarded": 1 });
    await p.refresh([turn("a1", 2, { cost: 0.01, responseId: "gen-x-1" })]); // still the first observation's verdict
    expect(p.lookups).toEqual([]);
  });

  it("F1: an extension that could supply the credential, a file that changed, or a request before the runner observed: unavailable", async () => {
    const cases: Array<[Parameters<typeof pipeline>[0], string]> = [
      [{ extensions: () => "present" }, "a Pi extension is configured and could have supplied the credential"],
      [{ extensions: () => "unknown" }, "Pi's extension configuration couldn't be checked"],
      [{ fingerprint: (() => { let n = 0; return () => `v${n++}`; })() }, "Pi's credential or extension files changed around the request"],
    ];
    for (const [opts, reason] of cases) {
      const p = pipeline(opts);
      await p.refresh([turn("a1", 2, { cost: 0.01, responseId: "gen-x-1" })]);
      expect(p.lookups).toEqual([]);
      expect(p.charge().requests.unavailable.reasons).toEqual({ [`the generating credential isn't established: ${reason}`]: 1 });
    }
    const before = pipeline();
    await before.refresh([turn("old", 0, { cost: 0.01, responseId: "gen-old-1" })]); // stamped at the runner's first observation
    expect(before.lookups).toEqual([]);
    expect(before.charge().requests.unavailable.reasons).toEqual({
      "the generating credential isn't established: made before this runner observed Pi's credential; the credential it used is unknown": 1 });
  });

  it("an outcome the daemon didn't store is posted again; only stored outcomes are done", async () => {
    let up = false;
    const p = pipeline({ postChargesOk: () => up });
    await p.refresh([turn("a1", 2, { cost: 0.01, responseId: "gen-x-1" })]);
    expect(p.rows()).toEqual([]);
    up = true;
    await p.refresh([turn("a1", 2, { cost: 0.01, responseId: "gen-x-1" }), turn("a2", 3, { cost: 0.02, responseId: "gen-x-2" })]);
    expect((p.rows() as Array<{ entry_id: string }>).map((r) => r.entry_id)).toEqual(["a1", "a2"]);
    expect(p.lookups).toEqual(["gen-x-1", "gen-x-2"]); // the stored-later outcome wasn't looked up twice
  });

  it("switch off: no lookup, and the cost view is the estimate alone, worded as before", async () => {
    const p = pipeline({ openRouterCharge: false });
    await p.refresh();
    expect(p.lookups).toEqual([]);
    expect(p.seat()).not.toHaveProperty("providerCharge");
    expect(p.seat().coverage).toContain("an OpenRouter actual charge isn't correlated here");
    const reply = await (await p.post("pi-usage", { sessionName: SESSION, piSessionId: "0197a2f0", facts: [] })).json();
    expect(reply).not.toHaveProperty("charged"); // the /pi-usage reply is unchanged for a runner that doesn't look up charges
  });

  it("F2: an entry stored before migration 108 gets its correlation from a verified replay, then its charge is stored", async () => {
    const d = createDb();
    dbs.push(d);
    migrate(d, ALL_MIGRATIONS.filter((m) => m.name !== "108_pi_usage_charges.sql"));
    const legacy = pipeline({ db: d, openRouterCharge: false });
    await legacy.refresh([turn("a1", 2, { cost: 0.01, responseId: "gen-x-1" })]);
    migrate(d, ALL_MIGRATIONS);
    expect(d.prepare("SELECT api, response_id, cost_total, origin FROM pi_usage_entries").get()).toEqual({ api: null, response_id: null, cost_total: 0.01, origin: "own" });
    const p = pipeline({ db: d });
    await p.refresh([turn("a1", 2, { cost: 0.01, responseId: "gen-x-1" })]);
    expect(d.prepare("SELECT api, response_id, cost_total, origin FROM pi_usage_entries").get())
      .toEqual({ api: "openai-completions", response_id: "gen-x-1", cost_total: 0.01, origin: "own" });
    expect(p.rows()).toEqual([expect.objectContaining({ entry_id: "a1", status: "charged", total_cost_usd: 0.03 })]);
    // A replay that doesn't match the stored entry (a different estimate) fills nothing.
    const store = new PiUsageEntriesStore(d);
    d.prepare("UPDATE pi_usage_entries SET api = NULL, response_id = NULL").run();
    const facts = [{ entryId: "a1", parentEntryId: null, entryTimestamp: at(2), kind: "assistant" as const, usageCategory: null, provider: "openrouter",
      model: "m", input: 100, output: 20, cacheRead: 0, cacheWrite: 0, costTotal: 0.99, stopReason: "stop", origin: "own" as const, api: "openai-completions", responseId: "gen-x-1" }];
    store.record({ seatSession: SESSION, nodeId: null, generation: null, piSessionId: "0197a2f0", facts }, at(30));
    expect(d.prepare("SELECT api, response_id FROM pi_usage_entries").get()).toEqual({ api: null, response_id: null });
  });

  it("F2: only what the daemon stored is acknowledged; a refused outcome is posted again a bounded number of times, then noticed", async () => {
    const p = pipeline({ replies: (id) => generation(id, 0.5) });
    await p.refresh([turn("a1", 2, { cost: 0.01, responseId: "gen-x-1" })]);
    // The store refuses a charge whose generation doesn't match the entry; simulate a stored entry that disagrees.
    p.d.prepare("DELETE FROM pi_usage_charges").run();
    p.d.prepare("UPDATE pi_usage_entries SET response_id = 'gen-other'").run();
    p.restart();
    p.d.prepare("UPDATE pi_usage_entries SET response_id = 'gen-other'").run();
    await p.refresh([turn("a1", 2, { cost: 0.01, responseId: "gen-x-1" })]);
    for (let i = 0; i < 6; i += 1) await p.runTimers();
    expect(p.rows()).toEqual([]);
    expect(p.notices.some((line) => line.includes("entry a1 wasn't stored by the daemon"))).toBe(true);
    expect(p.timers).toEqual([]); // bounded: nothing left scheduled
  });

  it("F3: on a quiet seat, an outcome whose post failed is posted again on its own schedule, without another lookup", async () => {
    let up = false;
    const p = pipeline({ postChargesOk: () => up });
    await p.refresh([turn("a1", 2, { cost: 0.01, responseId: "gen-x-1" })]);
    expect(p.rows()).toEqual([]);
    up = true;
    await p.runTimers(); // no new usage fact, no refresh
    expect(p.rows()).toEqual([expect.objectContaining({ entry_id: "a1", status: "charged" })]);
    expect(p.lookups).toEqual(["gen-x-1"]);
    expect(p.timers).toEqual([]);
  });

  it("a reply field that reflects the key is never stored or shown", async () => {
    const key = "sk-or-fixture-secret";
    const fake = (async () => new Response(JSON.stringify(generation("gen-x-1", 0.5, { model: `echo ${key}`, workspace_id: key }).body), { status: 200 })) as unknown as typeof fetch;
    const reply = await openRouterGenerationFetcher(() => key, fake)("gen-x-1");
    const p = pipeline({ replies: () => reply });
    await p.refresh([turn("a1", 2, { cost: 0.01, responseId: "gen-x-1" })]);
    expect(JSON.stringify(p.d.prepare("SELECT * FROM pi_usage_charges").all())).not.toContain(key);
    expect(JSON.stringify(p.seat())).not.toContain(key);
    expect(p.charge()).toMatchObject({ status: "reported", costUsd: 0.5, accountContext: { workspaceIds: [] } });
  });
});

describe("POST /api/activity/pi-usage-charges", () => {
  async function stored() {
    const p = pipeline({ openRouterCharge: false });
    await p.refresh();
    return p;
  }
  const charged = (entryId: string, generationId: string, total: number) => ({ entryId, generationId, status: "charged", totalCostUsd: total,
    credentialSource: "OPENROUTER_API_KEY (forwarded by OpenRig)" });
  const body = (charges: unknown[]) => ({ sessionName: SESSION, piSessionId: "0197a2f0", charges });

  it("a charge is final; an unavailable outcome can become charged; a replay changes nothing", async () => {
    const p = await stored();
    const json = async (charges: unknown[]) => (await p.post("pi-usage-charges", body(charges))).json();
    expect(await json([{ ...charged("a1", "gen-1760389202-aaa", 0), status: "unavailable", totalCostUsd: null, reason: "not available" }]))
      .toMatchObject({ stored: 1 });
    expect(await json([charged("a1", "gen-1760389202-aaa", 0.012)])).toMatchObject({ stored: 1 });
    expect(await json([charged("a1", "gen-1760389202-aaa", 9.99)])).toMatchObject({ stored: 0, unchanged: 1 });
    expect(await json([{ ...charged("a1", "gen-1760389202-aaa", 0), status: "unavailable", totalCostUsd: null, reason: "x" }])).toMatchObject({ stored: 0 });
    expect(p.rows()).toEqual([expect.objectContaining({ entry_id: "a1", status: "charged", total_cost_usd: 0.012 })]);
  });

  it("refuses a charge for an entry not stored for this seat, or for a generation other than the one the entry recorded", async () => {
    const p = await stored();
    const res = await (await p.post("pi-usage-charges", body([charged("nope", "gen-1", 1), charged("a1", "gen-someone-else", 1)]))).json();
    expect(res).toMatchObject({ stored: 0, refused: 2 });
  });

  it("validates each charge; a wrong token, a non-object body or a missing list is refused", async () => {
    const p = await stored();
    const res = await (await p.post("pi-usage-charges", body([{ ...charged("a1", "gen-1760389202-aaa", -1) }, { entryId: "a1" },
      { ...charged("a1", "gen-1760389202-aaa", 1), status: "unavailable", totalCostUsd: null }]))).json();
    expect(res).toMatchObject({ rejected: 3, stored: 0 });
    expect((await p.post("pi-usage-charges", body([charged("a1", "gen-1760389202-aaa", 1)]), "wrong-token")).status).toBe(401);
    expect(p.rows()).toEqual([]);
    expect((await p.post("pi-usage-charges", null)).status).toBe(400);
    expect((await p.post("pi-usage-charges", { sessionName: SESSION, piSessionId: "x" })).status).toBe(400);
  });
});

describe("contract pieces", () => {
  it("only OpenRouter completions with a documented generation id are covered", () => {
    expect(openRouterChargeTarget({ kind: "assistant", provider: "openrouter", api: "openai-completions", responseId: "gen-1-a" })).toEqual({ generationId: "gen-1-a" });
    expect(openRouterChargeTarget({ kind: "assistant", provider: "openrouter", api: "openai-completions", responseId: "chatcmpl-1" })).toHaveProperty("notCovered");
    expect(openRouterChargeTarget({ kind: "assistant", provider: "openrouter", api: "anthropic-messages", responseId: "gen-1" })).toHaveProperty("notCovered");
    expect(openRouterChargeTarget({ kind: "assistant", provider: "openrouter", api: "openai-completions", responseId: "gen-1;rm" })).toHaveProperty("notCovered");
    expect(openRouterChargeTarget({ kind: "usage", provider: "openrouter", api: null, responseId: null })).toHaveProperty("notCovered");
  });

  it("parses OpenRouter's generation reply, checked against the generation asked about", () => {
    expect(parseOpenRouterGeneration(generation("gen-1", 0.25).body, "gen-1")).toMatchObject({ ok: true, fields: {
      totalCostUsd: 0.25, isByok: false, providerName: "Z.AI", workspaceId: "ws-fixture", apiType: "completions" } });
    expect(parseOpenRouterGeneration({ data: [] }, "gen-1")).toEqual({ ok: false, reason: "malformed reply" });
    expect(parseOpenRouterGeneration(generation("gen-1", -1).body, "gen-1")).toEqual({ ok: false, reason: "malformed reply: no total_cost" });
  });

  it("F4/F5: the reply is read within a byte limit and one timeout; a stalled body is a timeout, an incomplete JSON body malformed", async () => {
    const big = "x".repeat(70 * 1024);
    const declared = (async () => new Response(big, { status: 200, headers: { "content-length": String(big.length) } })) as unknown as typeof fetch;
    expect(await openRouterGenerationFetcher(() => "k", declared)("gen-1")).toEqual({ status: 200, tooLarge: true });
    const streamed = (async () => new Response(new ReadableStream({ start(c) { for (let i = 0; i < 80; i += 1) c.enqueue(new TextEncoder().encode("x".repeat(1024))); c.close(); } }), { status: 200 })) as unknown as typeof fetch;
    expect(await openRouterGenerationFetcher(() => "k", streamed)("gen-1")).toEqual({ status: 200, tooLarge: true });
    const stalled = ((_u: string, init: RequestInit) => Promise.resolve(new Response(new ReadableStream({ start(c) {
      c.enqueue(new TextEncoder().encode("{\"data\":"));
      init.signal!.addEventListener("abort", () => c.error(new Error("aborted")));
    } }), { status: 200 }))) as unknown as typeof fetch;
    expect(await openRouterGenerationFetcher(() => "k", stalled, 20)("gen-1")).toEqual({ error: "timeout" });
    const truncated = (async () => new Response("{\"data\":", { status: 200 })) as unknown as typeof fetch;
    expect(await openRouterGenerationFetcher(() => "k", truncated)("gen-1")).toEqual({ status: 200, malformed: true });
    // Through the lookup: too large is a final unavailable; a stalled body takes the capped retry path.
    const large = pipeline({ replies: () => ({ status: 200, tooLarge: true }) });
    await large.refresh([turn("a1", 2, { cost: 0.01, responseId: "gen-x-1" })]);
    expect(large.charge().requests.unavailable.reasons).toEqual({ "reply larger than 65536 bytes": 1 });
    const slow = pipeline({ replies: (id, n) => n < 3 ? { error: "timeout" } : generation(id, 0.2) });
    await slow.refresh([turn("a1", 2, { cost: 0.01, responseId: "gen-x-1" })]);
    await slow.runTimers();
    await slow.runTimers();
    expect(slow.charge()).toMatchObject({ status: "reported", costUsd: 0.2 });
  });

  it("piCredentialEvidence: extensions from Pi's discovery places, settings entries, and a fingerprint that moves with the files", () => {
    const files: Record<string, string> = {};
    const dirs: Record<string, string[]> = {};
    const base = { agentDir: "/agent", cwd: "/work", env: { OPENROUTER_API_KEY: "k" }, now: () => 5,
      statId: (f: string) => (f in files ? `id:${files[f]!.length}` : "absent"),
      listDir: (d: string) => dirs[d] ?? [],
      readFile: (f: string) => { if (!(f in files)) throw Object.assign(new Error("missing"), { code: "ENOENT" }); return files[f]!; } };
    const clean = piCredentialEvidence(base);
    expect(clean).toMatchObject({ at: 5, source: MANAGED, extensions: "none" });
    dirs["/agent/extensions"] = ["proxy.ts"];
    expect(piCredentialEvidence(base).extensions).toBe("present");
    delete dirs["/agent/extensions"];
    dirs["/work/.pi/extensions"] = ["x.js"];
    expect(piCredentialEvidence(base).extensions).toBe("present");
    delete dirs["/work/.pi/extensions"];
    files["/work/.pi/settings.json"] = JSON.stringify({ packages: ["npm:pi-proxy"] });
    expect(piCredentialEvidence(base).extensions).toBe("present");
    files["/work/.pi/settings.json"] = JSON.stringify({ packages: [], theme: "dark" });
    expect(piCredentialEvidence(base).extensions).toBe("none");
    expect(piCredentialEvidence(base).fingerprint).not.toBe(clean.fingerprint);
    files["/agent/settings.json"] = "{nope";
    expect(piCredentialEvidence(base).extensions).toBe("unknown");
    const judged = judgeChargeProvenance(clean, clean, new Date(10).toISOString());
    expect(judged).toMatchObject({ ok: true });
    expect(judgeChargeProvenance(null, clean, new Date(10).toISOString())).toMatchObject({ ok: false });
  });

  it("the production fetcher asks the documented endpoint with the key in the Authorization header only, bounded by a timeout", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fake = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response(JSON.stringify(generation("gen-1-a", 0.1).body), { status: 200 });
    }) as unknown as typeof fetch;
    const reply = await openRouterGenerationFetcher(() => " sk-or-fixture ", fake)("gen-1-a");
    expect(reply).toMatchObject({ status: 200, body: { data: { id: "gen-1-a" } } });
    expect(seen[0]!.url).toBe("https://openrouter.ai/api/v1/generation?id=gen-1-a");
    expect(seen[0]!.init.headers).toEqual({ authorization: "Bearer sk-or-fixture" });
    expect(seen[0]!.init.redirect).toBe("error"); // a redirect never carries the key anywhere
    expect(await openRouterGenerationFetcher(() => undefined, fake)("gen-1-a")).toEqual({ error: "network" });
    const hang = ((_u: string, init: RequestInit) => new Promise((_r, reject) => init.signal!.addEventListener("abort", () => reject(new Error("aborted"))))) as unknown as typeof fetch;
    expect(await openRouterGenerationFetcher(() => "k", hang, 20)("gen-1-a")).toEqual({ error: "timeout" });
    const failing = (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;
    expect(await openRouterGenerationFetcher(() => "k", failing)("gen-1-a")).toEqual({ status: 503, body: null });
  });

  it("the credential source follows Pi's order from metadata only", () => {
    const files = (auth?: unknown, models?: unknown) => (file: string) => {
      if (file.endsWith("auth.json") && auth !== undefined) return JSON.stringify(auth);
      if (file.endsWith("models.json") && models !== undefined) return JSON.stringify(models);
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    };
    const base = { model: "openrouter/x", agentDir: "/agent", env: { OPENROUTER_API_KEY: "k" } };
    expect(piCredentialSource({ ...base, readFile: files() })).toEqual({ kind: "managed-env", provider: "openrouter", envVar: "OPENROUTER_API_KEY" });
    expect(piCredentialSource({ ...base, readFile: files({ openrouter: { type: "api_key", key: "sk" } }) })).toEqual({ kind: "stored-key", provider: "openrouter" });
    expect(piCredentialSource({ ...base, readFile: files({ openrouter: { type: "oauth", access: "a", refresh: "r", expires: 1 } }) })).toEqual({ kind: "stored-sign-in", provider: "openrouter" });
    expect(piCredentialSource({ ...base, readFile: files(undefined, { providers: { openrouter: { apiKey: "sk" } } }) })).toEqual({ kind: "models-key", provider: "openrouter" });
    expect(piCredentialSource({ ...base, readFile: files({ openrouter: { type: "api_key", key: "$KEY" } }) })).toEqual({ kind: "unknown" });
    expect(piCredentialSource({ ...base, env: {}, readFile: files() })).toEqual({ kind: "none", provider: "openrouter", envVar: "OPENROUTER_API_KEY" });
    expect(piCredentialSource({ ...base, readFile: () => "{not json" })).toEqual({ kind: "unknown" });
  });

  it("the launch flag is added only with usage facts and only for Pi; the runner parses it", () => {
    const base = { runnerEntryPath: "/d/pi-runner.js", sessionName: SESSION, stateRoot: "/s", cwd: "/w", trust: "no-approve" as const, launchId: "L" };
    expect(buildPiRunnerCommand({ ...base, usageFacts: true, openRouterCharge: true })).toBe(`${buildPiRunnerCommand(base)} --usage-facts --openrouter-charge`);
    expect(buildPiRunnerCommand({ ...base, usageFacts: false, openRouterCharge: true })).toBe(buildPiRunnerCommand(base));
    expect(buildPiRunnerCommand({ ...base, runtime: "omp", usageFacts: true, openRouterCharge: true })).not.toContain("--openrouter-charge");
    expect(parseRunnerArgs(["--session-name", SESSION, "--state-root", "/s", "--cwd", "/w", "--launch-id", "L", "--no-approve", "--usage-facts", "--openrouter-charge"]).openRouterCharge).toBe(true);
  });

  it("validPiProviderCharge keeps the shape the runner sends", () => {
    expect(validPiProviderCharge({ entryId: "a", generationId: "gen-1", status: "charged", totalCostUsd: 0.1, credentialSource: "X" })).toMatchObject({ status: "charged", totalCostUsd: 0.1 });
    expect(validPiProviderCharge({ entryId: "a", generationId: "gen-1", status: "charged", credentialSource: "X" })).toBeNull();
    expect(validPiProviderCharge({ entryId: "a", generationId: "gen-1", status: "unavailable", credentialSource: "X", reason: "r", totalCostUsd: 5 })).toMatchObject({ totalCostUsd: null });
    expect(validPiProviderCharge([])).toBeNull();
    const store = new PiUsageEntriesStore((() => { const d = createDb(); migrate(d, ALL_MIGRATIONS); dbs.push(d); return d; })());
    expect(store.chargedEntryIds("s", [])).toEqual([]);
  });
});
