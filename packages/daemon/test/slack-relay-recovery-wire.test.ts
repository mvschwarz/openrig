// #739 round 2, through the real wire of a machine without its own Slack connection: it recovers only the channels the hub
// has relayed to it, from the first relayed event's arrival, and keeps that across restarts. Fake Slack, fake clock, made-up IDs.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { buildSlackGatewayWire } from "../src/domain/gateway/slack/slack-subsystem.js";
import { DEFAULT_CONFIG, saveConfig, type SlackConnectorConfig } from "../src/domain/gateway/slack/config.js";
import { slackMicros } from "../src/domain/gateway/slack/state-store.js";
import { resolveSlackHandle } from "../src/domain/gateway/human-registry.js";

const human = "human-ada@external";
const registry = { ok: true as const, entities: [{ entityId: "human-ada", class: "human" as const, displayName: "Ada", address: human, connectorBindings: [{ kind: "slack" as const, connectorRef: "primary", secretsRef: "env:SLACK_BOT_TOKEN", role: "primary" as const, handle: "UADA" }], prefs: { deliveryClass: "A" as const } }] };
const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const BASE = 1_792_000_000;
const ts = (seconds: number) => `${BASE + seconds}.000001`;
const at = (seconds: number) => (BASE + seconds) * 1000;
const message = (channel: string, seconds: number) => ({ type: "message", user: "UADA", text: `message ${seconds}`, ts: ts(seconds), channel });
const MAP: SlackConnectorConfig["channelMap"] = [{ match: "my-rig", channel: "CRELAY" }];

describe("relay recovery through a bot-token-only machine's wire (#739)", () => {
  let home: string;
  let db: ReturnType<typeof createDb>;
  let repo: QueueRepository;
  let wire: ReturnType<typeof buildSlackGatewayWire> | undefined;
  let history: Record<string, Array<ReturnType<typeof message>>>;
  let historyQueries: string[];

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(at(0));
    home = mkdtempSync(join(tmpdir(), "relay-recovery-"));
    db = createDb(); migrate(db, ALL_MIGRATIONS);
    repo = new QueueRepository(db, new EventBus(db), { loadHumanRegistry: () => registry });
    history = {}; historyQueries = [];
  });
  afterEach(() => {
    wire?.stop(); wire = undefined;
    vi.useRealTimers();
    db.close(); rmSync(home, { recursive: true, force: true });
  });

  const fetchImpl = async (url: string) => {
    const u = new URL(url);
    if (u.pathname.endsWith("conversations.history")) {
      const channel = u.searchParams.get("channel")!;
      historyQueries.push(channel);
      const oldest = slackMicros(u.searchParams.get("oldest"))!, latest = slackMicros(u.searchParams.get("latest"))!;
      const messages = (history[channel] ?? []).filter(m => slackMicros(m.ts)! > oldest && slackMicros(m.ts)! < latest)
        .sort((a, b) => slackMicros(a.ts)! < slackMicros(b.ts)! ? 1 : -1);
      return reply({ ok: true, messages, has_more: false });
    }
    if (u.pathname.endsWith("conversations.replies")) return reply({ ok: true, messages: [], has_more: false });
    return reply({ ok: true, ts: "1.1" });
  };
  // A restart is a new wire over the same home and database.
  const build = () => {
    wire?.stop();
    const secrets = join(home, "fake.env");
    writeFileSync(secrets, "SLACK_BOT_TOKEN=xoxb-EXAMPLE-fake\n"); // no app-level token: the hub holds the connection
    saveConfig({ ...DEFAULT_CONFIG, enabled: true, channel: "C0OWN", secretsEnvFile: secrets, channelMap: MAP }, home);
    wire = buildSlackGatewayWire({ home, queueRepo: repo, registry: { loadHumanRegistry: () => registry, resolveSlackHandle }, fetchImpl,
      inboundRetryIntervalMs: 300_000 });
    wire.startServices?.();
  };
  const relay = (channel: string, seconds: number) =>
    wire!.acceptForwarded!({ type: "events_api", payload: { event: message(channel, seconds) } } as never);
  const advanceTo = async (seconds: number) => {
    await vi.advanceTimersByTimeAsync(at(seconds) - Date.now());
    for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(1);
  };
  const delivered = () => repo.list({ limit: 100 }).filter(q => q.sourceSession === human).map(q => q.body);
  const recovery = () => (wire!.status!() as unknown as { recovery: Record<string, unknown> }).recovery;

  it("starts a relayed channel's coverage when its first relayed event arrives, not at the next pass", async () => {
    build();
    await advanceTo(10); await relay("CRELAY", 9);
    history.CRELAY = [message("CRELAY", 20)]; // posted while the hub was away, so never relayed

    await advanceTo(300); // the first pass, at the timer

    expect(delivered()).toHaveLength(2);
    expect(delivered().some(body => body.includes("Recovered after a gap") && body.includes(ts(20)))).toBe(true);
  });

  it("keeps recovering a relayed channel after a restart, with no new relayed event", async () => {
    build();
    await advanceTo(10); await relay("CRELAY", 9);
    await advanceTo(300);
    build();
    history.CRELAY = [message("CRELAY", 400)];

    await advanceTo(900);

    expect(delivered().some(body => body.includes("Recovered after a gap") && body.includes(ts(400)))).toBe(true);
  });

  it("recovers only the channels relayed to it, never its own default channel that the hub doesn't relay", async () => {
    build();
    history.C0OWN = [message("C0OWN", 20), message("C0OWN", 400)];
    await advanceTo(10); await relay("CRELAY", 9);

    await advanceTo(600);

    expect(historyQueries).not.toContain("C0OWN");
    expect(delivered()).toHaveLength(1); // the relayed message itself
    expect(recovery()).toMatchObject({ channel: "C0OWN", state: "waiting", reason: "no-relayed-event-yet" });
  });
});
