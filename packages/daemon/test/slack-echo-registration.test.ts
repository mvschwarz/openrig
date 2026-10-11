// Each post the gateway makes registers its Slack ts with the inbound liveness watch, so a healthy
// connection's echo of it counts. A multipart post's supplemental parts go into the primary's
// thread and reach the subsystem only through onPostedPart; they must register too, or a lost echo
// of one never counts as a miss.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { buildSlackGatewayWire } from "../src/domain/gateway/slack/slack-subsystem.js";
import { makeQueuePorts } from "../src/domain/gateway/slack/queue-access.js";
import { resolveSlackHandle } from "../src/domain/gateway/human-registry.js";
import { DEFAULT_CONFIG, saveConfig } from "../src/domain/gateway/slack/config.js";
import type { WsLike } from "../src/domain/gateway/slack/socket-inbound.js";

const registry = { ok: true as const, entities: [{ entityId: "human-founder", class: "human" as const, displayName: "Founder", address: "human-founder@external", connectorBindings: [{ kind: "slack" as const, connectorRef: "primary", secretsRef: "env:SLACK_BOT_TOKEN", role: "primary" as const, handle: "UFOUNDER" }], prefs: { deliveryClass: "A" as const } }] };
const request = { sourceSession: "author@rig", destinationSession: "human-founder@external", summary: "Release ready", body: "The release is ready. No action needed.", nudge: false };
const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

describe("echo registration for every post", () => {
  let home: string;
  let db: ReturnType<typeof createDb>;
  let repo: QueueRepository;
  const stops: Array<() => void> = [];
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "slack-echo-reg-"));
    db = createDb(); migrate(db, ALL_MIGRATIONS);
    repo = new QueueRepository(db, new EventBus(db), { loadHumanRegistry: () => registry });
  });
  afterEach(() => { for (const stop of stops.splice(0)) stop(); db.close(); rmSync(home, { recursive: true, force: true }); });

  it("registers a multipart post's supplemental part, so its echo alone confirms delivery", async () => {
    const item = await repo.create({ ...request, humanIntent: "update", humanDetail: "Known limit: synthetic delivery.", tags: ["escalation"] });
    const secrets = join(home, "fake.env");
    writeFileSync(secrets, "SLACK_BOT_TOKEN=xoxb-EXAMPLE-fake\nSLACK_APP_TOKEN=xapp-EXAMPLE-fake\n");
    saveConfig({ ...DEFAULT_CONFIG, enabled: true, channel: "C-TEST", secretsEnvFile: secrets, minimumLevelThatInterrupts: "NOTICE" }, home);
    const sockets: WsLike[] = [];
    let posts = 0;
    const wire = buildSlackGatewayWire({
      home, queueRepo: repo, registry: { loadHumanRegistry: () => registry, resolveSlackHandle },
      fetchImpl: async (url) => {
        if (String(url).endsWith("apps.connections.open")) return reply({ ok: true, url: "wss://example.invalid/socket" });
        if (String(url).endsWith("chat.postMessage")) { posts += 1; return reply({ ok: true, ts: `${posts}.000001` }); }
        return reply({ ok: true, messages: [] });
      },
      wsFactory: () => {
        const ws: WsLike = { send: () => {}, close: () => {}, onopen: null, onmessage: null, onclose: null, onerror: null };
        sockets.push(ws);
        return ws;
      },
    });
    stops.push(() => wire.stop());
    wire.startServices?.();
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]!.onopen!();
    const inbound = () => (wire.status?.() as unknown as { inbound: { delivery?: string } }).inbound;
    expect(inbound().delivery).toBe("unknown");

    const [alert] = await makeQueuePorts(repo, { loadHumanRegistry: () => registry }).listHumanAlerts({});
    expect(wire.dispatcher.dispatch("post_message", request.destinationSession, alert)).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(repo.getById(item.qitemId)?.state).toBe("done"));
    expect(posts, "a primary and one supplemental part").toBe(2);

    // Only the supplemental part (ts 2.000001, in the primary's thread) comes back.
    sockets[0]!.onmessage!({ data: JSON.stringify({ envelope_id: "e-2", type: "events_api", payload: { event: { type: "message", bot_id: "B1", text: "ours", ts: "2.000001", thread_ts: "1.000001", channel: "C-TEST" } } }) });
    expect(inbound().delivery).toBe("delivering");
  });
});
