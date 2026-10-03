import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { makeParkedOwnerConsumerPolicy, makeRigAnchor, PARKED_OWNER_POLICY_NAME, REFUSED_PREFIX } from "../src/domain/policies/parked-owner-consumer.js";
import type { PolicyJob } from "../src/domain/policies/types.js";
import type { WatchdogHistoryEntry } from "../src/domain/watchdog-history-log.js";
import { runWakeLadderTick } from "../src/domain/queue-wake-ladder.js";
import { makeOperatorDeliveryEngine } from "../src/domain/gateway/operator-delivery-engine.js";
import { buildSlackGatewayWire } from "../src/domain/gateway/slack/slack-subsystem.js";
import { DEFAULT_CONFIG, saveConfig } from "../src/domain/gateway/slack/config.js";
import { resolveSlackHandle } from "../src/domain/gateway/human-registry.js";

const seat = "worker@fixture";
const registry = { ok: true as const, entities: [{
  entityId: "human-owner", class: "human" as const, displayName: "Owner", address: "human-owner@external",
  connectorBindings: [{ kind: "slack" as const, connectorRef: "primary", secretsRef: "env:SLACK_BOT_TOKEN", role: "primary" as const, handle: "UFIXTURE" }],
  prefs: { deliveryClass: "B" as const, availability: "available" as const },
}] };

// Real policy -> durable queue -> real ladder -> production operator port -> real
// gateway dispatcher/Slack formatter. Only the external HTTP sink is replaced.
// No daemon, tmux process, provider, or real human is involved.
describe("prompt-blocked outstanding work reaches the configured route", () => {
  let db: Database.Database;
  let repo: QueueRepository;
  let home: string;
  const wires: ReturnType<typeof buildSlackGatewayWire>[] = [];
  beforeEach(() => {
    db = new Database(":memory:"); migrate(db, ALL_MIGRATIONS);
    repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true });
    home = mkdtempSync(join(tmpdir(), "prompt-alert-"));
  });
  afterEach(() => { for (const w of wires.splice(0)) w.stop(); db.close(); rmSync(home, { recursive: true, force: true }); });

  function engine(posts: unknown[], registered = true) {
    const reg = registered ? registry : { ok: true as const, entities: [] };
    const secrets = join(home, "slack.env");
    writeFileSync(secrets, "SLACK_BOT_TOKEN=fixture-only\n", { mode: 0o600 });
    saveConfig({ ...DEFAULT_CONFIG, enabled: true, channel: "CFIXTURE", secretsEnvFile: secrets }, home);
    const wire = buildSlackGatewayWire({ home, queueRepo: repo,
      registry: { loadHumanRegistry: () => reg, resolveSlackHandle },
      fetchImpl: async (url, init) => {
        expect(String(url)).toBe("https://slack.com/api/chat.postMessage");
        posts.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ ok: true, ts: `1.${posts.length}` }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    wires.push(wire); wire.startServices?.();
    return makeOperatorDeliveryEngine({ home, queueRepo: repo,
      registry: { loadHumanRegistry: () => reg },
      dispatch: (op, ref, payload) => wire.dispatcher.dispatch(op, ref, payload),
    });
  }

  async function refusal() {
    const row = await repo.create({ sourceSession: "sender@fixture", destinationSession: seat, body: "finish the assigned work", summary: "assigned work", nudge: false });
    repo.claim({ qitemId: row.qitemId, destinationSession: seat });
    const history: WatchdogHistoryEntry[] = [];
    const policy = makeParkedOwnerConsumerPolicy({
      diagnoseRig: () => ({ seats: [{ sessionName: seat, parked: true,
        activity: { value: "idle-at-prompt", needsInput: { count: 1, reason: "permission prompt" } },
        obligations: { items: [{ qitemId: row.qitemId, state: "in-progress", summary: "assigned work" }], held: [] },
      }] }),
      history: { listForJob: () => history, countForJob: () => history.length },
      rows: {
        listTransitions: id => repo.listTransitions(id),
        appendNote: (id, note) => { repo.update({ qitemId: id, actorSession: "watchdog@system", transitionNote: note }); return { ok: true }; },
        recordNudgeResult: (id, result) => repo.recordNudgeAttempt(id, result),
        listOpenIds: () => [row.qitemId],
      },
    });
    const job = { jobId: "fixture-job", policy: PARKED_OWNER_POLICY_NAME, target: { session: makeRigAnchor("fixture") }, context: {} } as PolicyJob;
    const wake = await policy.evaluate(job);
    expect(wake.action).toBe("send");
    history.push({ historyId: "fixture-history", jobId: job.jobId, evaluatedAt: new Date().toISOString(), outcome: "sent", skipReason: null,
      deliveryTargetSession: seat, deliveryStatus: "failed", deliveryMessage: "wake", evaluationNotes: {
        ...wake.notes, deliveryReason: `Refused: '${seat}' is at an interactive prompt (target_needs_input). No text was sent.`,
      },
    });
    await policy.evaluate(job);
    expect(repo.listTransitions(row.qitemId).some(t => t.transitionNote?.startsWith(REFUSED_PREFIX))).toBe(true);
    expect(repo.getById(row.qitemId)?.lastNudgeResult).not.toMatch(/^failed:/);
    return repo.getById(row.qitemId)!;
  }

  it("single seat: prompt refusal reaches the actual notification sink without retrying the seat", async () => {
    const row = await refusal(); const posts: unknown[] = []; const wakeTargets: string[] = [];
    const result = await runWakeLadderTick({ db, queueRepo: repo, resolveOrchestrator: () => null,
      retryIntervalSeconds: 1, now: new Date(Date.now() + 60_000), deliveryEngine: engine(posts),
      attemptWake: async (_id, target) => { wakeTargets.push(target); return "failed:fixture"; }, log: () => {},
    });
    expect(result.outcome).not.toBe("failed");
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(wakeTargets).not.toContain(seat);
    expect(posts).toHaveLength(1);
    expect(JSON.stringify(posts)).toContain("assigned work");
    expect(repo.getById(row.qitemId)?.state).toBe("in-progress");
  });

  it("positive sink control: the existing production operator port posts and records the receipt", async () => {
    const row = await refusal(); const posts: unknown[] = [];
    const result = await engine(posts).dispatchEscalation(row, "interactive prompt blocks outstanding work");
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(result).toMatchObject({ decision: "interrupt", resolved: false });
    expect(posts).toHaveLength(1);
    expect(JSON.stringify(posts)).toContain("assigned work");
    expect(repo.listTransitions(row.qitemId).some(t => t.transitionNote?.startsWith("slack-owner-notification-posted "))).toBe(true);
  });

  it("missing human is unresolved, never a delivered or resolved outcome", async () => {
    const row = await refusal(); const posts: unknown[] = [];
    const result = await engine(posts, false).dispatchEscalation(row, "interactive prompt blocks outstanding work");
    expect(result.decision).toBe("undeliverable:no-registered-human");
    expect(result.resolved).toBe(false);
    expect(posts).toEqual([]);
  });
});
