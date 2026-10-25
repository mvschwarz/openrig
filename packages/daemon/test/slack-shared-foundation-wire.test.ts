// The shared Slack foundation through the REAL wires of two machines in one process: a hub (the
// machine holding the app's Socket Mode connection) and a VPS (bot token only). The hub's fetch
// reaches the VPS's relay route in-process; Slack is faked. Made-up channel IDs and names only.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { makeQueuePorts } from "../src/domain/gateway/slack/queue-access.js";
import { buildSlackGatewayWire } from "../src/domain/gateway/slack/slack-subsystem.js";
import type { WsLike } from "../src/domain/gateway/slack/socket-inbound.js";
import { DEFAULT_CONFIG, saveConfig, type SlackConnectorConfig } from "../src/domain/gateway/slack/config.js";
import { resolveSlackHandle } from "../src/domain/gateway/human-registry.js";
import { setSelfHostId } from "../src/domain/hosts/fanout-contract.js";
import { DeadLetterStore } from "../src/domain/gateway/slack/state-store.js";
import type { SocketEnvelope } from "../src/domain/gateway/slack/inbound.js";

const human = "human-ada@external";
const registry = { ok: true as const, entities: [{ entityId: "human-ada", class: "human" as const, displayName: "Ada", address: human, connectorBindings: [{ kind: "slack" as const, connectorRef: "primary", secretsRef: "env:SLACK_BOT_TOKEN", role: "primary" as const, handle: "UADA" }], prefs: { deliveryClass: "A" as const } }] };
const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

interface Machine { home: string; db: ReturnType<typeof createDb>; repo: QueueRepository; posts: Array<Record<string, unknown>>; wire?: ReturnType<typeof buildSlackGatewayWire> }

