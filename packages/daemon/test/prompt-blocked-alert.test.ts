import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { runWakeLadderTick, queueRecoveryOwnsWake, classifyPromptAfterRefusal } from "../src/domain/queue-wake-ladder.js";
import { makeOperatorDeliveryEngine } from "../src/domain/gateway/operator-delivery-engine.js";
import { buildSlackGatewayWire } from "../src/domain/gateway/slack/slack-subsystem.js";
import { DEFAULT_CONFIG, saveConfig } from "../src/domain/gateway/slack/config.js";
import { DispatchBuffer } from "../src/domain/gateway/dispatch-buffer.js";
import type { LoadResult } from "../src/domain/gateway/human-registry.js";
import { GatewayDispatcher } from "../src/domain/gateway/dispatcher.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SessionTransport } from "../src/domain/session-transport.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
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
  let state: "blocked" | "clear" | "unknown";
  let episodeRows: string[];
  const acceptedAtSink: string[] = [];
  const wires: ReturnType<typeof buildSlackGatewayWire>[] = [];
  beforeEach(() => {
    state = "blocked"; episodeRows = []; acceptedAtSink.length = 0;
    db = new Database(":memory:"); migrate(db, ALL_MIGRATIONS);
    repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true });
    home = mkdtempSync(join(tmpdir(), "prompt-alert-"));
  });
  afterEach(() => { for (const w of wires.splice(0)) w.stop(); db.close(); rmSync(home, { recursive: true, force: true }); });

  function engine(posts: unknown[], registered: boolean | (() => LoadResult) = true) {
    const load = typeof registered === "function" ? registered : () => registered ? registry : { ok: true as const, entities: [] };
    const secrets = join(home, "slack.env");
    writeFileSync(secrets, "SLACK_BOT_TOKEN=fixture-only\n", { mode: 0o600 });
    saveConfig({ ...DEFAULT_CONFIG, enabled: true, channel: "CFIXTURE", secretsEnvFile: secrets }, home);
    const wire = buildSlackGatewayWire({ home, queueRepo: repo,
      registry: { loadHumanRegistry: load, resolveSlackHandle },
      fetchImpl: async (url, init) => {
        expect(String(url)).toBe("https://slack.com/api/chat.postMessage");
        // Re-open the on-disk buffer at the real HTTP boundary. Acceptance is
        // persistence-before-send, not a stub's ok=true response.
        const pending = new DispatchBuffer(home).pending();
        expect(pending.length).toBeGreaterThan(0);
        acceptedAtSink.push(...pending.map(d => d.decisionId));
        posts.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ ok: true, ts: `1.${posts.length}` }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    wires.push(wire); wire.startServices?.();
    return makeOperatorDeliveryEngine({ home, queueRepo: repo,
      registry: { loadHumanRegistry: load },
      dispatch: (op, ref, payload, opts) => wire.dispatcher.dispatch(op, ref, payload, opts),
    });
  }

  async function refusal(count = 1, deliveryReason = `Refused: '${seat}' is at an interactive prompt (target_needs_input). No text was sent.`) {
    for (let i = 0; i < count; i++) {
      const row = await repo.create({ sourceSession: "sender@fixture", destinationSession: seat, body: "finish the assigned work", summary: `assigned work ${i}`, nudge: false });
      repo.claim({ qitemId: row.qitemId, destinationSession: seat });
      episodeRows.push(row.qitemId);
    }
    episodeRows.sort();
    const row = repo.getById(episodeRows[0]!)!;
    const history: WatchdogHistoryEntry[] = [];
    const policy = makeParkedOwnerConsumerPolicy({
      diagnoseRig: () => ({ seats: [{ sessionName: seat, parked: true,
        activity: { value: "idle-at-prompt", needsInput: { count: 1, reason: "permission prompt" } },
        obligations: { items: episodeRows.map(qitemId => ({ qitemId, state: "in-progress", summary: "assigned work" })), held: [] },
      }] }),
      history: { listForJob: () => history, countForJob: () => history.length },
      rows: {
        listTransitions: id => repo.listTransitions(id),
        appendNote: (id, note) => { repo.update({ qitemId: id, actorSession: "watchdog@system", transitionNote: note }); return { ok: true }; },
        recordNudgeResult: (id, result) => repo.recordNudgeAttempt(id, result),
        listOpenIds: () => episodeRows,
        recoveryOwnsWake: id => queueRecoveryOwnsWake(db, repo.getById(id)),
      },
    });
    const job = { jobId: "fixture-job", policy: PARKED_OWNER_POLICY_NAME, target: { session: makeRigAnchor("fixture") }, context: {} } as PolicyJob;
    const wake = await policy.evaluate(job);
    expect(wake.action).toBe("send");
    history.push({ historyId: "fixture-history", jobId: job.jobId, evaluatedAt: new Date().toISOString(), outcome: "sent", skipReason: null,
      deliveryTargetSession: seat, deliveryStatus: "failed", deliveryMessage: "wake", evaluationNotes: {
        ...wake.notes, deliveryReason,
      },
    });
    await policy.evaluate(job);
    if (deliveryReason.startsWith("Refused:")) {
      expect(repo.listTransitions(row.qitemId).some(t => t.transitionNote?.startsWith(REFUSED_PREFIX))).toBe(true);
      expect(repo.getById(row.qitemId)?.lastNudgeResult ?? "").not.toMatch(/^failed:/);
    }
    return repo.getById(row.qitemId)!;
  }

  it("single seat: prompt refusal reaches the actual notification sink without retrying the seat", async () => {
    const row = await refusal(); const posts: unknown[] = []; const wakeTargets: string[] = [];
    const result = await runWakeLadderTick({ db, queueRepo: repo, resolveOrchestrator: () => null,
      readPromptState: () => state, retryIntervalSeconds: 1, now: new Date(Date.now() + 60_000), deliveryEngine: engine(posts),
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

  function notes(id: string) { return repo.listTransitions(id).map(t => t.transitionNote ?? ""); }
  function alerts() { return repo.list({ state: ["pending", "in-progress", "blocked"], limit: 1000 }).filter(r => r.tags?.includes("wake-prompt-refusal")); }
  function tick(port: ReturnType<typeof engine>, opts: Partial<Parameters<typeof runWakeLadderTick>[0]> = {}) {
    return runWakeLadderTick({ db, queueRepo: repo, resolveOrchestrator: () => null, readPromptState: () => state,
      retryIntervalSeconds: 60, now: new Date(Date.now() + 120_000), deliveryEngine: port,
      attemptWake: async () => { throw new Error("unexpected seat input"); }, log: () => {}, ...opts });
  }

  it("several rows share one alert, persisted acceptance and receipt across reconstructed ticks", async () => {
    await refusal(3); const posts: unknown[] = []; const port = engine(posts);
    expect((await tick(port)).outcome).not.toBe("failed");
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    const alert = alerts()[0]!;
    for (const id of episodeRows) expect(JSON.stringify(posts)).toContain(id);
    expect(acceptedAtSink).toHaveLength(1);
    expect(notes(alert.qitemId).join("\n")).toContain(`decision_id=${acceptedAtSink[0]}`);
    for (let i = 0; i < 3; i++) await tick(port); // all state is re-read from the DB
    expect(posts).toHaveLength(1);
    expect(notes(alert.qitemId).filter(n => n.startsWith("ladder-exhausted:"))).toHaveLength(1);
    for (const id of episodeRows) expect(repo.getById(id)?.state).toBe("in-progress");
  });

  it("a fallback finding at the same blocked seat cannot mask the human route", async () => {
    const row = await refusal(); const posts: unknown[] = [];
    const fallback = await repo.create({ sourceSession: "sender@fixture", destinationSession: seat, body: "retained recovery finding",
      tags: [`recovery-for:${row.qitemId}`], nudge: false });
    await tick(engine(posts)); await vi.waitFor(() => expect(posts).toHaveLength(1));
    expect(JSON.stringify(posts)).toContain(fallback.qitemId);
    expect(repo.getById(fallback.qitemId)?.body).toBe("retained recovery finding");
    expect(repo.getById(fallback.qitemId)?.state).toBe("pending");
  });

  it("recovery held by another destination is respected", async () => {
    const row = await refusal(); const posts: unknown[] = [];
    await repo.create({ sourceSession: "sender@fixture", destinationSession: "lead@fixture", body: "owned recovery",
      tags: [`recovery-for:${row.qitemId}`], nudge: false });
    await tick(engine(posts)); expect(posts).toEqual([]); expect(alerts()).toHaveLength(0);
  });

  it("ordinary orchestrator receives one aggregate and no human post", async () => {
    await refusal(2); const posts: unknown[] = []; const port = engine(posts); const wakes: string[] = [];
    const opts = { resolveOrchestrator: () => "lead@fixture", attemptWake: async (_id: string, target: string) => { wakes.push(target); return "verified"; } };
    await tick(port, opts);
    repo.claim({ qitemId: alerts()[0]!.qitemId, destinationSession: "lead@fixture" });
    await tick(port, opts);
    expect(wakes).toEqual(["lead@fixture"]); expect(posts).toEqual([]);
    expect(alerts()).toHaveLength(1); expect(alerts()[0]?.destinationSession).toBe("lead@fixture");
  });

  it("orchestrator failure advances once after backoff, never wakes the blocked seat", async () => {
    await refusal(); const posts: unknown[] = []; const port = engine(posts); const wakes: string[] = [];
    const opts = { resolveOrchestrator: () => "lead@fixture", attemptWake: async (_id: string, target: string) => { wakes.push(target); return "failed:offline"; } };
    await tick(port, { ...opts, now: new Date() });
    await tick(port, { ...opts, now: new Date() });
    expect(posts).toEqual([]);
    await tick(port, opts);
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    expect(wakes).toEqual(["lead@fixture"]);
  });

  it("no binding stays silent through repeated ticks, then uses a newly bound human once", async () => {
    await refusal(); let reg: LoadResult = { ok: true, entities: [] }; const posts: unknown[] = []; const port = engine(posts, () => reg);
    await tick(port);
    const alert = alerts()[0]!; const before = repo.listTransitions(alert.qitemId);
    for (let i = 0; i < 4; i++) expect((await tick(port)).outcome).toBe("clean");
    expect(repo.listTransitions(alert.qitemId)).toEqual(before);
    expect(posts).toEqual([]); expect(new DispatchBuffer(home).pending()).toEqual([]);
    expect(notes(alert.qitemId).join("\n")).toContain("unresolved-route decision=undeliverable:no-registered-human");
    expect(notes(alert.qitemId).join("\n")).not.toContain("dispatched-to-engine");
    expect(notes(alert.qitemId).join("\n")).not.toContain("ladder-exhausted:");
    reg = registry; await tick(port);
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    await tick(port); expect(posts).toHaveLength(1);
  });

  it("only a newer arbitrated clear state can retire a positive refusal", () => {
    const refusedAt = "2026-01-01T00:00:02.000Z";
    const idle = { activity: "idle-at-prompt" as const, needsInput: { count: 0, reason: null }, changedAt: "2026-01-01T00:00:01.000Z",
      rungs: [{ rung: "needs-input-chrome" as const, sourceId: "fixture", trust: "authoritative" as const, lastEvidenceAt: "2026-01-01T00:00:03.000Z" }] };
    expect(classifyPromptAfterRefusal(idle, refusedAt)).toBe("unknown");
    expect(classifyPromptAfterRefusal({ ...idle, changedAt: refusedAt }, refusedAt)).toBe("unknown");
    expect(classifyPromptAfterRefusal({ ...idle, changedAt: "2026-01-01T00:00:03.000Z" }, refusedAt)).toBe("clear");
    expect(classifyPromptAfterRefusal({ ...idle, needsInput: { count: 1, reason: "permission prompt" } }, refusedAt)).toBe("blocked");
    expect(classifyPromptAfterRefusal({ ...idle, activity: "unknown", changedAt: "2026-01-01T00:00:03.000Z" }, refusedAt)).toBe("unknown");
    expect(classifyPromptAfterRefusal(null, refusedAt)).toBe("unknown");
  });

  it("activity-only Codex and generic changes cannot clear a refused prompt", () => {
    const refusedAt = "2026-01-01T00:00:02.000Z";
    const sampling = { rung: "window-sampling" as const, sourceId: "tmux", trust: "authoritative" as const, lastEvidenceAt: "2026-01-01T00:00:03.000Z" };
    const codex = { activity: "working" as const, needsInput: { count: 0, reason: null }, changedAt: "2026-01-01T00:00:03.000Z",
      rungs: [sampling, { rung: "lifecycle-hooks" as const, sourceId: "codex", trust: "trial" as const, lastEvidenceAt: "2026-01-01T00:00:03.000Z" }] };
    expect(classifyPromptAfterRefusal(codex, refusedAt)).toBe("unknown");
    const generic = { ...codex, rungs: [sampling] };
    expect(classifyPromptAfterRefusal(generic, refusedAt)).toBe("unknown");
  });

  it("a malformed prompt row logs once without stopping another destination's retry", async () => {
    const broken = await refusal();
    const source = await repo.create({ sourceSession: "sender@fixture", destinationSession: "relay@fixture", body: "other work", nudge: false });
    const { created } = await repo.handoff({ qitemId: source.qitemId, fromSession: "relay@fixture", toSession: "other@fixture", nudge: false });
    db.prepare("UPDATE queue_items SET last_nudge_result = 'failed:offline' WHERE qitem_id = ?").run(created.qitemId);
    db.prepare("UPDATE queue_items SET tags = '{' WHERE qitem_id = ?").run(broken.qitemId);
    const log = vi.fn(); const attemptWake = vi.fn(async () => "failed:offline");
    const result = await tick(engine([]), { log, attemptWake });
    expect(result.outcome).not.toBe("failed");
    expect(attemptWake).toHaveBeenCalledWith(created.qitemId, "other@fixture");
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toContain("prompt refusal pass failed");
  });

  it("malformed unrelated tags do not hide a valid prompt alert", async () => {
    const unrelated = await repo.create({ sourceSession: "sender@fixture", destinationSession: "other@fixture", body: "other work", nudge: false });
    await refusal();
    db.prepare("UPDATE queue_items SET tags = '{' WHERE qitem_id = ?").run(unrelated.qitemId);
    const posts: unknown[] = []; const log = vi.fn();
    const result = await tick(engine(posts), { log });
    expect(result.outcome).not.toBe("failed");
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    expect(log).not.toHaveBeenCalled();
  });

  it("an open prompt recovery owns the shared failed-class escalation", async () => {
    const row = await refusal();
    // #623 maps retained:typing_guard to this existing failed class. Exercise
    // the shared escalation seam without importing that PR's classifier change.
    repo.transitionLog.append({ qitemId: row.qitemId, state: row.state, actorSession: "watchdog@system", transitionNote: "parked-owner wake delivery failed: fixture" });
    db.prepare("UPDATE queue_items SET last_nudge_result = 'failed:fixture' WHERE qitem_id = ?").run(row.qitemId);
    const posts: unknown[] = []; const port = engine(posts, false);
    for (let i = 0; i < 2; i++) expect((await tick(port, { retryCap: 0 })).outcome).not.toBe("failed");
    const escalations = repo.list({ state: ["pending", "in-progress", "blocked"], limit: 1000 }).filter(r => r.tags?.includes("wake-escalation"));
    expect(escalations).toHaveLength(1);
    expect(escalations[0]!.tags).toContain("wake-prompt-refusal");
    expect(notes(row.qitemId).join("\n")).not.toContain("ladder-exhausted:");
    expect(posts).toEqual([]);
  });

  it.each(["clear", "unknown"] as const)("%s activity neither dispatches nor fabricates a refusal", async value => {
    await refusal(); const posts: unknown[] = []; state = value;
    await tick(engine(posts));
    expect(posts).toEqual([]); expect(alerts()).toHaveLength(0);
    expect(notes(episodeRows[0]!).some(n => n.includes("interactive prompt cleared"))).toBe(value === "clear");
  });

  it("unknown preserves an unresolved episode; positive clearing retires it without delivery", async () => {
    await refusal(); const posts: unknown[] = []; const port = engine(posts, false);
    await tick(port); const id = alerts()[0]!.qitemId;
    state = "unknown"; await tick(port); expect(repo.getById(id)?.state).toBe("pending");
    state = "clear"; await tick(port); expect(repo.getById(id)?.state).toBe("done");
    expect(posts).toEqual([]); expect(notes(id).join("\n")).not.toContain("slack-owner-notification-posted");
  });

  it("closed original work cancels the pending alert before a route returns", async () => {
    const row = await refusal(); const posts: unknown[] = []; let reg: LoadResult = { ok: true, entities: [] };
    const port = engine(posts, () => reg); await tick(port); const id = alerts()[0]!.qitemId;
    repo.update({ qitemId: row.qitemId, actorSession: seat, state: "done", closureReason: "no-follow-on" });
    reg = registry; await tick(port);
    expect(repo.getById(id)?.state).toBe("done"); expect(posts).toEqual([]);
  });

  it("closing work during aggregate creation prevents dispatch at the final boundary", async () => {
    const original = await refusal(); const posts: unknown[] = [];
    const create = repo.create.bind(repo);
    const spy = vi.spyOn(repo, "create").mockImplementation(async input => {
      const row = await create(input);
      if (input.tags?.includes("wake-prompt-refusal")) repo.update({ qitemId: original.qitemId, actorSession: seat, state: "done", closureReason: "no-follow-on" });
      return row;
    });
    try { await tick(engine(posts)); } finally { spy.mockRestore(); }
    expect(posts).toEqual([]);
    expect(alerts().flatMap(row => notes(row.qitemId)).join("\n")).not.toContain("dispatched-to-engine");
  });

  it("closing the primary row keeps the remaining episode members and sends no second alert", async () => {
    const row = await refusal(3); const posts: unknown[] = []; const port = engine(posts);
    await tick(port); await vi.waitFor(() => expect(posts).toHaveLength(1));
    const id = alerts()[0]!.qitemId;
    repo.update({ qitemId: row.qitemId, actorSession: seat, state: "done", closureReason: "no-follow-on" });
    await tick(port); expect(alerts().map(r => r.qitemId)).toEqual([id]); expect(posts).toHaveLength(1);
  });

  it("registry read failure is unavailable, not evidence of no human", async () => {
    const row = await refusal(); const posts: unknown[] = [];
    const port = engine(posts, () => ({ ok: false, error: "fixture read failure" }));
    expect(await port.dispatchEscalation(row, "blocked")).toMatchObject({ decision: "unavailable:human-registry", resolved: false, dispatched: false });
    expect(await engine(posts, () => { throw new Error("read failed"); }).dispatchEscalation(row, "blocked"))
      .toMatchObject({ decision: "unavailable:human-registry", resolved: false, dispatched: false });
    expect(posts).toEqual([]);
  });

  it("generic transport failure retains its retry class, rather than a prompt alert", async () => {
    const row = await refusal(1, "transport unavailable"); const posts: unknown[] = []; const wakes: string[] = [];
    await tick(engine(posts), { attemptWake: async (_id, target) => { wakes.push(target); return "failed:offline"; } });
    expect(wakes).toEqual([seat]); expect(alerts()).toHaveLength(0); expect(posts).toEqual([]);
    expect(repo.getById(row.qitemId)?.lastNudgeResult).toMatch(/^failed:/);
  });

  it.each(["failed:offline", "delivered-ack-pending"])("shared seam: %s stays unresolved without a human; historical exhaustion is not reopened", async result => {
    const src = await repo.create({ sourceSession: "sender@fixture", destinationSession: "relay@fixture", body: "work", nudge: false });
    const { created } = await repo.handoff({ qitemId: src.qitemId, fromSession: "relay@fixture", toSession: seat, nudge: false });
    db.prepare("UPDATE queue_items SET last_nudge_result=?, ts_created=? WHERE qitem_id=?").run(result, new Date(Date.now() - 3600_000).toISOString(), created.qitemId);
    const posts: unknown[] = []; const port = engine(posts, false);
    await tick(port, { retryCap: 0 });
    const before = repo.listTransitions(created.qitemId);
    await tick(port, { retryCap: 0 }); await tick(port, { retryCap: 0 });
    expect(repo.listTransitions(created.qitemId)).toEqual(before);
    expect(notes(created.qitemId).join("\n")).toContain("unresolved-route");
    expect(notes(created.qitemId).join("\n")).not.toContain("ladder-exhausted:");
    repo.transitionLog.append({ qitemId: created.qitemId, state: created.state, actorSession: "wake-ladder@system", transitionNote: "ladder-exhausted: historical undeliverable disposition" });
    await tick(engine(posts), { retryCap: 0 });
    expect(posts).toEqual([]);
  });

  it("a durable gateway decision survives a connector interruption without a second acceptance", async () => {
    const row = await refusal(); const buffer = new DispatchBuffer(home); let sends = 0;
    const dispatcher = new GatewayDispatcher({ buffer, send: () => { sends++; throw new Error("connector disconnected after persist"); } });
    dispatcher.onCapability({ kind: "capability", connectorId: "fixture", platform: "slack", protocolVersion: 1, ops: ["post_message"] });
    const port = makeOperatorDeliveryEngine({ home, queueRepo: repo, registry: { loadHumanRegistry: () => registry },
      dispatch: (op, ref, payload, opts) => dispatcher.dispatch(op, ref, payload, opts) });
    expect(await port.dispatchEscalation(row, "blocked")).toMatchObject({ decision: "accepted-pending", dispatched: true, resolved: false });
    const pending = new DispatchBuffer(home).pending(); expect(pending).toHaveLength(1);
    expect(await port.dispatchEscalation(row, "blocked")).toMatchObject({ dispatched: true, resolved: false, decisionId: pending[0]!.decisionId });
    expect(new DispatchBuffer(home).pending()).toHaveLength(1); expect(sends).toBe(1);
    const unavailable = makeOperatorDeliveryEngine({ home, queueRepo: repo,
      registry: { loadHumanRegistry: () => ({ ok: false, error: "registry unavailable after acceptance" }) },
      dispatch: () => { throw new Error("must not dispatch again"); } });
    expect(await unavailable.dispatchEscalation(row, "blocked")).toMatchObject({ decision: "accepted-pending", dispatched: true, resolved: false });
  });

  it.each(["away", "off"] as const)("%s keeps explicit termination and its existing post/deferral policy", async availability => {
    await refusal(); const posts: unknown[] = [];
    const reg: LoadResult = { ok: true, entities: [{ ...registry.entities[0]!, prefs: { deliveryClass: "B", availability } }] };
    const port = engine(posts, () => reg); await tick(port);
    const id = alerts()[0]!.qitemId;
    await vi.waitFor(() => expect(notes(id).filter(n => n.startsWith("delivery-termination:"))).toHaveLength(1));
    if (availability === "off") await vi.waitFor(() => expect(posts).toHaveLength(1));
    await tick(port); await tick(port);
    expect(posts).toHaveLength(availability === "off" ? 1 : 0);
    if (availability === "off") expect(JSON.stringify(posts)).not.toContain("<@UFIXTURE>");
    expect(notes(id).filter(n => n.includes("dispatched-to-engine"))).toHaveLength(1);
    expect(notes(id).filter(n => n.startsWith("delivery-termination:"))).toHaveLength(1);
  });

  it("deferred delivery remains accepted once, rather than being re-resolved or sent early", async () => {
    await refusal(); const posts: unknown[] = [];
    const reg: LoadResult = { ok: true, entities: [{ ...registry.entities[0]!, prefs: { deliveryClass: "B", availability: "away" } }] };
    const port = engine(posts, () => reg); await tick(port);
    const id = alerts()[0]!.qitemId;
    await vi.waitFor(() => expect(notes(id).some(n => n.startsWith("delivery-deferral-"))).toBe(true));
    await tick(port); await tick(port);
    expect(posts).toEqual([]);
    expect(notes(id).filter(n => n.includes("dispatched-to-engine"))).toHaveLength(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM watchdog_jobs WHERE policy = ? AND state = ?").get("delivery-deferral", "active")).toEqual({ n: 1 });
  });

  it("an unadvertised connector is unresolved with no buffer entry or repeated note", async () => {
    await refusal(); const sends = vi.fn();
    const dispatcher = new GatewayDispatcher({ buffer: new DispatchBuffer(home), send: sends });
    const port = makeOperatorDeliveryEngine({ home, queueRepo: repo, registry: { loadHumanRegistry: () => registry },
      dispatch: (op, ref, payload, opts) => dispatcher.dispatch(op, ref, payload, opts) });
    await tick(port); const id = alerts()[0]!.qitemId; const before = repo.listTransitions(id);
    await tick(port); await tick(port);
    expect(repo.listTransitions(id)).toEqual(before); expect(sends).not.toHaveBeenCalled();
    expect(new DispatchBuffer(home).pending()).toEqual([]);
    expect(notes(id).join("\n")).toContain("unresolved-route decision=dispatch-refused:");
    expect(notes(id).join("\n")).not.toContain("dispatched-to-engine");
  });

  it("a manually closed alert does not reopen while its original refused episode remains", async () => {
    await refusal(); const posts: unknown[] = []; const port = engine(posts, false);
    await tick(port); const alert = alerts()[0]!;
    repo.update({ qitemId: alert.qitemId, actorSession: alert.destinationSession, state: "done", closureReason: "no-follow-on" });
    await tick(port); await tick(port);
    expect(alerts()).toHaveLength(0); expect(posts).toEqual([]);
    expect(repo.list({ limit: 1000 }).filter(row => row.tags?.includes("wake-prompt-refusal"))).toHaveLength(1);
    expect(queueRecoveryOwnsWake(db, repo.getById(episodeRows[0]!))).toBe(true);
  });

  it("a new refusal after positive clearing gets a new episode, without reopening the old alert", async () => {
    await refusal(); const posts: unknown[] = []; const port = engine(posts);
    await tick(port); await vi.waitFor(() => expect(posts).toHaveLength(1));
    const oldId = alerts()[0]!.qitemId;
    state = "clear"; await tick(port); expect(repo.getById(oldId)?.state).toBe("done");
    state = "blocked"; await refusal(0); await tick(port);
    await vi.waitFor(() => expect(posts).toHaveLength(2));
    expect(alerts()[0]!.qitemId).not.toBe(oldId);
    expect(repo.getById(oldId)?.state).toBe("done");
  });

  it("the actual transport refuses the permission prompt without any text or key input", async () => {
    const rigRepo = new RigRepository(db); const sessions = new SessionRegistry(db);
    const rig = rigRepo.createRig("fixture"); const node = rigRepo.addNode(rig.id, "worker", { role: "worker", runtime: "claude-code" });
    const session = sessions.registerSession(node.id, seat); sessions.updateStatus(session.id, "running");
    sessions.updateBinding(node.id, { tmuxSession: seat });
    const sendText = vi.fn(), sendKeys = vi.fn();
    const tmuxAdapter = { hasSession: async () => true, probeSession: async () => ({ state: "present" }),
      capturePaneContent: async () => "› 1. Yes, continue\n  2. No, cancel", getPaneCommand: async () => null,
      sendText, sendKeys } as unknown as TmuxAdapter;
    const transport = new SessionTransport({ db, rigRepo, sessionRegistry: sessions, tmuxAdapter });
    expect(await transport.send(seat, "wake")).toMatchObject({ ok: false, reason: "target_needs_input" });
    expect(sendText).not.toHaveBeenCalled(); expect(sendKeys).not.toHaveBeenCalled();
  });

});
