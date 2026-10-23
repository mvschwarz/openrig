// A claimed item whose owner reports outstanding input reads needs-input, with the reason, on the pickup receipt.
// The input signal can outlast its prompt (a Codex request the pane couldn't confirm; a Claude notification that
// stays set until the next stop), so recovery keeps main's behaviour: the stall rides along and the sweep acts on it.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { QueueRepository, type QueueItem } from "../src/domain/queue-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { derivePickup, stalledPickupFinding, type PickupFacts } from "../src/domain/queue-pickup.js";

const now = new Date("2026-10-23T12:00:00.000Z");
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000).toISOString();
const claimed = (over: Partial<PickupFacts> = {}): PickupFacts => ({
  state: "in-progress", claimedAt: minutesAgo(60), lastHeartbeat: null, postClaimMotionCount: 0,
  lastMeaningfulAt: minutesAgo(60), activity: "idle", now, thresholdMinutes: 3, ...over,
});

describe("pickup receipt for an owner waiting on input", () => {
  it("reads needs-input with its reason, and keeps the stall main would read", () => {
    const stalled = derivePickup(claimed());
    expect(stalled.state).toBe("stalled-after-claim");
    expect(derivePickup(claimed({ needsInput: 1, needsInputReason: "permission_prompt" }))).toEqual({
      state: "needs-input", evidence: "owner needs input: permission_prompt", stall: stalled.evidence,
    });
  });

  it("inside the threshold there is no stall to keep", () => {
    expect(derivePickup(claimed({ lastMeaningfulAt: minutesAgo(1), needsInput: 1, needsInputReason: "dialog owns input" })))
      .toEqual({ state: "needs-input", evidence: "owner needs input: dialog owns input" });
  });

  it("an unconfirmed Codex permission request reads as unverified", () => {
    expect(derivePickup(claimed({ needsInput: 1, needsInputReason: "permission_request_unverified" })).evidence)
      .toBe("owner may need input (not verified: permission_request_unverified)");
  });

  it("covers a pending item that kept its claim", () => {
    expect(derivePickup(claimed({ state: "pending", needsInput: 1, needsInputReason: "permission_prompt" })).state).toBe("needs-input");
  });

  it("leaves unclaimed, blocked and closed items as they are", () => {
    const input = { needsInput: 1, needsInputReason: "permission_prompt" };
    expect(derivePickup(claimed({ ...input, claimedAt: null })).state).toBe("unclaimed");
    expect(derivePickup(claimed({ ...input, state: "blocked" })).state).toBe("parked");
    expect(derivePickup(claimed({ ...input, state: "done" })).state).toBe("terminal");
  });

  it("the stall finding still fires for a needs-input claim, naming both the stall and the input", () => {
    const pickup = derivePickup(claimed({ needsInput: 1, needsInputReason: "permission_prompt" }));
    const finding = stalledPickupFinding({ qitemId: "q1", destinationSession: "worker@r", pickup });
    expect(finding).toEqual({
      kind: "stalled-after-claim", target: "worker@r", qitemId: "q1",
      evidence: `${pickup.stall}; owner needs input: permission_prompt`,
    });
    expect(stalledPickupFinding({ qitemId: "q2", pickup: derivePickup(claimed({ lastMeaningfulAt: minutesAgo(1), needsInput: 1 })) })).toBeNull();
  });
});

describe("the stuck sweep keeps main's stall recovery for an input wait", () => {
  let db: Database.Database;
  let repo: QueueRepository;
  let needsInput = { count: 1, reason: "permission_prompt" as string | null };

  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db, ALL_MIGRATIONS);
    repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true, loadHumanRegistry: () => ({ ok: true, entities: [] }) });
    needsInput = { count: 1, reason: "permission_prompt" };
    // The owner's arbitrated activity, as the seat-activity service reports it.
    repo.attachActivityReader(() => ({ activity: "idle", needsInput, decidedBy: "self-report" }) as never);
  });
  afterEach(() => db.close());

  async function stalledClaim(): Promise<QueueItem> {
    const row = await repo.create({ sourceSession: "sender@r", destinationSession: "worker@r", body: "work" });
    repo.claim({ qitemId: row.qitemId, destinationSession: "worker@r" });
    const past = new Date(Date.now() - 60 * 60_000).toISOString();
    db.prepare("UPDATE queue_items SET claimed_at = ?, ts_created = ? WHERE qitem_id = ?").run(past, past, row.qitemId);
    db.prepare("UPDATE queue_transitions SET ts = ? WHERE qitem_id = ?").run(past, row.qitemId);
    return row;
  }

  async function sweep() {
    const mod = await import("../src/domain/queue-stuck-sweep.js");
    return mod.runStuckSweep({
      db, queueRepo: repo, status: mod.createStuckSweepStatus(), resolveOrchestrator: () => null,
      unclaimedAgeMinutes: 60, log: () => {}, isRegisteredHost: () => false,
    });
  }

  it("shows needs-input on the row, and opens and keeps the same stall finding main would", async () => {
    const row = await stalledClaim();
    const pickup = repo.getById(row.qitemId)!.pickup!;
    expect(pickup.state).toBe("needs-input");
    expect(pickup.evidence).toBe("owner needs input: permission_prompt");
    expect(pickup.stall).toMatch(/^no meaningful queue change for \d+ min/);

    const first = await sweep();
    expect(first.findings).toContainEqual(expect.objectContaining({ kind: "stalled-after-claim", qitemId: row.qitemId, action: "created" }));
    // The input signal is still set, as a stale one would be: the finding stays open rather than retiring.
    const second = await sweep();
    expect(second.findings).toContainEqual(expect.objectContaining({ kind: "stalled-after-claim", qitemId: row.qitemId, action: "refreshed" }));
    expect(second.findings.some((f) => f.qitemId === row.qitemId && f.action === "closed")).toBe(false);
  });

  it("a pending item that kept its claim reads needs-input too", async () => {
    const row = await stalledClaim();
    db.prepare("UPDATE queue_items SET state = 'pending' WHERE qitem_id = ?").run(row.qitemId);
    expect(repo.getById(row.qitemId)!.pickup).toMatchObject({ state: "needs-input", evidence: "owner needs input: permission_prompt" });
  });
});
