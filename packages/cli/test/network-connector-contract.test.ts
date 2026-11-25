// The outbound connector against a recorded hub. Each scenario in fixtures/network-hub/ is the wire traffic between this
// connector and a hub that isn't Core's own (an ordered list of request/response exchanges, with its normalization
// rules), recorded once and made synthetic. A loopback fixture hub answers each request with the next unconsumed exchange
// whose normalized request matches, so a connector change that sends a request such a hub never answered, or reads an
// answer differently, fails here. What the passes do on the local side is asserted as network-connector-hub.test.ts
// asserts it against Core's own hub.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type Database from "better-sqlite3";
import { createDb } from "../../daemon/src/db/connection.js";
import { migrate } from "../../daemon/src/db/migrate.js";
import { ALL_MIGRATIONS } from "../../daemon/src/db/all-migrations.js";
import { EventBus } from "../../daemon/src/domain/event-bus.js";
import { QueueRepository } from "../../daemon/src/domain/queue-repository.js";
import { OutboxHandler } from "../../daemon/src/domain/outbox-handler.js";
import { RigRepository } from "../../daemon/src/domain/rig-repository.js";
import { NetworkBindingStore, readNetworkCredential, type NetworkBinding } from "../../daemon/src/domain/network/network-bindings.js";
import { runNetworkBindingPass, type NetworkConnectorDeps, type NetworkPassResult } from "../../daemon/src/domain/network/network-connector.js";
import { networkHubRequestId, networkRequestBlocker, originateNetworkRequest } from "../../daemon/src/domain/network/network-requests.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "network-hub");
/** The participant's bearer, given to the binding; the fixtures name it <TOKEN>. */
const TOKEN = "contract-test-token";

interface Exchange {
  pass: number;
  required: boolean;
  note?: string;
  request: { method: string; path: string; headers: { authorization?: string }; body: unknown };
  response: { status: number; headers: Record<string, string>; body: unknown };
}
interface Fixture {
  scenario: string;
  participant: { hubSeat: string; token: string };
  normalize: {
    match: Array<keyof NormalizedRequest>;
    argumentsFor: string[];
    replace: Array<{ name: string; pattern: string; with: string; bind?: boolean }>;
    response: { jsonrpcId: "echo-request"; substitute: string[] };
  };
  passes: Array<{ pass: number; does: string }>;
  exchanges: Exchange[];
}
interface NormalizedRequest { method: string; path: string; authorization: string | null; rpcMethod: string | null; tool: string | null; arguments: unknown }

const loadFixture = (scenario: string): Fixture => JSON.parse(fs.readFileSync(path.join(FIXTURES, `${scenario}.json`), "utf8")) as Fixture;

/** A loopback hub that serves one fixture's recorded answers, one pass at a time. */
class FixtureHub {
  private server: http.Server | null = null;
  private readonly consumed = new Set<Exchange>();
  /** Values bound by `bind` rules, by placeholder: what this run's connector sent for it. */
  readonly bound = new Map<string, string>();
  readonly unmatched: Array<{ pass: number; request: NormalizedRequest; nearest: NormalizedRequest | null }> = [];
  pass = 0;
  origin = "";

  constructor(readonly fixture: Fixture) {}

