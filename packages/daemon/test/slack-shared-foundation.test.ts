// The shared Slack foundation, piece by piece: a person's message in a machine-rig channel reaches the
// rig's representative or a configured seat; a person's top-level message becomes the root its answer
// lands under; the hub relays a channel another machine owns, keeps a failed relay and retries it;
// the receiving route takes a relayed envelope; and every post names the machine it comes from.
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { resolveRigRepresentative } from "../src/domain/queue-owner.js";
import { resolveInboundChannelDestination, setChannelMapEntry, validateChannelMap } from "../src/domain/gateway/slack/channel-map.js";
import { makeThreadRouteResolver } from "../src/domain/gateway/slack/thread-routing.js";
import { InboundRouter, handleEnvelope, SLACK_THREAD_ROOT_TAG, type SlackEvent, type SocketEnvelope } from "../src/domain/gateway/slack/inbound.js";
import { SeenStore, DeadLetterStore, type StateFsOps } from "../src/domain/gateway/slack/state-store.js";
import { envelopeChannel, forwardChannelProblems, makeEnvelopeForwarder, FORWARD_PATH } from "../src/domain/gateway/slack/forwarding.js";
import { DEFAULT_CONFIG, staticReadiness } from "../src/domain/gateway/slack/config.js";
import { buildOutboundMessage } from "../src/domain/gateway/slack/message.js";
import { attributionFromSession } from "../src/domain/gateway/slack/message.js";
import { gatewayRoutes } from "../src/routes/gateway.js";

function memFs(): StateFsOps {
  const files = new Map<string, string>();
  return {
    readFileSync: (p) => { if (!files.has(p)) throw new Error("ENOENT"); return files.get(p)!; },
    appendFileSync: (p, d) => files.set(p, (files.get(p) ?? "") + d),
    writeFileSync: (p, d) => files.set(p, d),
    rename: (a, b) => { files.set(b, files.get(a) ?? ""); files.delete(a); },
    mkdirp: () => {},
  };
}
const clock = () => new Date("2026-10-18T08:00:00Z");

describe("a rig's representative", () => {
  function topology() {
    const db = createDb();
    migrate(db, ALL_MIGRATIONS);
    db.prepare("INSERT INTO rigs (id, name) VALUES ('rig-w', 'workshop')").run();
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES ('n-lead', 'rig-w', 'orch.lead')").run();
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES ('n-build', 'rig-w', 'dev.build')").run();
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES ('n-qa', 'rig-w', 'dev.qa')").run();
    db.prepare("INSERT INTO edges (id, rig_id, source_id, target_id, kind) VALUES ('e1', 'rig-w', 'n-lead', 'n-build', 'delegates_to')").run();
    db.prepare("INSERT INTO edges (id, rig_id, source_id, target_id, kind) VALUES ('e2', 'rig-w', 'n-build', 'n-qa', 'delegates_to')").run();
    db.prepare("INSERT INTO sessions (id, node_id, session_name, status) VALUES ('s1', 'n-lead', 'orch-lead@workshop', 'running')").run();
    db.prepare("INSERT INTO sessions (id, node_id, session_name, status) VALUES ('s2', 'n-build', 'dev-build@workshop', 'running')").run();
    return db;
  }

  it("is the rig's one delegation root, at its current session", () => {
    expect(resolveRigRepresentative(topology(), "workshop")).toBe("orch-lead@workshop");
  });

  it("is null when the rig is unknown, ambiguous by name, or has no single root", () => {
    const db = topology();
    expect(resolveRigRepresentative(db, "nope")).toBeNull();
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES ('n-other', 'rig-w', 'orch.second')").run();
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES ('n-other-child', 'rig-w', 'dev.other')").run();
    db.prepare("INSERT INTO edges (id, rig_id, source_id, target_id, kind) VALUES ('e3', 'rig-w', 'n-other', 'n-other-child', 'delegates_to')").run();
    expect(resolveRigRepresentative(db, "workshop")).toBeNull(); // two roots
    const twins = topology();
    twins.prepare("INSERT INTO rigs (id, name) VALUES ('rig-w2', 'workshop')").run();
    expect(resolveRigRepresentative(twins, "workshop")).toBeNull(); // two rigs share the name
  });

  it("is the relaunched rig's lead when an archived earlier generation shares the name, so its channel reaches that lead", () => {
    const db = topology();
    db.prepare("INSERT INTO rigs (id, name, archived_at) VALUES ('rig-w0', 'workshop', '2026-10-17 00:00:00')").run();
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES ('n-first', 'rig-w0', 'orch.first')").run();
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES ('n-first-child', 'rig-w0', 'dev.first')").run();
    db.prepare("INSERT INTO edges (id, rig_id, source_id, target_id, kind) VALUES ('e0', 'rig-w0', 'n-first', 'n-first-child', 'delegates_to')").run();
    db.prepare("INSERT INTO sessions (id, node_id, session_name, status) VALUES ('s0', 'n-first', 'orch-first@workshop', 'stopped')").run();
    expect(resolveRigRepresentative(db, "workshop")).toBe("orch-lead@workshop");
    // The Slack subsystem's own composition, for a person's top-level message in the rig's mapped channel.
    const cfg = { channel: "C0MACHINE", channelMap: [{ match: "workshop", channel: "C0WS" }] };
    expect(resolveInboundChannelDestination(cfg, "C0WS", (rig) => resolveRigRepresentative(db, rig))).toBe("orch-lead@workshop");
    // A name resolves among unarchived rigs only, as the CLI's rig handles do, so archived rigs alone send the message to the
    // inbound destination. An archived rig stays reachable by id and by its threads.
    db.prepare("UPDATE rigs SET archived_at = '2026-10-23 00:00:00' WHERE id = 'rig-w'").run();
    expect(resolveRigRepresentative(db, "workshop")).toBeNull();
  });
});

