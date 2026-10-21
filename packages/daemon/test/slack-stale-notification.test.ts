// A post that fails stays in the dispatch buffer and is replayed when the gateway next starts (a
// restart, or `rig slack disable` then `enable`). On Build, four alerts whose posts timed out on
// 10-08 were replayed by an enable 28 hours later and posted for rows that had long closed. These
// tests drive the real wire: a replayed decision for a row that has left the active states posts
// nothing and the row says why; one for a still-open row still posts; and enable drains the
// buffer's undelivered retries along with the active backlog.
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
import { makeQueuePorts, seedBacklogAsHistory } from "../src/domain/gateway/slack/queue-access.js";
import { SeenStore } from "../src/domain/gateway/slack/state-store.js";
import { DispatchBuffer } from "../src/domain/gateway/dispatch-buffer.js";
import { resolveSlackHandle } from "../src/domain/gateway/human-registry.js";
import { DEFAULT_CONFIG, saveConfig } from "../src/domain/gateway/slack/config.js";
import type { FetchImpl } from "../src/domain/gateway/slack/slack-api.js";

const registry = { ok: true as const, entities: [{ entityId: "human-founder", class: "human" as const, displayName: "Founder", address: "human-founder@external", connectorBindings: [{ kind: "slack" as const, connectorRef: "primary", secretsRef: "env:SLACK_BOT_TOKEN", role: "primary" as const, handle: "UFOUNDER" }], prefs: { deliveryClass: "A" as const } }] };
const request = { sourceSession: "author@rig", destinationSession: "human-founder@external", summary: "Stale on replay?", body: "A decision whose first post fails.", nudge: false };
const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const isPost = (url: string | URL) => String(url).endsWith("chat.postMessage");