  get url(): string { return `${this.origin}/mcp`; }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => this.answer(req, Buffer.concat(chunks).toString("utf8"), res));
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.origin = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async close(): Promise<void> {
    if (!this.server) return;
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
  }

  /** The request as the fixture's rules compare it: its `replace` rules applied to every string, and the bearer named. */
  normalize(method: string, urlPath: string, authorization: string | undefined, body: unknown, bind: boolean): NormalizedRequest {
    const { replace, argumentsFor, match } = this.fixture.normalize;
    const str = (value: string) => replace.reduce((out, rule) => out.replace(new RegExp(rule.pattern, "g"), (found) => {
      if (!rule.bind || found === rule.with) return rule.with;
      const known = this.bound.get(rule.with);
      if (known === undefined && bind) this.bound.set(rule.with, found);
      return known === undefined || known === found ? rule.with : `${rule.with}(another: ${found})`;
    }), value.split(TOKEN).join("<TOKEN>"));
    const deep = (value: unknown): unknown => typeof value === "string" ? str(value)
      : Array.isArray(value) ? value.map(deep)
      : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, deep(v)])) : value;
    const rpc = (body && typeof body === "object" ? body : {}) as { method?: string; params?: { name?: string; arguments?: unknown } };
    const rpcMethod = rpc.method ?? null;
    const full: NormalizedRequest = {
      method, path: urlPath, authorization: authorization === undefined ? null : str(authorization), rpcMethod,
      tool: rpcMethod === "tools/call" ? rpc.params?.name ?? null : null,
      arguments: rpcMethod !== null && argumentsFor.includes(rpcMethod) ? deep(rpc.params?.arguments ?? null) : null,
    };
    return Object.fromEntries(match.map((field) => [field, full[field]])) as unknown as NormalizedRequest;
  }

  private recorded(exchange: Exchange): NormalizedRequest {
    return this.normalize(exchange.request.method, exchange.request.path, exchange.request.headers.authorization, exchange.request.body, false);
  }

  private answer(req: http.IncomingMessage, text: string, res: http.ServerResponse): void {
    let body: unknown = "";
    try { body = text ? JSON.parse(text) : ""; } catch { body = text; }
    const request = this.normalize(req.method ?? "", new URL(req.url ?? "/", this.origin).pathname, req.headers.authorization, body, true);
    const open = this.fixture.exchanges.filter((x) => x.pass === this.pass && !this.consumed.has(x));
    const hit = open.find((x) => JSON.stringify(this.recorded(x)) === JSON.stringify(request));
    if (!hit) {
      // The closest recorded request still open in this pass, for the diff: the same call, else the same JSON-RPC method.
      const nearest = open.find((x) => { const r = this.recorded(x); return r.rpcMethod === request.rpcMethod && r.tool === request.tool; })
        ?? open.find((x) => this.recorded(x).method === request.method) ?? null;
      this.unmatched.push({ pass: this.pass, request, nearest: nearest ? this.recorded(nearest) : null });
      res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: "no_recorded_exchange", request }));
      return;
    }
    this.consumed.add(hit);
    const { jsonrpcId, substitute } = this.fixture.normalize.response;
    const values: Record<string, string> = { "<HUB_ORIGIN>": this.origin };
    for (const [name, value] of this.bound) values[name] = value;
    const fill = (value: string) => substitute.reduce((out, name) => values[name] === undefined ? out : out.split(name).join(values[name]), value);
    let payload = hit.response.body;
    // Our ids aren't the recorded ones: an answer carries the id of the request it answers.
    if (jsonrpcId === "echo-request" && payload && typeof payload === "object" && "id" in payload && body && typeof body === "object" && "id" in body) {
      payload = { ...payload, id: (body as { id: unknown }).id };
    }
    const headers = Object.fromEntries(Object.entries(hit.response.headers).map(([k, v]) => [k, fill(v)]));
    res.writeHead(hit.response.status, headers).end(payload === "" ? undefined : fill(JSON.stringify(payload)));
  }

  /** After a pass: every request matched a recorded one, and every required exchange of the pass was answered. */
  verify(pass: number): void {
    for (const miss of this.unmatched.filter((m) => m.pass === pass)) {
      expect(miss.request, `${this.fixture.scenario} pass ${pass}: a request no recorded exchange matches (expected: the closest one still open)`).toEqual(miss.nearest);
    }
    const left = this.fixture.exchanges.filter((x) => x.pass === pass && x.required && !this.consumed.has(x));
    expect(left.map((x) => this.recorded(x)), `${this.fixture.scenario} pass ${pass}: recorded exchanges the connector never sent`).toEqual([]);
  }
}

let localDb: Database.Database;
let localHome: string;
let localRepo: QueueRepository;
let bindings: NetworkBindingStore;
let deps: NetworkConnectorDeps;
let hub: FixtureHub | null = null;

beforeEach(() => {
  localHome = fs.mkdtempSync(path.join(os.tmpdir(), "network-contract-"));
  localDb = createDb(":memory:");
  migrate(localDb, ALL_MIGRATIONS);
  localRepo = new QueueRepository(localDb, new EventBus(localDb), { validateRig: () => true, loadHumanRegistry: () => ({ ok: true as const, entities: [] }) });
  localRepo.attachOutbox(new OutboxHandler(localDb));
  const rigs = new RigRepository(localDb);
  const node = rigs.addNode(rigs.createRig("lab").id, "impl", { runtime: "claude-code" });
  localDb.prepare("INSERT INTO sessions (id, node_id, session_name, status) VALUES ('s1', ?, 'dev-impl@lab', 'running')").run(node.id);
  bindings = new NetworkBindingStore(localDb, localHome);
  deps = { db: localDb, queueRepo: localRepo, bindings, home: localHome };
});