describe("where a person's new message in a channel goes", () => {
  const rep = (rig: string) => (rig === "workshop" ? "orch-lead@workshop" : null);
  const cfg = (channelMap: Array<{ match: string; channel: string; inbound?: string }>) => ({ channel: "C0MACHINE", channelMap });

  it("a rig's channel reaches its representative, and `inbound` overrides it", () => {
    expect(resolveInboundChannelDestination(cfg([{ match: "workshop", channel: "C0WS" }]), "C0WS", rep)).toBe("orch-lead@workshop");
    expect(resolveInboundChannelDestination(cfg([{ match: "workshop", channel: "C0WS", inbound: "dev-qa@workshop" }]), "C0WS", rep)).toBe("dev-qa@workshop");
  });

  it("the machine's own channel, a seat entry alone, and ambiguous channels fall back to the inbound destination", () => {
    expect(resolveInboundChannelDestination(cfg([{ match: "workshop", channel: "C0WS" }]), "C0MACHINE", rep)).toBeNull();
    expect(resolveInboundChannelDestination(cfg([{ match: "pr@workshop", channel: "C0PR" }]), "C0PR", rep)).toBeNull();
    expect(resolveInboundChannelDestination(cfg([{ match: "workshop", channel: "C0X" }, { match: "factory", channel: "C0X" }]), "C0X", rep)).toBeNull();
    expect(resolveInboundChannelDestination(cfg([{ match: "a@r", channel: "C0X", inbound: "a@r" }, { match: "b@r", channel: "C0X", inbound: "b@r" }]), "C0X", rep)).toBeNull();
    expect(resolveInboundChannelDestination(cfg([{ match: "unknown-rig", channel: "C0U" }]), "C0U", rep)).toBeNull();
  });

  it("a rig entry on the machine's own channel doesn't move that channel's messages; an explicit inbound there still does", () => {
    expect(resolveInboundChannelDestination(cfg([{ match: "workshop", channel: "C0MACHINE" }]), "C0MACHINE", rep)).toBeNull();
    expect(resolveInboundChannelDestination(cfg([{ match: "workshop", channel: "C0MACHINE", inbound: "dev-qa@workshop" }]), "C0MACHINE", rep)).toBe("dev-qa@workshop");
  });

  it("`inbound` must be a seat, and set keeps it", () => {
    expect(() => validateChannelMap({ channel: "C0", channelMap: [{ match: "workshop", channel: "C0WS", inbound: "not-a-seat" }] })).toThrow(/inbound must be a seat/);
    expect(setChannelMapEntry([], { match: "workshop", channel: "C0WS", inbound: "dev-qa@workshop" })).toEqual([{ match: "workshop", channel: "C0WS", inbound: "dev-qa@workshop" }]);
  });

  it("the thread router sends a top-level message there, tagged channel-routed; a thread reply still follows its thread", () => {
    const map = { resolveByThread: () => null, resolveByConversation: () => null, partOf: () => null } as never;
    const route = makeThreadRouteResolver({ map, unroutedDestination: "operator-agent@kernel", resolveChannelDestination: (c) => (c === "C0WS" ? "orch-lead@workshop" : null) });
    expect(route({ type: "message", channel: "C0WS", ts: "1.1" })).toMatchObject({ destination: "orch-lead@workshop", tags: ["founder-slack", "inbound", "channel-routed"] });
    expect(route({ type: "message", channel: "C0MACHINE", ts: "1.2" })).toMatchObject({ destination: "operator-agent@kernel", tags: ["founder-slack", "inbound", "unrouted-signal"] });
    expect(route({ type: "message", channel: "C0WS", ts: "1.3", thread_ts: "0.9" })).toMatchObject({ destination: "operator-agent@kernel", routeClass: "unmapped-thread" });
  });
});

