import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { migrate } from "../src/db/migrate.js";
import { EventBus } from "../src/domain/event-bus.js";
import { resolveExternal } from "../src/domain/gateway/external-admission.js";
import type { HumanFragment } from "../src/domain/gateway/human-registry.js";
import { QueueRepository, type QueueCreateInput, type QueueItem } from "../src/domain/queue-repository.js";
import { archiveAgedTerminalTransitions } from "../src/domain/queue-retention.js";
import { createStuckSweepStatus, findingDedupTag, runStuckSweep, STUCK_SWEEP_FINDING_TAG } from "../src/domain/queue-stuck-sweep.js";
import { parseSessionName } from "../src/domain/session-name.js";

describe("#514 custody findings for a human decision", () => {
  const owner: HumanFragment = {
    entityId: "owner", class: "human", displayName: "Owner", address: "owner@external",
    connectorBindings: [{ kind: "slack", connectorRef: "slack:test", secretsRef: "vault:test", role: "primary" }],
    prefs: { deliveryClass: "A" },
  };
  let db: Database.Database;
  let repo: QueueRepository;
  let sent: string[];
  let logs: string[];
  let status: ReturnType<typeof createStuckSweepStatus>;
  let registryError: string | null;
  let registeredHumans: HumanFragment[];

  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db, ALL_MIGRATIONS);
    sent = [];
    logs = [];
    status = createStuckSweepStatus();
    registryError = null;
    registeredHumans = [owner];
    repo = new QueueRepository(db, new EventBus(db), {
      validateRig: (destination) => {
        const parsed = parseSessionName(destination);
        // Use the same external-entity admission rule as daemon startup.
        return parsed.kind !== "external" || resolveExternal(parsed.local, registryError ? [] : registeredHumans).kind !== "unregistered";
      },
      loadHumanRegistry: () => registryError ? { ok: false, error: registryError } : { ok: true, entities: registeredHumans },
      transport: { send: async (destination) => { sent.push(destination); return { ok: true, verified: true }; } },
    });
  });
  afterEach(() => { db.close(); });

  async function ask(destinationSession = "owner@external", sourceSession = "asker@r") {
    return repo.create({ sourceSession, destinationSession, body: "Approve the proposed change?",
      summary: "Approve the change", evidenceRef: "https://example.test/change", nudge: false });
  }

  async function close(qitemId: string, actorSession = "closer@r") {
    await repo.update({ qitemId, actorSession, state: "done", closureReason: "handed_off_to", closureTarget: "next@r" });
  }

  function sweepResult() {
    return runStuckSweep({ db, queueRepo: repo, status, resolveOrchestrator: () => null,
      unclaimedAgeMinutes: 60, isRegisteredHost: () => false, log: (line) => { logs.push(line); } });
  }

  async function sweep() {
    const result = await sweepResult();
    expect(result.outcome, result.error).not.toBe("failed");
    return result;
  }

  function findings(qitemId: string) {
    return repo.list({ limit: 100 }).filter((row) => row.tags?.includes(findingDedupTag("dangling-closure", qitemId)));
  }

  function custodyInput(row: QueueItem): QueueCreateInput {
    return { qitemId: "qitem-custody-finding", sourceSession: row.sourceSession, destinationSession: row.destinationSession,
      body: "Verify the successor's custody", summary: "Successor verification required",
      evidenceRef: `rig queue show ${row.qitemId}`,
      tags: [STUCK_SWEEP_FINDING_TAG, findingDedupTag("dangling-closure", row.qitemId)] };
  }

  function archive(qitemId: string) {
    const old = new Date(Date.now() - 31 * 86_400_000).toISOString();
    db.prepare("UPDATE queue_transitions SET ts = ? WHERE qitem_id = ?").run(old, qitemId);
    expect(archiveAgedTerminalTransitions(db, { nowIso: new Date().toISOString() }).archivedQitems).toBe(1);
    expect(db.prepare("SELECT 1 FROM queue_transitions WHERE qitem_id = ?").get(qitemId)).toBeUndefined();
  }

  it.each(["owner@external", "human@host", "human-reviewer@kernel", "owner@kernel"])(
    "sends %s custody verification to the closing agent, without another human notification",
    async (destination) => {
      const row = await ask(destination);
      await close(row.qitemId);
      // Neither an agent's later annotation nor gateway bookkeeping owns this closure.
      await repo.update({ qitemId: row.qitemId, actorSession: "annotator@r", transitionNote: "Checking the audit trail" });
      await repo.update({ qitemId: row.qitemId, actorSession: "daemon@kernel",
        transitionNote: "slack-owner-notification-posted notification_key=fixture level=NOTICE message_ts=1.2" });

      await sweep();
      expect(findings(row.qitemId)).toHaveLength(1);
      const [finding] = findings(row.qitemId);
      expect(finding).toMatchObject({ sourceSession: "asker@r", destinationSession: "closer@r", state: "pending",
        evidenceRef: `rig queue show ${row.qitemId}` });
      expect(finding!.summary).toContain("successor-verification-required");
      expect(finding!.body).toContain("rig queue list --destination next@r");
      expect(finding!.tags).toContain(STUCK_SWEEP_FINDING_TAG);
      expect(repo.transitionLog.latestOwnerNotificationForQitem(finding!.qitemId)).toBeNull();
      expect(sent).toEqual(["closer@r"]);
    },
  );

  it("retains the closing agent after retention archives the closure and newer notes arrive", async () => {
    const row = await ask();
    await close(row.qitemId);
    archive(row.qitemId);
    await repo.update({ qitemId: row.qitemId, actorSession: "annotator@r", transitionNote: "Reviewing the old closure" });

    await sweep();
    expect(findings(row.qitemId)).toHaveLength(1);
    expect(findings(row.qitemId)[0]!.destinationSession).toBe("closer@r");
  });

  it.each([false, true])("uses the new closure after a deliberate reopen (old history archived: %s)", async (archived) => {
    const row = await ask();
    await close(row.qitemId, "old-closer@r");
    if (archived) archive(row.qitemId);
    await repo.update({ qitemId: row.qitemId, actorSession: "repairer@r", state: "pending", reopen: true,
      transitionNote: "Recheck the handoff" });
    await close(row.qitemId, "new-closer@r");

    await sweep();
    expect(findings(row.qitemId)).toHaveLength(1);
    expect(findings(row.qitemId)[0]!.destinationSession).toBe("new-closer@r");
  });

  it.each(["owner@external", "human@host", "owner@kernel", "watchdog@system", "queue@system", "daemon@kernel"])(
    "falls back to the asking agent when the closure actor is %s",
    async (actor) => {
      const row = await ask();
      await close(row.qitemId, actor);
      await sweep();
      expect(findings(row.qitemId)).toHaveLength(1);
      expect(findings(row.qitemId)[0]!.destinationSession).toBe("asker@r");
      expect(sent).toEqual(["asker@r"]);
    },
  );

  it("falls back to the asking agent when a historical closure has no transition record", async () => {
    const row = await ask();
    // Pre-log history can carry custody fields without an attributable closure.
    db.prepare("UPDATE queue_items SET state = 'done', closure_reason = 'handed_off_to', closure_target = 'next@r' WHERE qitem_id = ?")
      .run(row.qitemId);
    await sweep();
    expect(findings(row.qitemId)).toHaveLength(1);
    expect(findings(row.qitemId)[0]!.destinationSession).toBe("asker@r");
  });

  it.each([
    { sourceAdmitted: true, destination: "asker@r" },
    { sourceAdmitted: false, destination: "owner@external" },
  ])("keeps the sweep running with an unadmitted closer (source admitted: $sourceAdmitted)", async ({ sourceAdmitted, destination }) => {
    repo = new QueueRepository(db, new EventBus(db), {
      validateRig: (session) => session === owner.address || (sourceAdmitted && session === "asker@r"),
      loadHumanRegistry: () => ({ ok: true, entities: [owner] }),
      transport: { send: async (session) => { sent.push(session); return { ok: true, verified: true }; } },
    });
    const row = await ask();
    await close(row.qitemId, "closer@remote-rig");

    await sweep();
    expect(findings(row.qitemId)).toHaveLength(1);
    expect(findings(row.qitemId)[0]!.destinationSession).toBe(destination);
    expect(sent).not.toContain("closer@remote-rig");
  });

  it("routes a superseded human item to the agent that canceled it", async () => {
    const row = await ask();
    await repo.update({ qitemId: row.qitemId, actorSession: "closer@r", state: "canceled",
      closureReason: "superseded", closureTarget: "qitem-missing-replacement" });
    await sweep();
    expect(findings(row.qitemId)).toHaveLength(1);
    expect(findings(row.qitemId)[0]!.destinationSession).toBe("closer@r");
  });

  it("does not assign an earlier agent's closure to a later human cancellation", async () => {
    const row = await ask();
    await close(row.qitemId, "old-closer@r");
    await repo.update({ qitemId: row.qitemId, actorSession: "repairer@r", state: "pending", reopen: true,
      transitionNote: "Recheck the handoff" });
    // A plain cancel retains the row's old custody fields, but is a new terminal transition.
    await repo.update({ qitemId: row.qitemId, actorSession: "owner@external", state: "canceled" });
    await sweep();
    expect(findings(row.qitemId)).toHaveLength(1);
    expect(findings(row.qitemId)[0]!.destinationSession).toBe("asker@r");
  });

  it("keeps the established destination when neither the closer nor the source is an agent", async () => {
    const row = await ask("owner@external", "human@host");
    await close(row.qitemId, "owner@kernel");
    await sweep();
    expect(findings(row.qitemId)).toHaveLength(1);
    expect(findings(row.qitemId)[0]!.destinationSession).toBe("owner@external");
  });

  it("keeps an agent destination's existing custody route", async () => {
    const row = await ask("worker@r");
    await close(row.qitemId);
    await sweep();
    expect(findings(row.qitemId)).toHaveLength(1);
    expect(findings(row.qitemId)[0]!.destinationSession).toBe("worker@r");
  });

  it.each([
    { destination: "owner@kernel", actor: "closer@r", source: "asker@r", terminalWakes: ["owner@kernel"] },
    { destination: "worker@r", actor: "closer@r", source: "asker@r", terminalWakes: ["worker@r"] },
    // An external person's destination needs the registry to admit it: during an outage that case fails the pass, as on
    // main, and is covered in "an external person's custody finding during a registry outage" below.
  ])("keeps the established route when registry classification is unavailable for $destination / $actor / $source", async ({ destination, actor, source, terminalWakes }) => {
    const row = await ask(destination, source);
    await close(row.qitemId, actor);
    registryError = "fixture human registry is unreadable";

    const result = await sweep();
    expect(result).toMatchObject({ outcome: "findings", findings: [{ qitemId: row.qitemId, action: "created" }] });
    expect(findings(row.qitemId)).toHaveLength(1);
    const [finding] = findings(row.qitemId);
    expect(finding!.destinationSession).toBe(destination);
    expect(sent).toEqual(terminalWakes);
    expect(logs).toEqual([expect.stringContaining(registryError)]);
    expect(logs[0]).toContain(row.qitemId);

    registryError = null;
    logs.length = 0;
    expect((await sweep()).findings).toContainEqual(expect.objectContaining({ findingQitemId: finding!.qitemId, action: "refreshed" }));
    expect(findings(row.qitemId)).toHaveLength(1);
    expect(findings(row.qitemId)[0]!.destinationSession).toBe(destination);
    expect(sent).toEqual(terminalWakes);
    expect(logs).toEqual([]);
  });

  it("routes a human row closed as handed-off to the agent that handed it off", async () => {
    const row = await ask();
    await repo.update({ qitemId: row.qitemId, actorSession: "closer@r", state: "handed-off", closureReason: "handed_off_to", closureTarget: "next@r" });

    expect((await sweep()).findings).toContainEqual(expect.objectContaining({ qitemId: row.qitemId, action: "created" }));
    expect(findings(row.qitemId)).toEqual([expect.objectContaining({ destinationSession: "closer@r" })]);
  });

  describe("an external person's custody finding during a registry outage", () => {
    it("still refuses ordinary creates to a previously admitted external destination", async () => {
      const row = await ask();
      await close(row.qitemId);
      registryError = "fixture human registry is unreadable";
      const input = custodyInput(row);

      await expect(repo.create(input)).rejects.toMatchObject({ code: "human_registry_unavailable" });
      expect(repo.getById(input.qitemId!)).toBeNull();
      expect(sent).toEqual([]);
    });

    it("fails the pass as main does, then creates the finding for the closer once the registry is repaired", async () => {
      const row = await ask();
      await repo.update({ qitemId: row.qitemId, actorSession: "closer@r", state: "canceled",
        closureReason: "superseded", closureTarget: "qitem-missing-replacement" });
      registryError = "fixture human registry is unreadable";

      const during = await sweepResult();
      expect(during.outcome).toBe("failed");
      expect(during.error).toContain("human registry");
      expect(findings(row.qitemId)).toEqual([]);
      expect(sent).toEqual([]);

      registryError = null;
      expect((await sweep()).findings).toContainEqual(expect.objectContaining({ qitemId: row.qitemId, action: "created" }));
      expect(findings(row.qitemId)).toEqual([expect.objectContaining({ destinationSession: "closer@r", state: "pending" })]);
      expect(sent).toEqual(["closer@r"]);
    });
  });

  it("preserves an open custody finding while its registry classification is unknown", async () => {
    const row = await ask("owner@kernel");
    await close(row.qitemId);
    await sweep();
    const [finding] = findings(row.qitemId);
    const transitions = repo.transitionLog.listForQitem(finding!.qitemId);
    registryError = "fixture human registry is unreadable";

    expect((await sweep()).findings).toContainEqual(expect.objectContaining({ findingQitemId: finding!.qitemId, action: "refreshed" }));
    expect(findings(row.qitemId)).toHaveLength(1);
    expect(repo.getById(finding!.qitemId)).toMatchObject({ state: "pending", destinationSession: "closer@r" });
    expect(repo.transitionLog.listForQitem(finding!.qitemId)).toEqual(transitions);
    expect(sent).toEqual(["closer@r"]);
    expect(logs).toEqual([expect.stringContaining(registryError)]);

    registryError = null;
    expect((await sweep()).findings).toContainEqual(expect.objectContaining({ findingQitemId: finding!.qitemId, action: "refreshed" }));
  });

  it("keeps reserved human and legacy agent classification when the registry is unavailable", async () => {
    const row = await ask();
    await close(row.qitemId, "r00-closer");
    registryError = "fixture human registry is unreadable";

    await sweep();
    expect(findings(row.qitemId)).toHaveLength(1);
    expect(findings(row.qitemId)[0]!.destinationSession).toBe("r00-closer");
    expect(sent).toEqual(["r00-closer"]);
    expect(logs).toEqual([]);
  });

  it.each([
    { destination: "worker@r", registryInitiallyUnavailable: true, terminalWakes: ["overdue@r", "unclaimed@r", "worker@r"] },
  ])("routes $destination custody, unclaimed and overdue findings with an unavailable human registry", async ({ destination, registryInitiallyUnavailable, terminalWakes }) => {
    if (registryInitiallyUnavailable) registryError = "fixture human registry is unavailable";
    const custody = await ask(destination);
    await close(custody.qitemId);
    registryError = "fixture human registry is unavailable";
    const unclaimed = await ask("unclaimed@r");
    const past = new Date(Date.now() - 90 * 60_000).toISOString();
    db.prepare("UPDATE queue_items SET ts_created = ? WHERE qitem_id = ?").run(past, unclaimed.qitemId);
    db.prepare("UPDATE queue_transitions SET ts = ? WHERE qitem_id = ?").run(past, unclaimed.qitemId);
    const overdue = await ask("overdue@r");
    repo.claim({ qitemId: overdue.qitemId, destinationSession: "overdue@r" });
    db.prepare("UPDATE queue_items SET closure_required_at = ? WHERE qitem_id = ?").run(past, overdue.qitemId);

    const result = await sweep();
    expect(result.findings).toHaveLength(3);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "dangling-closure", qitemId: custody.qitemId, action: "created" }),
      expect.objectContaining({ kind: "unclaimed-obligation", qitemId: unclaimed.qitemId, action: "created" }),
      expect.objectContaining({ kind: "overdue-claim", qitemId: overdue.qitemId, action: "created" }),
    ]));
    const destinations = ["overdue@r", "unclaimed@r", destination].sort();
    expect(result.findings.map((f) => repo.getById(f.findingQitemId)!.destinationSession).sort()).toEqual(destinations);
    expect(sent.sort()).toEqual(terminalWakes);
    expect(logs).toEqual([expect.stringContaining(registryError)]);
    expect(status.snapshot()).toMatchObject({ lastOutcome: "findings", lastError: null, consecutiveFailures: 0, findingsRouted: 3 });

    expect((await sweep()).findings.map((f) => f.action)).toEqual(["refreshed", "refreshed", "refreshed"]);
    expect(sent.sort()).toEqual(terminalWakes);
  });

  it.each([
    { destination: "worker@r", terminalWakes: ["worker@r"] },
  ])("closes a repaired finding while $destination custody needs the unavailable registry", async ({ destination, terminalWakes }) => {
    const repaired = await ask("owner@kernel");
    await close(repaired.qitemId);
    await sweep();
    const [finding] = findings(repaired.qitemId);
    const unresolved = await ask(destination);
    await close(unresolved.qitemId);
    registryError = "fixture human registry is unreadable";
    await repo.create({ sourceSession: "closer@r", destinationSession: "next@r", body: "Continue approved work",
      chainOfRecord: [repaired.qitemId], nudge: false });
    sent.length = 0;

    const result = await sweep();
    expect(result.findings).toHaveLength(2);
    expect(result.findings).toContainEqual(expect.objectContaining({ findingQitemId: finding!.qitemId, action: "closed" }));
    expect(repo.getById(finding!.qitemId)).toMatchObject({ state: "done", closureReason: "no-follow-on", destinationSession: "closer@r" });
    expect(result.findings).toContainEqual(expect.objectContaining({ qitemId: unresolved.qitemId, action: "created" }));
    expect(findings(unresolved.qitemId)[0]!.destinationSession).toBe(destination);
    expect(sent).toEqual(terminalWakes);
    expect(logs).toEqual([expect.stringContaining(registryError)]);
  });

  it("deduplicates the agent's finding and closes it when a linked successor repairs custody", async () => {
    const row = await ask();
    await close(row.qitemId);
    const original = db.prepare("SELECT * FROM queue_items WHERE qitem_id = ?").get(row.qitemId);
    await sweep();
    expect(findings(row.qitemId)).toHaveLength(1);
    const [finding] = findings(row.qitemId);
    expect(finding!.destinationSession).toBe("closer@r");
    const transitions = repo.transitionLog.listForQitem(finding!.qitemId);

    expect((await sweep()).findings).toContainEqual(expect.objectContaining({ findingQitemId: finding!.qitemId, action: "refreshed" }));
    expect(findings(row.qitemId)).toHaveLength(1);
    expect(repo.transitionLog.listForQitem(finding!.qitemId)).toEqual(transitions);
    expect(sent).toEqual(["closer@r"]);

    await repo.create({ sourceSession: "closer@r", destinationSession: "next@r", body: "Continue approved work",
      chainOfRecord: [row.qitemId], nudge: false });
    expect((await sweep()).findings).toContainEqual(expect.objectContaining({ findingQitemId: finding!.qitemId, action: "closed" }));
    expect(repo.getById(finding!.qitemId)).toMatchObject({ state: "done", closureReason: "no-follow-on" });
    expect(db.prepare("SELECT * FROM queue_items WHERE qitem_id = ?").get(row.qitemId)).toEqual(original);
  });
});