afterEach(async () => {
  await hub?.close();
  hub = null;
  localDb.close();
  fs.rmSync(localHome, { recursive: true, force: true });
});

/** Start the scenario's hub and bind the local seat to it as the fixture's participant. */
async function connect(scenario: string): Promise<{ hub: FixtureHub; binding: NetworkBinding; pass: (n: number) => Promise<NetworkPassResult> }> {
  const fixture = loadFixture(scenario);
  hub = new FixtureHub(fixture);
  await hub.start();
  // The fixture hub listens on loopback http, so the binding records the person's --allow-http choice.
  const binding = bindings.create({ session: "dev-impl@lab", hubUrl: hub.url, hubSeat: fixture.participant.hubSeat, token: TOKEN, allowHttp: true });
  const served = hub;
  const pass = async (n: number) => {
    served.pass = n;
    const result = await runNetworkBindingPass(deps, bindings.get(binding.id)!);
    served.verify(n);
    return result;
  };
  return { hub: served, binding, pass };
}

const receipt = (hubItem: string) => localDb.prepare("SELECT queued_sent_at, pickup_sent_at, settled_at, outcome FROM network_receipts WHERE hub_qitem_id = ?").get(hubItem) as
  { queued_sent_at: string | null; pickup_sent_at: string | null; settled_at: string | null; outcome: string | null } | undefined;