describe("a retained Slack post replayed after its row closed", () => {
  let home: string;
  let db: ReturnType<typeof createDb>;
  let repo: QueueRepository;
  const stops: Array<() => void> = [];
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "slack-stale-"));
    db = createDb(); migrate(db, ALL_MIGRATIONS);
    repo = new QueueRepository(db, new EventBus(db), { loadHumanRegistry: () => registry });
    const secrets = join(home, "fake.env"); writeFileSync(secrets, "SLACK_BOT_TOKEN=xoxb-EXAMPLE-fake\n");
    saveConfig({ ...DEFAULT_CONFIG, enabled: true, channel: "C-TEST", secretsEnvFile: secrets }, home);
  });
  afterEach(() => { for (const stop of stops.splice(0)) stop(); db.close(); rmSync(home, { recursive: true, force: true }); });

  const wire = (fetchImpl: FetchImpl) => {
    const w = buildSlackGatewayWire({ home, queueRepo: repo, registry: { loadHumanRegistry: () => registry, resolveSlackHandle }, fetchImpl });
    stops.push(() => w.stop());
    return w;
  };
  const notes = (qitemId: string) => repo.listTransitions(qitemId).map((t) => t.transitionNote ?? "");

  /** Run 1: the first post fails in transport, so the decision stays in the dispatch buffer. */
  async function failFirstPost(): Promise<string> {
    const item = await repo.create(request);
    const wire1 = wire(async (url) => {
      if (isPost(url)) throw new TypeError("fetch failed");
      return reply({ ok: true, messages: [] });
    });
    const [alert] = await makeQueuePorts(repo, { loadHumanRegistry: () => registry }).listHumanAlerts({});
    expect(wire1.dispatcher.dispatch("post_message", request.destinationSession, alert)).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(notes(item.qitemId).some((n) => n.startsWith("slack-owner-notification-transport-failed "))).toBe(true));
    expect(new DispatchBuffer(home).pending()).toHaveLength(1);
    wire1.stop();
    return item.qitemId;
  }

  it("posts nothing for a row that closed before the replay, says why on the row, and drains the buffer", async () => {
    const qitemId = await failFirstPost();
    repo.update({ qitemId, actorSession: "human-founder@external", state: "done", closureReason: "no-follow-on", transitionNote: "answered elsewhere" });

    let posts = 0;
    const wire2 = wire(async (url) => {
      if (isPost(url)) { posts += 1; return reply({ ok: true, ts: "late.1" }); }
      return reply({ ok: true, messages: [] });
    });
    wire2.startServices?.();

    await vi.waitFor(() => expect(new DispatchBuffer(home).pending()).toHaveLength(0));
    expect(posts, "a closed row's old alert must not post").toBe(0);
    expect(notes(qitemId).filter((n) => n.startsWith("slack-owner-notification-dropped "))).toEqual([
      expect.stringMatching(/reason=row-not-active state=done$/),
    ]);
  });

  it("still posts the replay once for a row that is still open", async () => {
    const qitemId = await failFirstPost();
    let posts = 0;
    const wire2 = wire(async (url) => {
      if (isPost(url)) { posts += 1; return reply({ ok: true, ts: "fresh.1" }); }
      return reply({ ok: true, messages: [] });
    });
    wire2.startServices?.();

    await vi.waitFor(() => expect(posts).toBe(1), { timeout: 5_000 });
    expect(notes(qitemId).some((n) => n.startsWith("slack-owner-notification-dropped "))).toBe(false);
  });

  /** Put a decision in the dispatch buffer as an earlier run would have left it. */
  const retain = (decisionId: string, payload: Record<string, unknown>) =>
    new DispatchBuffer(home).enqueue({ kind: "outbound_decision", decisionId, op: "post_message", entityBindingRef: request.destinationSession, payload });

  it("does not drop a replayed decision-resolved notice, which is written when its row closes", async () => {
    const item = await repo.create(request);
    repo.update({ qitemId: item.qitemId, actorSession: "human-founder@external", state: "done", closureReason: "no-follow-on", transitionNote: "resolved" });
    retain("d-resolved", {
      qitemId: item.qitemId, notificationKey: `${item.qitemId}:resolved`, ownerNotificationKind: "human-decision-resolved",
      destinationSession: request.destinationSession, summary: "Resolved", body: "Your answer was handed back.",
    });
    wire(async (url) => (isPost(url) ? reply({ ok: true, ts: "resolved.1" }) : reply({ ok: true, messages: [] }))).startServices?.();
    // Whatever the delivery engine decides for it, the decision leaves the buffer; it must not be the stale drop.
    await vi.waitFor(() => expect(new DispatchBuffer(home).pending()).toHaveLength(0));
    expect(notes(item.qitemId).some((n) => n.startsWith("slack-owner-notification-dropped "))).toBe(false);
  });

  it("drains a replayed episode that already has its posted receipt without calling it dropped", async () => {
    const item = await repo.create(request);
    const key = `${item.qitemId}:posted-before`;
    repo.update({ qitemId: item.qitemId, actorSession: "daemon@kernel", transitionNote: `slack-owner-notification-posted notification_key=${key} level=ALERT kind=human-required message_ts=9.9 thread_ts=9.9` });
    repo.update({ qitemId: item.qitemId, actorSession: "human-founder@external", state: "done", closureReason: "no-follow-on", transitionNote: "answered" });
    retain("d-posted", { qitemId: item.qitemId, notificationKey: key, destinationSession: request.destinationSession, summary: "S", body: "B" });
    let posts = 0;
    wire(async (url) => { if (isPost(url)) posts += 1; return isPost(url) ? reply({ ok: true, ts: "dup.1" }) : reply({ ok: true, messages: [] }); }).startServices?.();
    await vi.waitFor(() => expect(new DispatchBuffer(home).pending()).toHaveLength(0));
    expect(posts).toBe(0);
    expect(notes(item.qitemId).some((n) => n.startsWith("slack-owner-notification-dropped "))).toBe(false);
  });

  it("at enable an open row's retry still posts and a closed row's is dropped; the status line says what waits", async () => {
    const openRow = await failFirstPost(); // pending, its failed post retained
    const closed = await repo.create({ ...request, summary: "Closed since" });
    repo.update({ qitemId: closed.qitemId, actorSession: "human-founder@external", state: "done", closureReason: "no-follow-on", transitionNote: "answered" });
    retain("d-closed", { qitemId: closed.qitemId, notificationKey: `${closed.qitemId}:1`, destinationSession: request.destinationSession, summary: "S", body: "B" });

    const seed = await seedBacklogAsHistory({
      queue: makeQueuePorts(repo, { loadHumanRegistry: () => registry }), seen: new SeenStore(join(home, "outbound-seen.jsonl")),
      filter: {}, buffer: new DispatchBuffer(home),
    });
    expect(seed.onlineStatus).toContain("2 earlier undelivered post(s) wait in the replay buffer");
    expect(new DispatchBuffer(home).pending(), "enable drains nothing").toHaveLength(2);

    let posts = 0;
    wire(async (url) => {
      if (isPost(url)) { posts += 1; return reply({ ok: true, ts: "late-but-open.1" }); }
      return reply({ ok: true, messages: [] });
    }).startServices?.();
    await vi.waitFor(() => expect(new DispatchBuffer(home).pending()).toHaveLength(0), { timeout: 5_000 });
    expect(posts, "the open row's alert, which the person never saw, posts").toBe(1);
    expect(notes(openRow).some((n) => n.startsWith("slack-owner-notification-dropped "))).toBe(false);
    expect(notes(closed.qitemId).filter((n) => n.startsWith("slack-owner-notification-dropped "))).toHaveLength(1);
  });
});