describe("a person's top-level message becomes its answer's root", () => {
  function router(mints: unknown[]) {
    const fs = memFs();
    const rows: Array<{ qitemId: string; tags?: string[]; destination: string }> = [];
    const r = new InboundRouter({
      queue: { createQitem: async (input: { qitemId: string; tags?: string[]; destination: string }) => { rows.push(input); return input.qitemId; } },
      seen: new SeenStore("/s.jsonl", fs, clock),
      deadLetter: new DeadLetterStore<SlackEvent>("/d.jsonl", fs, clock),
      destination: "operator-agent@kernel",
      resolveSender: () => ({ admitted: true, source: "ada@external" }),
      mintThread: (m) => mints.push(m),
    } as never);
    return { r, rows };
  }

  it("mints a root at the message's own ts, for its seat and person, and tags the row", async () => {
    const mints: unknown[] = [];
    const { r, rows } = router(mints);
    await r.route({ type: "message", user: "U1", text: "hi", ts: "500.1", channel: "C0MACHINE" });
    expect(mints).toEqual([{ threadTs: "500.1", channel: "C0MACHINE", human: "ada@external", seat: "operator-agent@kernel", conversationId: rows[0]!.qitemId }]);
    expect(rows[0]!.tags).toContain(SLACK_THREAD_ROOT_TAG);
  });

  it("doesn't mint for a reply inside a thread", async () => {
    const mints: unknown[] = [];
    const { r, rows } = router(mints);
    await r.route({ type: "message", user: "U1", text: "hi", ts: "500.2", thread_ts: "500.1", channel: "C0MACHINE" });
    expect(mints).toEqual([]);
    expect(rows[0]!.tags ?? []).not.toContain(SLACK_THREAD_ROOT_TAG);
  });
});