describe("one shared Slack app across two machines", () => {
  let hub: Machine;
  let vps: Machine;
  let sockets: WsLike[];
  const stops: Array<() => void> = [];

  const machine = (name: string): Machine => {
    const db = createDb(); migrate(db, ALL_MIGRATIONS);
    return { home: mkdtempSync(join(tmpdir(), `shared-${name}-`)), db, repo: new QueueRepository(db, new EventBus(db), { loadHumanRegistry: () => registry }), posts: [] };
  };
  // Slack's chat.postMessage, per machine: records the post and answers with a fresh ts.
  const slack = (m: Machine) => async (url: string, init?: RequestInit) => {
    if (url.endsWith("apps.connections.open")) return reply({ ok: true, url: "wss://fake-slack/ws" });
    if (url.includes("conversations.history") || url.includes("conversations.replies")) return reply({ ok: true, messages: [], has_more: false });
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    m.posts.push(body);
    return reply({ ok: true, ts: `${m.posts.length}.9` });
  };

  function wireVps(channelMap?: SlackConnectorConfig["channelMap"]): void {
    vps.wire?.stop();
    const secrets = join(vps.home, "fake.env");
    writeFileSync(secrets, "SLACK_BOT_TOKEN=xoxb-EXAMPLE-fake\n"); // no app-level token: the hub holds the connection
    saveConfig({ ...DEFAULT_CONFIG, enabled: true, channel: "C0VPS04", secretsEnvFile: secrets, ...(channelMap ? { channelMap } : {}) }, vps.home);
    vps.wire = buildSlackGatewayWire({ home: vps.home, queueRepo: vps.repo, registry: { loadHumanRegistry: () => registry, resolveSlackHandle }, fetchImpl: slack(vps) });
    stops.push(() => vps.wire?.stop()); vps.wire.startServices?.();
  }

  function wireHub(forwardChannels: SlackConnectorConfig["forwardChannels"] = [{ channel: "C0VPS04", host: "vps04" }, { channel: "C0VPSWS", host: "vps04" }], enabled = true): void {
    hub.wire?.stop();
    sockets = [];
    const secrets = join(hub.home, "fake.env");
    writeFileSync(secrets, "SLACK_BOT_TOKEN=xoxb-EXAMPLE-fake\nSLACK_APP_TOKEN=xapp-EXAMPLE-fake\n");
    saveConfig({
      ...DEFAULT_CONFIG, enabled, channel: "C0BUILD", inboundDestination: "orch-advisor@v-build", secretsEnvFile: secrets,
      forwardChannels,
    }, hub.home);
    hub.wire = buildSlackGatewayWire({
      home: hub.home, queueRepo: hub.repo, registry: { loadHumanRegistry: () => registry, resolveSlackHandle },
      wsFactory: () => { const ws: WsLike = { send: () => {}, close: () => {}, onopen: null, onmessage: null, onclose: null, onerror: null }; sockets.push(ws); return ws; },
      inboundMaxConnects: 1,
      loadHostRegistry: () => ({ ok: true, registry: { hosts: [{ id: "vps04", transport: "http", url: "http://vps04.test" }] } }) as never,
      fetchImpl: async (url, init) => {
        if (url === "http://vps04.test/api/gateway/slack/forwarded") {
          const { envelope } = JSON.parse(String(init?.body)) as { envelope: unknown };
          return reply({ ok: true, ...(await vps.wire!.acceptForwarded!(envelope as never)) });
        }
        return slack(hub)(url, init);
      },
    });
    stops.push(() => hub.wire?.stop()); hub.wire.startServices?.();
  }

  beforeEach(async () => {
    setSelfHostId("vps04"); // one process: both wires read the same host id, so only the VPS's posts are checked for it
    sockets = []; hub = machine("hub"); vps = machine("vps");
    wireVps(); wireHub();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]!.onopen?.();
  });
  afterEach(() => {
    for (const stop of stops.splice(0)) stop();
    setSelfHostId(null);
    for (const m of [hub, vps]) { m.db.close(); rmSync(m.home, { recursive: true, force: true }); }
  });

  // A person's message arrives on the hub's one connection.
  async function say(channel: string, ts: string, user = "UADA", text = "hello"): Promise<void> {
    sockets[0]!.onmessage?.({ data: JSON.stringify({ envelope_id: `e-${ts}`, type: "events_api", payload: { event: { type: "message", user, text, ts, channel } } }) });
    await new Promise((r) => setTimeout(r, 50));
  }
  const inbound = (m: Machine) => m.repo.list({ limit: 100 }).filter((q) => q.tags?.includes("inbound"));
  // A seat answers the person's row with --reply-to, and that machine's connector posts it.
  async function answer(m: Machine, seat: string, replyTo: string, summary: string): Promise<Record<string, unknown>> {
    const before = m.posts.length;
    const u = await m.repo.create({ sourceSession: seat, destinationSession: human, humanIntent: "update", replyTo, summary, body: summary, nudge: false });
    const alert = (await makeQueuePorts(m.repo, { loadHumanRegistry: () => registry }).listHumanAlerts({})).find((q) => q.qitemId === u.qitemId);
    expect(alert).toBeDefined();
    expect(m.wire!.dispatcher.dispatch("post_message", human, alert)).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(m.posts.length).toBeGreaterThan(before));
    return m.posts.at(-1)!;
  }

  it("P1-P2, P5-P6: a machine channel reaches that machine's Kernel Operator; its answer and a later update land in the person's thread, naming the machine", async () => {
    await say("C0VPS04", "700.1");
    await vi.waitFor(() => expect(inbound(vps)).toHaveLength(1));
    expect(inbound(hub)).toEqual([]); // the hub relayed it and kept nothing
    const row = inbound(vps)[0]!;
    expect(row).toMatchObject({ sourceSession: human, destinationSession: "operator-agent@kernel" });
    const first = await answer(vps, "operator-agent@kernel", row.qitemId, "On it");
    expect(first).toMatchObject({ channel: "C0VPS04", thread_ts: "700.1" });
    expect(String(first.text)).toContain("From operator-agent@kernel on vps04");
    const second = await answer(vps, "operator-agent@kernel", row.qitemId, "Done");
    expect(second).toMatchObject({ channel: "C0VPS04", thread_ts: "700.1" });
    expect(hub.posts).toEqual([]);
  });

  it("P3, P7: a machine-rig channel reaches its configured recipient, the answer returns to that channel, and a new recipient takes the next message", async () => {
    wireVps([{ match: "workshop", channel: "C0VPSWS", inbound: "orch-lead@workshop" }]);
    await say("C0VPSWS", "710.1");
    await vi.waitFor(() => expect(inbound(vps)).toHaveLength(1));
    const row = inbound(vps)[0]!;
    expect(row).toMatchObject({ destinationSession: "orch-lead@workshop" });
    expect(row.tags).toContain("channel-routed");
    expect(await answer(vps, "orch-lead@workshop", row.qitemId, "Workshop here")).toMatchObject({ channel: "C0VPSWS", thread_ts: "710.1" });

    wireVps([{ match: "workshop", channel: "C0VPSWS", inbound: "dev-qa@workshop" }]);
    await say("C0VPSWS", "710.2");
    await vi.waitFor(() => expect(inbound(vps)).toHaveLength(2));
    expect(inbound(vps).find((q) => q.qitemId !== row.qitemId)).toMatchObject({ destinationSession: "dev-qa@workshop" });
  });

  it("an answer returns to the channel the person used, even when the seat's own items post elsewhere", async () => {
    wireVps([{ match: "workshop", channel: "C0VPSWS", inbound: "operator-agent@kernel" }]);
    await say("C0VPSWS", "720.1");
    await vi.waitFor(() => expect(inbound(vps)).toHaveLength(1));
    // The operator's own items post to the machine channel; this answer goes back to the rig channel.
    expect(await answer(vps, "operator-agent@kernel", inbound(vps)[0]!.qitemId, "Answer")).toMatchObject({ channel: "C0VPSWS", thread_ts: "720.1" });
  });

  it("P4: the hub's own channel stays on the hub, at its configured recipient", async () => {
    await say("C0BUILD", "730.1");
    await vi.waitFor(() => expect(inbound(hub)).toHaveLength(1));
    expect(inbound(vps)).toEqual([]);
    const row = inbound(hub)[0]!;
    expect(row.destinationSession).toBe("orch-advisor@v-build");
    expect(await answer(hub, "orch-advisor@v-build", row.qitemId, "Seen")).toMatchObject({ channel: "C0BUILD", thread_ts: "730.1" });
  });

  it("reports the local fallback and still routes an unmapped channel to that destination", async () => {
    expect(hub.wire!.status()).toMatchObject({ inboundRouting: { fallback: "local", destination: "orch-advisor@v-build" } });
    await say("C0UNMAPPED", "735.1");
    await vi.waitFor(() => expect(inbound(hub)).toHaveLength(1));
    expect(inbound(hub)[0]!.destinationSession).toBe("orch-advisor@v-build");
    expect(inbound(vps)).toEqual([]);
  });

  it("a machine without its own connection reports that it can take relayed events, and how many have arrived", async () => {
    expect(vps.wire!.status()).toMatchObject({ inboundReady: false, relayedInbound: { accepting: true, received: 0 } });
    expect(vps.wire!.status()).not.toHaveProperty("inboundRelayed");
    await say("C0VPS04", "960.1");
    expect(vps.wire!.status()).toMatchObject({ relayedInbound: { accepting: true, received: 1 } });
    expect(hub.wire!.status()).not.toHaveProperty("relayedInbound");
  });

  it("P8: an unregistered sender is still refused on the machine that owns the channel", async () => {
    await say("C0VPS04", "740.1", "USTRANGER");
    await new Promise((r) => setTimeout(r, 100));
    expect(inbound(vps)).toEqual([]);
    expect(inbound(hub)).toEqual([]);
  });

  it.each(["message", "click", "one-entry-left", "disabled"])("keeps a retained relay visible after removing its mapping, retrying only while enabled (%s)", async (kind) => {
    const envelope: SocketEnvelope = kind === "click"
      ? { envelope_id: "retained-click", type: "interactive", payload: { type: "block_actions", channel: { id: "C0VPS04" }, actions: [] } }
      : { envelope_id: "retained-message", type: "events_api", payload: { event: { type: "message", user: "UADA", text: "retained reply", ts: "970.1", channel: "C0VPS04" } } };
    const store = new DeadLetterStore<{ host: string; envelope: SocketEnvelope }>(join(hub.home, "state/slack-inbound-forward-deadletter.jsonl"));
    store.append({ host: "vps04", envelope }, 1);
    wireHub(kind === "one-entry-left" ? [{ channel: "C0VPSWS", host: "vps04" }] : [], kind !== "disabled");
    expect(hub.wire!.status()).toMatchObject({ deadLetterBacklog: 1, deadLetterBacklogState: "ok" });
    if (kind === "disabled") {
      expect(hub.wire!.status()).toMatchObject({ inboundReady: false, outboundReady: false });
      expect(store.readAll()).toHaveLength(1);
      return;
    }
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]!.onopen?.();
    await vi.waitFor(() => expect(store.readAll()).toEqual([]));
    expect(vps.wire!.status()).toMatchObject({ relayedInbound: { received: 1 } });
    if (kind !== "click") expect(inbound(vps)).toHaveLength(1);
    expect(inbound(hub)).toEqual([]);
  });
});
