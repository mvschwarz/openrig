// Maintainer review on PR #1026: the inline rate-limit retry must respect who
// owns the delivery. Sequence without a stop hook: run 1 gets 429 with a short
// Retry-After and starts waiting; a gateway restart (rig slack disable/enable →
// subsystem.restart()) replays the same un-Acked decision under run 2; when both
// waits end, both retries post and Slack shows two identical messages. The
// replay's reconcile-by-marker cannot catch it because the scan runs before
// either post lands. This test drives the REAL wire: stop run 1 inside the wait
// (the wire's stop aborts it), let run 2 replay and deliver, then give the stale
// run its old window to misbehave — exactly one post may ever succeed.
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
import type { FetchImpl } from "../src/domain/gateway/slack/slack-api.js";

const registry = { ok: true as const, entities: [{ entityId: "human-founder", class: "human" as const, displayName: "Founder", address: "human-founder@external", connectorBindings: [{ kind: "slack" as const, connectorRef: "primary", secretsRef: "env:SLACK_BOT_TOKEN", role: "primary" as const, handle: "UFOUNDER" }], prefs: { deliveryClass: "A" as const } }] };
const request = { sourceSession: "author@rig", destinationSession: "human-founder@external", summary: "Restart race?", body: "One decision that must post exactly once across a restart inside its rate-limit wait.", nudge: false };
const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const isPost = (url: string | URL) => String(url).endsWith("chat.postMessage");

describe("restart inside the rate-limit wait", () => {
  let home: string;
  let db: ReturnType<typeof createDb>;
  let repo: QueueRepository;
  const stops: Array<() => void> = [];
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "slack-restart-rl-"));
    db = createDb(); migrate(db, ALL_MIGRATIONS);
    repo = new QueueRepository(db, new EventBus(db), { loadHumanRegistry: () => registry });
  });
  afterEach(() => { for (const stop of stops.splice(0)) stop(); db.close(); rmSync(home, { recursive: true, force: true }); });

  it("posts exactly once when the gateway is restarted while the retry is waiting", async () => {
    const item = await repo.create(request);
    const secrets = join(home, "fake.env"); writeFileSync(secrets, "SLACK_BOT_TOKEN=xoxb-EXAMPLE-fake\n");
    saveConfig({ ...DEFAULT_CONFIG, enabled: true, channel: "C-TEST", secretsEnvFile: secrets }, home);

    let wire1Posts = 0;
    let wire2Posts = 0;
    let okPosts = 0;
    const fetch1: FetchImpl = async (url) => {
      if (!isPost(url)) return reply({ ok: true, messages: [] });
      wire1Posts += 1;
      if (wire1Posts === 1) {
        return new Response(JSON.stringify({ ok: false, error: "rate_limited" }), { status: 429, headers: { "retry-after": "1" } });
      }
      okPosts += 1; // the stale run's retry — the double post this test forbids
      return reply({ ok: true, ts: "stale.1" });
    };
    const fetch2: FetchImpl = async (url) => {
      if (!isPost(url)) return reply({ ok: true, messages: [] }); // reconcile scan: no marker yet
      wire2Posts += 1;
      okPosts += 1;
      return reply({ ok: true, ts: "fresh.1" });
    };

    const wire1 = buildSlackGatewayWire({ home, queueRepo: repo, registry: { loadHumanRegistry: () => registry, resolveSlackHandle }, fetchImpl: fetch1 });
    stops.push(() => wire1.stop());
    const [alert] = await makeQueuePorts(repo, { loadHumanRegistry: () => registry }).listHumanAlerts({});
    expect(wire1.dispatcher.dispatch("post_message", request.destinationSession, alert)).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(wire1Posts, "the first post must hit the429 and enter its wait").toBe(1));

    // The restart: stop run 1 mid-wait (the wire's stop must cancel the pending retry),
    // then build run 2 and start its services — replayPending re-enters the same decision.
    wire1.stop();
    const wire2 = buildSlackGatewayWire({ home, queueRepo: repo, registry: { loadHumanRegistry: () => registry, resolveSlackHandle }, fetchImpl: fetch2 });
    stops.push(() => wire2.stop());
    wire2.startServices?.();

    // The replay must land the decision — an ALERT row stays pending until a human
    // answers, so the delivery signal is a successful post, not a state change.
    await vi.waitFor(() => expect(okPosts, "the replay's post succeeded").toBe(1), { timeout: 5_000 });
    // Give the stale run 1 the full window its old timer would have fired in.
    await new Promise((r) => setTimeout(r, 1_300));
    expect(wire1Posts, "the stopped run must never fire its retry").toBe(1);
    expect(okPosts, "exactly one successful post overall").toBe(1);
    expect(wire2Posts, "the replay delivered the decision once").toBe(1);
    expect(repo.getById(item.qitemId)?.qitemId).toBe(item.qitemId); // decision retained, never dropped
  });
});