describe("the hub relays a channel another machine owns", () => {
  function hub(send: (host: string, env: SocketEnvelope) => Promise<{ ok: true } | { ok: false; error: string }>) {
    const fs = memFs();
    const rows: unknown[] = [];
    const forwardDeadLetter = new DeadLetterStore<{ host: string; envelope: SocketEnvelope }>("/f.jsonl", fs, clock);
    const r = new InboundRouter({
      queue: { createQitem: async (input: unknown) => { rows.push(input); return "q"; } },
      seen: new SeenStore("/s.jsonl", fs, clock),
      deadLetter: new DeadLetterStore<SlackEvent>("/d.jsonl", fs, clock),
      destination: "orch-advisor@v-build",
      resolveSender: () => ({ admitted: true, source: "ada@external" }),
      forward: { hostFor: (c: string | undefined) => (c === "C0VPS04" ? "vps04" : null), send },
      forwardDeadLetter,
    } as never);
    return { r, rows, forwardDeadLetter };
  }
  const message = (channel: string): SocketEnvelope => ({ envelope_id: "e1", type: "events_api", payload: { event: { type: "message", user: "U1", text: "hi", ts: "700.1", channel } } });

  it("sends a message, a reaction and a click for that channel there, untouched, and handles nothing here", async () => {
    const sent: Array<[string, SocketEnvelope]> = [];
    const h = hub(async (host, env) => { sent.push([host, env]); return { ok: true }; });
    expect(await handleEnvelope(message("C0VPS04"), () => {}, h.r)).toEqual({ status: "accepted", reason: "forwarded" });
    const reaction: SocketEnvelope = { envelope_id: "e2", type: "events_api", payload: { event: { type: "reaction_added", user: "U1", reaction: "+1", item: { type: "message", channel: "C0VPS04", ts: "1.1" } } } };
    const click: SocketEnvelope = { envelope_id: "e3", type: "interactive", payload: { type: "block_actions", user: { id: "U1" }, channel: { id: "C0VPS04" }, actions: [] } };
    await handleEnvelope(reaction, () => {}, h.r);
    await handleEnvelope(click, () => {}, h.r);
    expect(sent.map(([host, env]) => [host, env.envelope_id])).toEqual([["vps04", "e1"], ["vps04", "e2"], ["vps04", "e3"]]);
    expect(sent[0]![1]).toEqual(message("C0VPS04"));
    expect(h.rows).toEqual([]);
  });

  it("handles its own channels here", async () => {
    const h = hub(async () => { throw new Error("must not relay"); });
    expect((await handleEnvelope(message("C0BUILD"), () => {}, h.r)).status).toBe("accepted");
    expect(h.rows).toHaveLength(1);
  });

  it("keeps a failed relay with its host and retries it there", async () => {
    let up = false;
    const sent: string[] = [];
    const h = hub(async (host) => { sent.push(host); return up ? { ok: true } : { ok: false, error: "network: refused" }; });
    expect(await handleEnvelope(message("C0VPS04"), () => {}, h.r)).toEqual({ status: "dead-lettered", reason: "forward_failed" });
    expect(h.forwardDeadLetter.readAll()).toHaveLength(1);
    up = true;
    expect(await h.r.retryDeadLetters()).toEqual({ retried: 1, landed: 1 });
    expect(sent).toEqual(["vps04", "vps04"]);
    expect(h.forwardDeadLetter.readAll()).toEqual([]);
  });

  it("retries this machine's own events first, then sends one failed host a single relay per pass and keeps the rest unsent", async () => {
    const calls: string[] = [];
    let up = false;
    const fs = memFs();
    const forwardDeadLetter = new DeadLetterStore<{ host: string; envelope: SocketEnvelope }>("/f.jsonl", fs, clock);
    const deadLetter = new DeadLetterStore<SlackEvent>("/d.jsonl", fs, clock);
    const r = new InboundRouter({
      queue: { createQitem: async (input: { qitemId: string }) => { calls.push("local"); if (!up) throw new Error("db busy"); return input.qitemId; } },
      seen: new SeenStore("/s.jsonl", fs, clock),
      deadLetter,
      destination: "orch-advisor@v-build",
      resolveSender: () => ({ admitted: true, source: "ada@external" }),
      forward: {
        hostFor: (c: string | undefined) => (c === "C0A" ? "hostA" : c === "C0B" ? "hostB" : null),
        send: async (host: string) => { calls.push(host); return host === "hostB" && up ? { ok: true } : { ok: false, error: "network: timeout" }; },
      },
      forwardDeadLetter,
    } as never);
    const env = (id: string, channel: string, ts: string): SocketEnvelope =>
      ({ envelope_id: id, type: "events_api", payload: { event: { type: "message", user: "U1", text: "hi", ts, channel } } });
    for (const [id, channel, ts] of [["a1", "C0A", "700.1"], ["a2", "C0A", "700.2"], ["a3", "C0A", "700.3"], ["b1", "C0B", "700.4"], ["l1", "C0BUILD", "700.5"]] as const) {
      await handleEnvelope(env(id, channel, ts), () => {}, r);
    }
    expect(forwardDeadLetter.readAll()).toHaveLength(4);
    expect(deadLetter.readAll()).toHaveLength(1);
    calls.length = 0;
    up = true; // hostB and the local queue recover; hostA stays down
    await r.retryDeadLetters();
    expect(calls).toEqual(["local", "hostA", "hostB"]);
    expect(deadLetter.readAll()).toEqual([]);
    const kept = forwardDeadLetter.readAll();
    expect(kept.map((e) => e.ev.envelope.envelope_id)).toEqual(["a1", "a2", "a3"]);
    expect(kept.map((e) => e.attempts)).toEqual([2, 1, 1]); // only the one relay actually sent counts an attempt
  });

  it("never relays an envelope that was relayed to it", async () => {
    const h = hub(async () => { throw new Error("must not relay again"); });
    expect((await handleEnvelope(message("C0VPS04"), () => {}, h.r, undefined, undefined, { relayed: true })).status).toBe("accepted");
    expect(h.rows).toHaveLength(1);
  });

  it("reads the channel from a message, a reaction or a click", () => {
    expect(envelopeChannel(message("C0A"))).toBe("C0A");
    expect(envelopeChannel({ type: "events_api", payload: { event: { type: "reaction_added", item: { channel: "C0B" } } } })).toBe("C0B");
    expect(envelopeChannel({ type: "interactive", payload: { container: { channel_id: "C0C" } } })).toBe("C0C");
    expect(envelopeChannel({ type: "disconnect" })).toBeUndefined();
  });
});