describe("the network connector against a recorded hub", () => {
  it("the fixtures each cover their passes in order, and every exchange is the participant's", () => {
    for (const file of fs.readdirSync(FIXTURES).filter((name) => name.endsWith(".json"))) {
      const fixture = loadFixture(file.replace(/\.json$/, ""));
      expect(fixture.passes.map((p) => p.pass)).toEqual(fixture.passes.map((_, i) => i + 1));
      expect(new Set(fixture.exchanges.map((x) => x.pass))).toEqual(new Set(fixture.passes.map((p) => p.pass)));
      for (const exchange of fixture.exchanges) expect(exchange.request.headers.authorization).toBe(`Bearer ${fixture.participant.token}`);
    }
  });

  it("pass-idle: a pass with nothing to do reads the tool list and both lists, takes nothing, and records contact", async () => {
    const { binding, pass } = await connect("pass-idle");
    const result = await pass(1);
    expect(result.error).toBeUndefined();
    expect(result).toMatchObject({ taken: 0, pickupsSent: 0, resultsSent: 0, unknown: 0 });
    expect(localRepo.list({ limit: 50 })).toHaveLength(0);
    expect(bindings.get(binding.id)).toMatchObject({ state: "active", lastError: null });
    expect(bindings.get(binding.id)!.lastContactAt).not.toBeNull();
  });

  it("inbound-loop: the participant's item is taken locally, its pickup and result go back, and the hub item closes", async () => {
    const { hub: served, binding, pass } = await connect("inbound-loop");
    const first = await pass(1);
    expect(first.error).toBeUndefined();
    expect(first).toMatchObject({ taken: 1, pickupsSent: 0, resultsSent: 0 });
    const [local] = localRepo.list({ limit: 50 });
    expect(local).toMatchObject({ sourceSession: "daemon@kernel", destinationSession: "dev-impl@lab", summary: "From lead@team via network hub: Summarize the notes", state: "pending" });
    expect(local!.body!.split("\n")[0]).toBe(`From lead@team through the network hub ${served.url}, as alex@team (hub item qitem-hub-1).`);
    // The body came from the show: the pending list leaves it out.
    expect(local!.body).toContain("Summarize the release notes. Reply with the word ok.");
    expect(local!.tags).toEqual(expect.arrayContaining([`network-binding:${binding.id}`, "network-hub-item:qitem-hub-1"]));
    expect(receipt("qitem-hub-1")).toMatchObject({ settled_at: null, outcome: null });
    expect(receipt("qitem-hub-1")!.queued_sent_at).not.toBeNull();

    localRepo.claim({ qitemId: local!.qitemId, destinationSession: "dev-impl@lab" });
    await localRepo.update({ qitemId: local!.qitemId, actorSession: "dev-impl@lab", state: "done", closureReason: "no-follow-on", resolution: "ok" });
    const second = await pass(2);
    expect(second.error).toBeUndefined();
    expect(second).toMatchObject({ taken: 0, pickupsSent: 1, resultsSent: 1 });
    expect(receipt("qitem-hub-1")).toMatchObject({ outcome: "done" });
    expect(receipt("qitem-hub-1")!.settled_at).not.toBeNull();
    expect(bindings.get(binding.id)!.lastError).toBeNull();

    expect(await pass(3)).toMatchObject({ taken: 0, pickupsSent: 0, resultsSent: 0 });
    expect(localRepo.list({ limit: 50 })).toHaveLength(1);
    expect(bindings.get(binding.id)).toMatchObject({ state: "active", lastError: null });
  });

  it("outbound-request: a request is created on the hub under its derived id, and the hub's answer closes the local item", async () => {
    const { hub: served, binding, pass } = await connect("outbound-request");
    served.pass = 1;
    const sent = await originateNetworkRequest(deps, bindings.get(binding.id)!, { peer: "lead@team", requestId: "req-1", body: "Review the release notes and answer pong.", summary: "Release notes review" });
    served.verify(1);
    const hubId = networkHubRequestId(binding, "req-1");
    expect(sent).toMatchObject({ localQitemId: "req-1", hubQitemId: hubId, peer: "lead@team", state: "sent" });
    expect(served.bound.get("<REQUEST_ITEM>")).toBe(hubId);
    expect(localRepo.getById("req-1")).toMatchObject({ sourceSession: "dev-impl@lab", state: "blocked", blockedOn: networkRequestBlocker(hubId) });

    const pending = await pass(2);
    expect(pending.error).toBeUndefined();
    expect(localRepo.getById("req-1")!.state).toBe("blocked");

    const answered = await pass(3);
    expect(answered.error).toBeUndefined();
    expect(localRepo.getById("req-1")).toMatchObject({ state: "done", closureReason: "no-follow-on", resolution: "pong" });
    expect(localDb.prepare("SELECT outcome FROM network_requests WHERE local_qitem_id = 'req-1'").get()).toEqual({ outcome: "done" });

    expect((await pass(4)).error).toBeUndefined();
    expect(bindings.get(binding.id)).toMatchObject({ state: "active", lastError: null });
  });

  it("revoked: a 401 with the hub's challenge ends the binding revoked and removes its credential", async () => {
    const { binding, pass } = await connect("revoked");
    expect((await pass(1)).error).toBeUndefined();
    expect(readNetworkCredential(localHome, binding.id, bindings.get(binding.id)!.credentialRevision)).toBe(TOKEN);

    expect(await pass(2)).toMatchObject({ error: "revoked" });
    expect(bindings.get(binding.id)!.state).toBe("revoked");
    expect(() => readNetworkCredential(localHome, binding.id, bindings.get(binding.id)!.credentialRevision)).toThrow();
  });

  it("syncing-503: grant_authority_unavailable leaves the binding active with its credential: setting up at first, then retry later", async () => {
    const { binding, pass } = await connect("syncing-503");
    const credential = () => readNetworkCredential(localHome, binding.id, bindings.get(binding.id)!.credentialRevision);

    // Before any contact: the network is still setting this participant up.
    expect(await pass(1)).toMatchObject({ error: "unavailable", settingUp: true, taken: 0 });
    expect(bindings.get(binding.id)).toMatchObject({ state: "active", lastContactAt: null, lastError: "The network is still finishing setup for this agent. Try again in a moment." });
    expect(credential()).toBe(TOKEN);

    const ready = await pass(2);
    expect(ready.error).toBeUndefined();
    expect(bindings.get(binding.id)).toMatchObject({ state: "active", lastError: null });

    // After contact the same answer is an outage to back off from, never a revoke.
    const again = await pass(3);
    expect(again).toMatchObject({ error: "unavailable" });
    expect(again.settingUp).toBeUndefined();
    expect(bindings.get(binding.id)!.state).toBe("active");
    expect(bindings.get(binding.id)!.lastError).toMatch(/^The hub couldn't be reached: .*grant_authority_unavailable/);
    expect(credential()).toBe(TOKEN);
  });
});
