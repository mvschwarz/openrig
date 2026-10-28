import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { makeParkedOwnerConsumerPolicy, makeRigAnchor, PARKED_OWNER_POLICY_NAME, REFUSED_PREFIX, RESERVE_PREFIX } from "../src/domain/policies/parked-owner-consumer.js";
import type { PolicyJob } from "../src/domain/policies/types.js";
import { WatchdogHistoryLog, type WatchdogHistoryEntry } from "../src/domain/watchdog-history-log.js";
import { WatchdogJobsRepository } from "../src/domain/watchdog-jobs-repository.js";
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

  function engine(posts: unknown[], registered: boolean | (() => LoadResult) = true, to?: string[]) {
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
      dispatch: (op, ref, payload, opts) => { to?.push(ref); return wire.dispatcher.dispatch(op, ref, payload, opts); },
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

  it("a stale cross-host sender cannot prevent a prompt alert reaching the existing human route", async () => {
    const row = await refusal();
    const staleSource = "sender@remote@retired-host";
    db.prepare("UPDATE queue_items SET source_session=? WHERE qitem_id=?").run(staleSource, row.qitemId);
    repo = new QueueRepository(db, new EventBus(db), { validateRig: target => target !== staleSource });
    const posts: unknown[] = [], wakes: string[] = [];
    const port = engine(posts);
    const result = await tick(port, { attemptWake: async (_id, target) => { wakes.push(target); return "failed:fixture"; } });
    expect(result.outcome).not.toBe("failed");
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    expect(wakes).toEqual([]);
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0]?.destinationSession).toBe(seat); // carrier only, never a pane nudge
    expect(alerts()[0]?.sourceSession).toBe(staleSource); // provenance is not rewritten
    expect(JSON.stringify(posts)).toContain(row.qitemId);
    await tick(port);
    expect(posts).toHaveLength(1);
  });

  it("an invalid sender does not turn an explicit-only choice alert into a human post", async () => {
    const row = await refusal(1, `Refused: '${seat}' is at an interactive prompt (selection_prompt). No text was sent.`);
    const staleSource = "sender@remote@retired-host";
    db.prepare("UPDATE queue_items SET source_session=? WHERE qitem_id=?").run(staleSource, row.qitemId);
    repo = new QueueRepository(db, new EventBus(db), { validateRig: target => target !== staleSource });
    const posts: unknown[] = [];
    await tick(engine(posts), { humanRung: "explicit-only", loadHumanRegistry: () => registry });
    expect(alerts()).toHaveLength(1);
    expect(posts).toEqual([]);
    expect(notes(alerts()[0]!.qitemId).some(note => note.includes("human rung explicit-only"))).toBe(true);
  });

  it("HUMAN RUNG EXPLICIT-ONLY: a prompt-blocked seat still reaches a person, since only a person can clear it", async () => {
    await refusal(); const posts: unknown[] = [];
    await runWakeLadderTick({ db, queueRepo: repo, resolveOrchestrator: () => null,
      readPromptState: () => state, retryIntervalSeconds: 1, now: new Date(Date.now() + 60_000), deliveryEngine: engine(posts),
      humanRung: "explicit-only", loadHumanRegistry: () => ({ ok: true as const, entities: [] }),
      attemptWake: async () => "failed:fixture", log: () => {},
    });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(posts).toHaveLength(1);
    expect(JSON.stringify(posts)).toContain("assigned work");
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

  it("only needs-input evidence observed after the refusal can retire a positive refusal", () => {
    const refusedAt = "2026-01-01T00:00:02.000Z";
    const before = "2026-01-01T00:00:01.000Z";
    const after = "2026-01-01T00:00:03.000Z";
    const clearAt = (observedAt: string) => ({ rung: "needs-input-chrome" as const, observedAt });
    // The chrome rung is declared authoritative throughout; only the evidence differs.
    const idle = { activity: "idle-at-prompt" as const, needsInput: { count: 0, reason: null }, changedAt: before,
      needsInputEvidence: clearAt(before),
      rungs: [{ rung: "needs-input-chrome" as const, sourceId: "fixture", trust: "authoritative" as const, lastEvidenceAt: before }] };
    expect(classifyPromptAfterRefusal(idle, refusedAt)).toBe("unknown");
    expect(classifyPromptAfterRefusal({ ...idle, changedAt: refusedAt, needsInputEvidence: clearAt(refusedAt) }, refusedAt)).toBe("unknown");
    expect(classifyPromptAfterRefusal({ ...idle, changedAt: after, needsInputEvidence: clearAt(after) }, refusedAt)).toBe("clear");
    // An older clear plus a newer busy/idle update is not a clear observed after the refusal.
    expect(classifyPromptAfterRefusal({ ...idle, changedAt: after }, refusedAt)).toBe("unknown");
    // A declared rung that never reported needs-input is not a clear either.
    expect(classifyPromptAfterRefusal({ ...idle, changedAt: after, needsInputEvidence: null }, refusedAt)).toBe("unknown");
    expect(classifyPromptAfterRefusal({ ...idle, needsInput: { count: 1, reason: "permission prompt" } }, refusedAt)).toBe("blocked");
    expect(classifyPromptAfterRefusal({ ...idle, activity: "unknown", changedAt: after, needsInputEvidence: clearAt(after) }, refusedAt)).toBe("unknown");
    expect(classifyPromptAfterRefusal(null, refusedAt)).toBe("unknown");
  });

  it("activity-only Codex and generic changes cannot clear a refused prompt", () => {
    const refusedAt = "2026-01-01T00:00:02.000Z";
    const sampling = { rung: "window-sampling" as const, sourceId: "tmux", trust: "authoritative" as const, lastEvidenceAt: "2026-01-01T00:00:03.000Z" };
    const codex = { activity: "working" as const, needsInput: { count: 0, reason: null }, changedAt: "2026-01-01T00:00:03.000Z", needsInputEvidence: null,
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
    expect(log.mock.calls[0]![0]).toContain(`unreadable prompt row ${JSON.stringify(broken.qitemId)}`);
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

  // A closed disposition is a terminal row whose valid JSON tags hold the alert tag and this exact episode tag as
  // values. It keeps the episode final; anything short of that leaves the episode free to alert again.
  function episodeKey(id: string) {
    return notes(id).find(n => n.startsWith(REFUSED_PREFIX))!.slice(REFUSED_PREFIX.length).trim().split(";")[0]!.trim();
  }
  async function disposition(tagsText: string, rowState: string) {
    const row = await repo.create({ sourceSession: "sender@fixture", destinationSession: "archive@fixture", body: "earlier disposition", nudge: false });
    db.prepare("UPDATE queue_items SET tags = ?, state = ? WHERE qitem_id = ?").run(tagsText, rowState, row.qitemId);
    return row.qitemId;
  }
  const exact = (key: string) => JSON.stringify(["wake-prompt-refusal", `prompt-episode:${key}`]);
  const escaped = (tags: string[]) => `[${tags.map(t => `"${[...t].map(c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`).join("")}"`).join(",")}]`;

  it.each([
    ["exact tags on a done row", exact, "done", false],
    ["exact tags on a canceled row", exact, "canceled", false],
    ["exact tags on a handed-off row", exact, "handed-off", false],
    ["exact tags on a failed row", exact, "failed", false],
    ["exact tags on a denied row", exact, "denied", false],
    ["fully escaped tags", (k: string) => escaped(["wake-prompt-refusal", `prompt-episode:${k}`]), "done", false],
    ["object-form tags", (k: string) => JSON.stringify({ alert: "wake-prompt-refusal", episode: `prompt-episode:${k}` }), "done", false],
    ["both tags among others, with no recovery-for tag", (k: string) => JSON.stringify(["review", "wake-prompt-refusal", "prompt-destination:x@fixture", `prompt-episode:${k}`]), "done", false],
    ["exact tags on a pending row", exact, "pending", true],
    ["exact tags on an in-progress row", exact, "in-progress", true],
    ["exact tags on a blocked row", exact, "blocked", true],
    ["invalid JSON holding both strings", (k: string) => `["wake-prompt-refusal","prompt-episode:${k}"`, "done", true],
    ["the episode tag without the alert tag", (k: string) => JSON.stringify(["review", `prompt-episode:${k}`]), "done", true],
    ["a longer key sharing this key as a prefix", (k: string) => exact(`${k}0`), "done", true],
    ["another attempt for the same obligation set", (k: string) => exact(`${k.split("#")[0]}#another-attempt`), "done", true],
    ["the episode tag in another case", (k: string) => exact(k.toUpperCase()), "done", true],
    ["the alert tag as an object key, not a value", (k: string) => JSON.stringify({ "wake-prompt-refusal": `prompt-episode:${k}` }), "done", true],
    ["both tags nested one level down", (k: string) => JSON.stringify([["wake-prompt-refusal", `prompt-episode:${k}`]]), "done", true],
  ])("closed-episode lookup: %s -> alerts again: %s", async (_label, tags, rowState, alertsAgain) => {
    const row = await refusal();
    const decoy = await disposition(tags(episodeKey(row.qitemId)), rowState);
    await tick(engine([], false));
    expect(alerts().filter(a => a.qitemId !== decoy)).toHaveLength(alertsAgain ? 1 : 0);
  });

  it("one closed-episode read per tick serves every open episode, and only the closed episode stays final", async () => {
    const keys = [0, 1, 2].map(i => `${seat}|fixture${i}#1`);
    for (const [i, key] of keys.entries()) {
      const row = await repo.create({ sourceSession: "sender@fixture", destinationSession: seat, body: `episode work ${i}`, nudge: false });
      repo.update({ qitemId: row.qitemId, actorSession: "watchdog@system", transitionNote: `${RESERVE_PREFIX} ${key}; obligations ${row.qitemId}` });
      repo.update({ qitemId: row.qitemId, actorSession: "watchdog@system", transitionNote: `${REFUSED_PREFIX} ${key}; Refused: '${seat}' is at an interactive prompt` });
    }
    await disposition(exact(keys[0]!), "done");
    const prepare = vi.spyOn(db, "prepare");
    let lookups = -1;
    try {
      await tick(engine([], false));
      lookups = prepare.mock.calls.filter(([sql]) => String(sql).includes("state NOT IN ('pending','in-progress','blocked')")).length;
    } finally { prepare.mockRestore(); }
    expect(lookups).toBe(1); // one per tick; the per-episode lookup ran once per open episode (3 here)
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0]!.tags).toEqual(expect.arrayContaining([`prompt-episode:${keys[1]}`, `prompt-episode:${keys[2]}`]));
    expect(alerts()[0]!.tags).not.toContain(`prompt-episode:${keys[0]}`);
  });

  it("an open prompt recovery owns the shared failed-class escalation", async () => {
    const row = await refusal();
    // Exercise the claimed failed-class escalation seam separately from the
    // unclaimed retained-result composition below.
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

  it.each(["failed:fixture", "retained:typing_guard"])("a pending %s baton delegates retries and readback to its open prompt recovery", async lastNudgeResult => {
    const source = await repo.create({ sourceSession: "sender@fixture", destinationSession: "relay@fixture", body: "work", nudge: false });
    const { created } = await repo.handoff({ qitemId: source.qitemId, fromSession: "relay@fixture", toSession: seat, nudge: false });
    // Both ordinary failure and #623's retained typing-guard result must leave
    // continuation with the already-open prompt recovery.
    const key = `${seat}|fixture#1`;
    for (const transitionNote of [
      `parked-owner wake reserved: ${key}; obligations ${created.qitemId}`,
      `${REFUSED_PREFIX} ${key}; Refused: interactive prompt`,
    ]) repo.transitionLog.append({ qitemId: created.qitemId, state: "pending", actorSession: "watchdog@system", transitionNote });
    repo.recordNudgeAttempt(created.qitemId, lastNudgeResult);
    const posts: unknown[] = []; const port = engine(posts, false);
    const dispatch = vi.spyOn(port, "dispatchEscalation");
    const attemptWake = vi.fn(async () => "failed:fixture");
    const result = await tick(port, { attemptWake });
    expect(result.outcome).not.toBe("failed");
    expect(dispatch).toHaveBeenCalledTimes(1);
    const alert = alerts()[0]!;
    expect.soft(attemptWake).not.toHaveBeenCalled();
    expect.soft(repo.getById(created.qitemId)?.waiting?.nextBackstop).toMatchObject({
      owner: alert.destinationSession, mechanism: "queue-recovery:delegated", dueAt: null,
      recovery: { qitemId: alert.qitemId, state: "pending" },
    });
    await tick(port, { attemptWake });
    expect(attemptWake).not.toHaveBeenCalled();
    expect(alerts()).toHaveLength(1);
    expect(posts).toEqual([]);
    expect(notes(created.qitemId).join("\n")).not.toContain("ladder-exhausted:");
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

  it("QA independent: malformed prompt-bearing row cannot hide another valid prompt alert", async () => {
    const bad = await repo.create({sourceSession:"sender@fixture",destinationSession:"broken@fixture",body:"broken",nudge:false});
    const key = "broken@fixture|qa-broken#1";
    for (const transitionNote of [
      `parked-owner wake reserved: ${key}; obligations ${bad.qitemId}`,
      `${REFUSED_PREFIX} ${key}; Refused: interactive prompt`,
    ]) repo.transitionLog.append({qitemId:bad.qitemId,state:"pending",actorSession:"watchdog@system",transitionNote});
    db.prepare("UPDATE queue_items SET tags = ? WHERE qitem_id = ?").run("{",bad.qitemId);
    await refusal(); const posts: unknown[] = []; const log=vi.fn();
    for (let i=0;i<2;i++) expect((await tick(engine(posts),{log})).outcome).not.toBe("failed");
    await vi.waitFor(() => expect(posts).toHaveLength(1));
  });

  it("an unreadable episode member leaves other destinations actionable", async () => {
    const primary = await repo.create({ sourceSession: "sender@fixture", destinationSession: "broken@fixture", body: "primary", nudge: false });
    const member = await repo.create({ sourceSession: "sender@fixture", destinationSession: "broken@fixture", body: "member", nudge: false });
    const key = "broken@fixture|member#1";
    for (const transitionNote of [
      `parked-owner wake reserved: ${key}; obligations ${primary.qitemId},${member.qitemId}`,
      `${REFUSED_PREFIX} ${key}; Refused: interactive prompt`,
    ]) repo.transitionLog.append({ qitemId: primary.qitemId, state: "pending", actorSession: "watchdog@system", transitionNote });
    db.prepare("UPDATE queue_items SET tags = ? WHERE qitem_id = ?").run("{", member.qitemId);
    await refusal(); const posts: unknown[] = []; const port = engine(posts); const log = vi.fn();
    for (let i = 0; i < 2; i++) expect((await tick(port, { log })).outcome).not.toBe("failed");
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    expect(JSON.stringify(posts)).toContain(episodeRows[0]);
    expect(JSON.stringify(posts)).not.toContain(primary.qitemId);
    expect(log.mock.calls.filter(([message]) => String(message).includes(member.qitemId))).toHaveLength(2);
  });

  it.each(["primary", "member"] as const)("an unreadable %s cannot retire an existing alert or clear its episode", async (which) => {
    await refusal(2); const posts: unknown[] = []; const port = engine(posts, false);
    await tick(port); const alert = alerts()[0]!;
    const badId = episodeRows[which === "primary" ? 0 : 1]!;
    const before = repo.listTransitions(alert.qitemId);
    db.prepare("UPDATE queue_items SET tags = ? WHERE qitem_id = ?").run("{", badId);
    const log = vi.fn(); state = "clear";
    for (let i = 0; i < 2; i++) expect((await tick(port, { log })).outcome).not.toBe("failed");
    expect(repo.getById(alert.qitemId)?.state).toBe("pending");
    expect(repo.listTransitions(alert.qitemId)).toEqual(before);
    expect(notes(episodeRows[0]!).some(note => note.includes("interactive prompt cleared"))).toBe(false);
    expect(log.mock.calls.filter(([message]) => String(message).includes(badId))).toHaveLength(2);
    expect(posts).toEqual([]);
    db.prepare("UPDATE queue_items SET tags = ? WHERE qitem_id = ?").run("[]", badId);
    await tick(port);
    expect(repo.getById(alert.qitemId)?.state).toBe("done");
  });

  // A two-hour reminder refused at the seat's prompt, recorded the way the watchdog engine records its attempts.
  function reminder(outcomes: Array<"refused" | "sent">) {
    const { jobId } = new WatchdogJobsRepository(db).register({ policy: "periodic-reminder", targetSession: seat, intervalSeconds: 7200,
      specYaml: `policy: periodic-reminder\ntarget:\n  session: ${seat}\ninterval_seconds: 7200\nmessage: sweep\n`, registeredBySession: seat });
    // Attempts are stamped in real time, in order, so a ladder tick's own records fall between them as they would.
    const log = new WatchdogHistoryLog(db); let last = 0;
    const record = (outcome: "refused" | "sent", kind = "selection_prompt") => log.record({ jobId, evaluatedAt: new Date(last = Math.max(Date.now(), last + 1)).toISOString(), outcome,
      deliveryTargetSession: seat, deliveryStatus: outcome === "sent" ? "ok" : "failed",
      evaluationNotes: outcome === "refused" ? { deliveryReason: `Refused: '${seat}' is at an interactive prompt (${kind}). No text was sent.` } : null });
    outcomes.forEach(outcome => record(outcome));
    return { jobId, record };
  }

  it("a reminder refused twice at the prompt reaches the seat's orchestrator, and the alert stands down once one lands", async () => {
    const posts: unknown[] = []; const port = engine(posts); const wakes: string[] = [];
    const opts = { resolveOrchestrator: () => "lead@fixture", attemptWake: async (_id: string, target: string) => { wakes.push(target); return "verified"; } };
    const { jobId, record } = reminder(["refused"]);
    await tick(port, opts);
    expect(alerts()).toEqual([]);
    record("refused");
    await tick(port, opts);
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0]?.destinationSession).toBe("lead@fixture");
    expect(alerts()[0]?.body).toContain(jobId);
    record("sent");
    await tick(port, opts);
    expect(alerts()).toEqual([]);
    expect(wakes).toEqual(["lead@fixture"]); expect(posts).toEqual([]);
  });

  it("a seat with no orchestrator: its twice-refused reminder reaches a person, never the blocked seat", async () => {
    const posts: unknown[] = []; const port = engine(posts);
    const { jobId } = reminder(["refused", "refused"]);
    await tick(port);
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    expect(JSON.stringify(posts)).toContain(jobId);
  });


  const toLead = (wakes: string[]) => ({ resolveOrchestrator: () => "lead@fixture",
    attemptWake: async (_id: string, target: string) => { wakes.push(target); return "verified"; } });

  it.each([[49, false], [50, false], [51, false], [51, true]] as const)("%i refusals after a delivered reminder stay one episode (first alert closed by hand: %s)", async (count, closed) => {
    const port = engine([]); const wakes: string[] = [];
    const { record } = reminder(["sent", "refused", "refused"]);
    await tick(port, toLead(wakes));
    const [alert] = alerts();
    if (closed) repo.update({ qitemId: alert!.qitemId, actorSession: "lead@fixture", state: "done", closureReason: "no-follow-on", transitionNote: "handled by hand" });
    for (let i = 2; i < count; i++) record("refused");
    await tick(port, toLead(wakes));
    expect(alerts().map(a => a.qitemId)).toEqual(closed ? [] : [alert!.qitemId]);
    expect(wakes).toEqual(["lead@fixture"]);
  });

  it("a prompt that clears and comes back between reminders raises a new alert after two new refusals", async () => {
    const port = engine([]); const wakes: string[] = [];
    const { record } = reminder(["refused", "refused"]);
    await tick(port, toLead(wakes));
    const [first] = alerts();
    state = "clear"; await tick(port, toLead(wakes));
    expect(alerts()).toEqual([]);
    state = "blocked"; await tick(port, toLead(wakes));
    record("refused"); await tick(port, toLead(wakes));
    expect(alerts()).toEqual([]);
    record("refused"); await tick(port, toLead(wakes));
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0]?.qitemId).not.toBe(first!.qitemId);
    expect(wakes).toEqual(["lead@fixture", "lead@fixture"]);
  });

  it("another job's alert retiring while the prompt stays blocked doesn't restart an episode closed by hand", async () => {
    const port = engine([]); const wakes: string[] = [];
    const a = reminder(["sent", "refused", "refused"]);
    await tick(port, toLead(wakes));
    const [closedByHand] = alerts();
    repo.update({ qitemId: closedByHand!.qitemId, actorSession: "lead@fixture", state: "done", closureReason: "no-follow-on", transitionNote: "handled by hand" });
    const b = reminder(["refused", "refused"]);
    await tick(port, toLead(wakes));
    expect(alerts()).toHaveLength(1);
    new WatchdogJobsRepository(db).stop(b.jobId);
    await tick(port, toLead(wakes));
    expect(alerts()).toEqual([]);
    a.record("refused"); a.record("refused");
    await tick(port, toLead(wakes));
    expect(alerts()).toEqual([]);
    expect(wakes).toEqual(["lead@fixture", "lead@fixture"]);
  });

  it("a prompt alert routed to a fallback still records a cleared prompt, so the next blocked episode alerts", async () => {
    const port = engine([]); const wakes: string[] = [];
    const { record } = reminder(["sent", "refused", "refused"]);
    await tick(port, toLead(wakes));
    const [first] = alerts();
    repo.routeToFallback(first!.qitemId, "backup@fixture", "lead removed");
    state = "clear"; await tick(port, toLead(wakes));
    expect(alerts()).toEqual([]);
    state = "blocked"; record("refused"); record("refused");
    await tick(port, toLead(wakes));
    expect(alerts()).toHaveLength(1);
    expect(wakes).toEqual(["lead@fixture", "lead@fixture"]);
  });

  it("a reminder that joins a seat's existing prompt alert is named on it, and nothing is sent again", async () => {
    await refusal(); const port = engine([]); const wakes: string[] = [];
    await tick(port, toLead(wakes));
    const [alert] = alerts();
    const { jobId } = reminder(["refused", "refused"]);
    await tick(port, toLead(wakes));
    expect(alerts().map(a => a.qitemId)).toEqual([alert!.qitemId]);
    expect(notes(alert!.qitemId)).toContain(`wake-escalation watchdog reminders added: ${jobId}`);
    expect(wakes).toEqual(["lead@fixture"]);
  });

  // #81: a Claude seat at a choice prompt no hook announces (its weekly usage-limit dialog) holds open rows. Its own
  // evidence stays unknown, so before this only the transport's refusal knew, and nothing escalated.
  const choiceRefusal = `Refused: '${seat}' is at an interactive prompt (selection_prompt). A message must not select or approve it.`;

  it("#81: a choice prompt no hook announces reaches the registry's first human after one retry interval, never the seat", async () => {
    const row = await refusal(1, choiceRefusal); state = "unknown";
    const posts: unknown[] = []; const to: string[] = []; const port = engine(posts, true, to);
    // Inside the interval: a prompt someone answers within seconds never escalates.
    await tick(port, { now: new Date() });
    expect(alerts()).toEqual([]);
    await tick(port);
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    // The operator rung's only route is the human registry's first entry; the blocked seat is never typed into.
    expect(to).toEqual(["human-owner@external"]);
    expect(JSON.stringify(posts)).toContain("assigned work");
    expect(repo.getById(row.qitemId)?.state).toBe("in-progress");
    await tick(port); expect(posts).toHaveLength(1);
  });

  it("#81: other refusals with no evidence keep waiting for it, as before", async () => {
    await refusal(); state = "unknown"; const posts: unknown[] = []; const port = engine(posts);
    await tick(port); await tick(port);
    expect(alerts()).toEqual([]); expect(posts).toEqual([]);
  });

  it("#81: a choice prompt with newer clearing evidence stays quiet past the interval", async () => {
    await refusal(1, choiceRefusal); state = "clear"; const posts: unknown[] = []; const port = engine(posts);
    await tick(port);
    expect(alerts()).toEqual([]); expect(posts).toEqual([]);
    expect(notes(episodeRows[0]!).some(note => note.includes("interactive prompt cleared"))).toBe(true);
  });

  // An open refused episode at `who`, as the parked-owner policy records it; `at` backdates its notes.
  async function refusedEpisode(who: string, kind = "selection_prompt", at?: string, n = 1) {
    const row = await repo.create({ sourceSession: "sender@fixture", destinationSession: who, body: `work held by ${who}`, summary: `work held by ${who}`, nudge: false });
    const key = `${who}|fixture#${n}`;
    for (const transitionNote of [`${RESERVE_PREFIX} ${key}; obligations ${row.qitemId}`,
      `${REFUSED_PREFIX} ${key}; Refused: '${who}' is at an interactive prompt (${kind}). No text was sent.`]) {
      repo.transitionLog.append({ qitemId: row.qitemId, state: "pending", actorSession: "watchdog@system", transitionNote });
    }
    if (at) db.prepare("UPDATE queue_transitions SET ts = ? WHERE qitem_id = ? AND (transition_note LIKE ? OR transition_note LIKE ?)")
      .run(at, row.qitemId, `${RESERVE_PREFIX}%`, `${REFUSED_PREFIX}%`);
    return row;
  }

  it("#81: seats blocked at a prompt together (a shared usage limit) post to the person once; the next posts after that alert retires", async () => {
    await refusedEpisode("first@fixture"); await refusedEpisode("second@fixture");
    const posts: unknown[] = []; const to: string[] = []; const port = engine(posts, true, to);
    const states: Record<string, "blocked" | "clear" | "unknown"> = { "first@fixture": "blocked", "second@fixture": "blocked" };
    const read = { readPromptState: (dest: string) => states[dest] ?? "unknown" };
    await tick(port, read); await tick(port, read);
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    const dispatched = alerts().filter(a => notes(a.qitemId).some(n => n.includes("operator dispatched-to-engine")));
    const waiting = alerts().filter(a => notes(a.qitemId).some(n => n.includes("operator waiting on")));
    expect(dispatched).toHaveLength(1); expect(waiting).toHaveLength(1);
    expect(notes(waiting[0]!.qitemId).join("\n")).toContain(`operator waiting on ${dispatched[0]!.qitemId}`);
    expect(to).toEqual(["human-owner@external"]);
    const postedSeat = dispatched[0]!.tags!.find(t => t.startsWith("prompt-destination:"))!.slice("prompt-destination:".length);
    states[postedSeat] = "clear";
    await tick(port, read); await tick(port, read);
    expect(repo.getById(dispatched[0]!.qitemId)?.state).toBe("done");
    await vi.waitFor(() => expect(posts).toHaveLength(2));
    expect(to).toEqual(["human-owner@external", "human-owner@external"]);
  });

  it("#81: a permission prompt never waits behind a posted choice-prompt alert", async () => {
    await refusedEpisode("choice@fixture"); await refusedEpisode("approve@fixture", "permission_prompt");
    const posts: unknown[] = []; const port = engine(posts);
    const read = { readPromptState: () => "blocked" as const };
    await tick(port, read); await tick(port, read);
    await vi.waitFor(() => expect(posts).toHaveLength(2));
    expect(alerts().some(a => notes(a.qitemId).some(n => n.includes("operator waiting on")))).toBe(false);
  });

  const ago = (base: number, seconds: number) => new Date(base - seconds * 1000).toISOString();

  it.each(["selection_prompt", "permission_prompt"])("#81: a choice prompt cleared before a new %s refusal lends it no age", async kind => {
    const base = Date.now(); const clearedAt = Date.parse(ago(base, 2));
    await refusedEpisode("again@fixture", "selection_prompt", ago(base, 300), 1);
    await refusedEpisode("again@fixture", kind, ago(base, 1), 2);
    const posts: unknown[] = []; const port = engine(posts);
    // Evidence at T-2s cleared the first prompt; the new refusal at T-1s has nothing newer.
    await tick(port, { now: new Date(base), readPromptState: (_dest, refusedAt) => Date.parse(refusedAt) < clearedAt ? "clear" : "unknown" });
    expect(alerts()).toEqual([]); expect(posts).toEqual([]);
  });

  it("#81: a choice prompt that never cleared keeps its age when new work's refusal arrives", async () => {
    const base = Date.now();
    await refusedEpisode("again@fixture", "selection_prompt", ago(base, 300), 1);
    await refusedEpisode("again@fixture", "selection_prompt", ago(base, 1), 2);
    const posts: unknown[] = []; const port = engine(posts);
    await tick(port, { now: new Date(base), readPromptState: () => "unknown" });
    await vi.waitFor(() => expect(posts).toHaveLength(1));
  });

  const toOps = { humanRung: "explicit-only" as const, loadHumanRegistry: () => ({ ok: true as const, entities: [] }) };

  it("#81: under explicit-only a choice-prompt alert stays with an agent operator seat; a permission prompt beside it still posts", async () => {
    vi.stubEnv("OPENRIG_WORKSPACE_OPERATOR_SEAT_NAME", "ops@fixture");
    try {
      await refusedEpisode("choice@fixture"); await refusedEpisode("approve@fixture", "permission_prompt");
      const posts: unknown[] = []; const port = engine(posts);
      const opts = { ...toOps, readPromptState: () => "blocked" as const };
      await tick(port, opts); await tick(port, opts);
      await vi.waitFor(() => expect(posts).toHaveLength(1));
      await tick(port, opts); expect(posts).toHaveLength(1);
      expect(JSON.stringify(posts)).toContain("approve@fixture");
      const alertFor = (dest: string) => alerts().find(a => a.tags?.includes(`prompt-destination:${dest}`))!;
      expect(alertFor("choice@fixture").destinationSession).toBe("ops@fixture");
      expect(alertFor("choice@fixture").tags).toContain("prompt-kind:choice");
      expect(alertFor("approve@fixture").tags).not.toContain("prompt-kind:choice");
      expect(notes(alertFor("choice@fixture").qitemId).join("\n")).toContain("human rung explicit-only; not posted to a person");
    } finally { vi.unstubAllEnvs(); }
  });

  it("#81: a reminder refused twice at a choice prompt follows explicit-only too", async () => {
    vi.stubEnv("OPENRIG_WORKSPACE_OPERATOR_SEAT_NAME", "ops@fixture");
    try {
      const posts: unknown[] = []; const port = engine(posts);
      reminder(["refused", "refused"]);
      await tick(port, toOps);
      const [alert] = alerts();
      expect(alert?.tags).toContain("prompt-kind:choice");
      expect(notes(alert!.qitemId).join("\n")).toContain("human rung explicit-only; not posted to a person");
      expect(new DispatchBuffer(home).pending()).toEqual([]);
      expect(posts).toEqual([]);
    } finally { vi.unstubAllEnvs(); }
  });

  it("#81: a permission prompt that joins a choice alert the explicit-only floor kept from a person still posts, once", async () => {
    vi.stubEnv("OPENRIG_WORKSPACE_OPERATOR_SEAT_NAME", "ops@fixture");
    try {
      await refusedEpisode("mixed@fixture", "selection_prompt", undefined, 1);
      const posts: unknown[] = []; const port = engine(posts);
      const opts = { ...toOps, readPromptState: () => "blocked" as const };
      await tick(port, opts);
      const [alert] = alerts();
      expect(posts).toEqual([]);
      await refusedEpisode("mixed@fixture", "permission_prompt", undefined, 2);
      await tick(port, { ...opts, now: new Date(Date.now() + 240_000) });
      await vi.waitFor(() => expect(posts).toHaveLength(1));
      await tick(port, { ...opts, now: new Date(Date.now() + 360_000) }); expect(posts).toHaveLength(1);
      expect(alerts().map(a => a.qitemId)).toEqual([alert!.qitemId]);
      expect(alerts()[0]!.tags).not.toContain("prompt-kind:choice");
      expect(notes(alert!.qitemId).join("\n")).toContain("explicit-only floor");
    } finally { vi.unstubAllEnvs(); }
  });

  it("#81: a reminder whose latest refusal turns from a choice to a permission prompt still posts after the explicit-only floor", async () => {
    vi.stubEnv("OPENRIG_WORKSPACE_OPERATOR_SEAT_NAME", "ops@fixture");
    try {
      const posts: unknown[] = []; const port = engine(posts);
      const { record } = reminder(["refused", "refused"]);
      await tick(port, toOps);
      expect(posts).toEqual([]);
      record("refused", "permission_prompt");
      await tick(port, { ...toOps, now: new Date(Date.now() + 240_000) });
      await vi.waitFor(() => expect(posts).toHaveLength(1));
      expect(alerts()[0]!.tags).not.toContain("prompt-kind:choice");
    } finally { vi.unstubAllEnvs(); }
  });

});