describe("relaying over the host registry", () => {
  const registry = () => ({ ok: true as const, registry: { hosts: [{ id: "vps04", transport: "http" as const, url: "http://vps04.test:7433", bearer_env: "VPS04_TOKEN" }, { id: "ssh-only", transport: "ssh" as const, target: "x" }] } });

  it("posts the envelope to the host's forwarded route with its bearer", async () => {
    const calls: Array<{ url: string; auth?: string; body: unknown }> = [];
    process.env.VPS04_TOKEN = "tok-test";
    try {
      const send = makeEnvelopeForwarder({
        loadRegistry: registry as never,
        fetchImpl: (async (url: string, init?: RequestInit) => {
          calls.push({ url, auth: (init?.headers as Record<string, string>)?.Authorization, body: JSON.parse(String(init?.body)) });
          return new Response(JSON.stringify({ ok: true, status: "accepted" }), { status: 200 });
        }) as never,
      });
      expect(await send("vps04", { type: "events_api", envelope_id: "e1" })).toEqual({ ok: true });
      expect(calls).toEqual([{ url: `http://vps04.test:7433${FORWARD_PATH}`, auth: "Bearer tok-test", body: { envelope: { type: "events_api", envelope_id: "e1" } } }]);
    } finally {
      delete process.env.VPS04_TOKEN;
    }
  });

  it("reports an unknown host, an ssh-only host and a refusal, so the hub keeps the envelope", async () => {
    const send = makeEnvelopeForwarder({ loadRegistry: registry as never, fetchImpl: (async () => new Response(JSON.stringify({ error: "slack_inbound_unavailable" }), { status: 503 })) as never });
    expect(await send("nope", { type: "events_api" })).toMatchObject({ ok: false, error: expect.stringContaining("unknown host id 'nope'") });
    expect(await send("ssh-only", { type: "events_api" })).toMatchObject({ ok: false, error: expect.stringContaining("no http registry entry") });
    process.env.VPS04_TOKEN = "tok-test";
    try {
      expect(await send("vps04", { type: "events_api" })).toEqual({ ok: false, error: "http 503: slack_inbound_unavailable" });
    } finally {
      delete process.env.VPS04_TOKEN;
    }
  });
});

