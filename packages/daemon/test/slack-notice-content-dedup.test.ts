import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { DispatchBuffer } from "../src/domain/gateway/dispatch-buffer.js";
import { buildSlackGatewayWire } from "../src/domain/gateway/slack/slack-subsystem.js";
import { makeQueuePorts } from "../src/domain/gateway/slack/queue-access.js";
import { DEFAULT_CONFIG, saveConfig } from "../src/domain/gateway/slack/config.js";
import { resolveSlackHandle } from "../src/domain/gateway/human-registry.js";
import type { OutboundPostPayload } from "../src/domain/gateway/slack/outbound-driver.js";

const human = "person@external";
const registry = { ok: true as const, entities: [{ entityId: "person", class: "human" as const,
  displayName: "Person", address: human, connectorBindings: [{ kind: "slack" as const,
    connectorRef: "primary", secretsRef: "env:SLACK_BOT_TOKEN", role: "primary" as const, handle: "UPERSON" }],
  prefs: { deliveryClass: "A" as const } }] };
const response = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe("status notice content dedup", () => {
  let home: string;
  let db: ReturnType<typeof createDb>;
  let repo: QueueRepository;
  let wire: ReturnType<typeof buildSlackGatewayWire>;
  let posts: Record<string, unknown>[];
  let edits: Record<string, unknown>[];
  let failEdit: boolean;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "slack-notice-content-"));
    db = createDb(); migrate(db, ALL_MIGRATIONS);
    repo = new QueueRepository(db, new EventBus(db), { loadHumanRegistry: () => registry });
    const secrets = join(home, "fake.env");
    writeFileSync(secrets, "SLACK_BOT_TOKEN=xoxb-EXAMPLE-fake\n");
    saveConfig({ ...DEFAULT_CONFIG, enabled: true, channel: "C-STATUS", secretsEnvFile: secrets }, home);
    posts = []; edits = []; failEdit = false;
    wire = buildSlackGatewayWire({ home, queueRepo: repo,
      registry: { loadHumanRegistry: () => registry, resolveSlackHandle },
      fetchImpl: async (url, init) => {
        const api = new URL(url);
        const body: Record<string, unknown> = init?.body ? JSON.parse(String(init.body)) : {};
        if (api.pathname.endsWith("chat.postMessage")) {
          const message = { ...body, ts: `${posts.length + 1}.000001` };
          posts.push(message);
          return response({ ok: true, ts: message.ts });
        }
        if (api.pathname.endsWith("chat.update")) {
          edits.push(body);
          if (failEdit) return response({ ok: false, error: "cant_update_message" });
          const original = posts.find((p) => p.ts === body.ts && p.channel === body.channel);
          Object.assign(original ?? {}, body);
          return response({ ok: true, ts: body.ts, channel: body.channel });
        }
        const ts = api.searchParams.get("latest") ?? api.searchParams.get("oldest");
        return response({ ok: true, messages: posts.filter((p) => p.ts === ts) });
      },
    });
  });
  afterEach(() => { wire.stop(); db.close(); rmSync(home, { recursive: true, force: true }); });

  async function notice(overrides: Partial<Parameters<QueueRepository["create"]>[0]> = {}) {
    const item = await repo.create({ sourceSession: "author@rig", destinationSession: human,
      summary: "Build status", body: "Build failed on main.", humanIntent: "update", nudge: false, ...overrides });
    const alerts = await makeQueuePorts(repo, { loadHumanRegistry: () => registry }).listHumanAlerts({});
    const payload = alerts.find((a) => a.qitemId === item.qitemId);
    expect(payload).toBeDefined();
    return { item, payload };
  }

  async function dispatch(payload: unknown) {
    expect(wire.dispatcher.dispatch("post_message", human, payload)).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(new DispatchBuffer(home).pending()).toHaveLength(0));
  }

  it("marks an identical repeat instead of posting again", async () => {
    const first = await notice(); await dispatch(first.payload);
    const original = structuredClone(posts[0]);
    const repeat = await notice();
    const third = await notice();
    await Promise.all([dispatch(repeat.payload), dispatch(third.payload)]);
    expect(posts).toHaveLength(1);
    expect(edits).toHaveLength(2);
    expect(edits[1]).toMatchObject({ channel: "C-STATUS", ts: "1.000001" });
    expect(String(edits[1]?.text)).toMatch(/sent again at .*\(3 times\)/);
    expect(String(edits[1]?.text)).toContain(String(original?.text));
    expect(repo.getById(repeat.item.qitemId)?.state).toBe("done");
    expect(repo.listTransitions(repeat.item.qitemId).some((t) =>
      t.transitionNote?.includes(`reason=identical-content`) && t.transitionNote.includes(`qitem_id=${first.item.qitemId}`))).toBe(true);
  });

  it("posts a changed body and resets the last-status comparison", async () => {
    await dispatch((await notice()).payload);
    await dispatch((await notice({ body: "Build passed on main." })).payload);
    await dispatch((await notice()).payload);
    await dispatch((await notice({ summary: "Another build status" })).payload);
    await dispatch((await notice({ sourceSession: "other@rig" })).payload);
    expect(posts).toHaveLength(5);
    expect(edits).toHaveLength(0);
  });

  it("posts a replyTo follow-up", async () => {
    const first = await notice(); await dispatch(first.payload);
    await dispatch((await notice({ replyTo: first.item.qitemId })).payload);
    expect(posts).toHaveLength(2);
    expect(edits).toHaveLength(0);
  });

  it("leaves asks and answers untouched", async () => {
    await dispatch((await notice()).payload);
    const ask = await notice({ humanIntent: "decision" });
    await dispatch(ask.payload);
    const answer: OutboundPostPayload = { qitemId: ask.item.qitemId, notificationKey: "answer-episode",
      sourceSession: "author@rig", destinationSession: human, summary: "Build status", body: "Build failed on main.",
      ownerNotificationKind: "human-decision-resolved", ownerNotificationLevel: "NOTICE" };
    await dispatch(answer);
    await dispatch((await notice({ humanIntent: "decision", humanAlert: true })).payload);
    expect(posts).toHaveLength(4);
    expect(edits).toHaveLength(0);
    expect(repo.getById(ask.item.qitemId)?.state).toBe("pending");
  });

  it("leaves a digest member untouched", async () => {
    await dispatch((await notice()).payload);
    const member = await notice();
    await dispatch({ ...member.payload, deliveryDigestPost: true, digestId: "digest-status",
      memberReceipts: [{ qitemId: member.item.qitemId, notificationKey: member.item.ownerNotificationKey,
        level: "NOTICE", kind: "human-update" }] });
    expect(posts).toHaveLength(2);
    expect(edits).toHaveLength(0);
    expect(repo.listTransitions(member.item.qitemId).some((t) => t.transitionNote?.includes("digest=digest-status"))).toBe(true);
  });

  it("posts normally when the edit fails", async () => {
    await dispatch((await notice()).payload);
    failEdit = true;
    const repeat = await notice(); await dispatch(repeat.payload);
    expect(posts).toHaveLength(2);
    expect(edits).toHaveLength(1);
    expect(repo.listTransitions(repeat.item.qitemId).some((t) => t.transitionNote?.includes("reason=identical-content"))).toBe(false);
    expect(repo.listTransitions(repeat.item.qitemId).some((t) => t.transitionNote?.startsWith("slack-owner-notification-posted "))).toBe(true);
  });
});