describe("forwardChannels config", () => {
  it("names what is wrong, and shows a readiness line only when set", () => {
    expect(forwardChannelProblems({})).toEqual([]);
    expect(forwardChannelProblems({ channel: "C0OWN", forwardChannels: [{ channel: "C0OWN", host: "vps04" }, { channel: "C0V", host: "" }, { channel: "C0V", host: "vps05" }] })).toEqual([
      "forwardChannels[0].channel C0OWN is this machine's own channel",
      "forwardChannels[1].host must name a host from `rig host list`",
      "forwardChannels[2].channel C0V is listed twice",
    ]);
    expect(staticReadiness({ ...DEFAULT_CONFIG }, true, true).some((r) => r.label === "forward-channels")).toBe(false);
    const on = staticReadiness({ ...DEFAULT_CONFIG, channel: "C0OWN", forwardChannels: [{ channel: "C0V", host: "vps04" }] }, true, true).find((r) => r.label === "forward-channels");
    expect(on).toMatchObject({ ok: true });
    expect(on!.detail).toContain("1 channel(s) relayed to vps04");
  });
});

describe("the receiving route", () => {
  function app(subsystem: unknown, token: string | null) {
    const a = new Hono();
    a.use("*", async (c, next) => { c.set("gatewaySubsystem" as never, subsystem as never); await next(); });
    a.route("/api/gateway", gatewayRoutes({ relayBearerToken: token }));
    return a;
  }
  const post = (a: Hono, body: unknown, auth?: string) => a.request("/api/gateway/slack/forwarded", {
    method: "POST", headers: { "content-type": "application/json", ...(auth ? { Authorization: auth } : {}) }, body: JSON.stringify(body),
  });

  it("hands the envelope to this machine's connector and returns its disposition", async () => {
    const seen: unknown[] = [];
    const a = app({ acceptForwarded: async (env: unknown) => { seen.push(env); return { status: "accepted" }; } }, "tok");
    const res = await post(a, { envelope: { type: "events_api", envelope_id: "e1" } }, "Bearer tok");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: "accepted" });
    expect(seen).toEqual([{ type: "events_api", envelope_id: "e1" }]);
  });

  it("refuses without the bearer, without an envelope, and with no inbound here (503, so the hub retries)", async () => {
    const a = app({ acceptForwarded: async () => null }, "tok");
    expect((await post(a, { envelope: { type: "events_api" } })).status).toBe(401);
    expect((await post(a, {}, "Bearer tok")).status).toBe(400);
    expect((await post(a, { envelope: { type: "events_api" } }, "Bearer tok")).status).toBe(503);
  });
});

describe("each post names its machine", () => {
  const q = { qitemId: "q1", summary: "Done", body: "Shipped." } as never;

  it("adds the machine after a seat sender, once", () => {
    const local = buildOutboundMessage(q, { sourceLabel: "openrig", attribution: attributionFromSession("operator-agent@kernel"), machine: "vps04" });
    expect(local.text).toContain("From operator-agent@kernel on vps04");
    const remote = buildOutboundMessage(q, { sourceLabel: "openrig", attribution: attributionFromSession("operator-agent@kernel@vps05"), machine: "vps04" });
    expect(remote.text).toContain("From operator-agent@kernel@vps05");
    expect(remote.text).not.toContain(" on vps04");
    const unchanged = buildOutboundMessage(q, { sourceLabel: "openrig", attribution: attributionFromSession("operator-agent@kernel") });
    expect(unchanged.text).toContain("From operator-agent@kernel");
    expect(unchanged.text).not.toContain(" on ");
  });
});
