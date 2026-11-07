// #2661 — a claimed row whose owner is idle at the prompt with a live background shell (b), or whose managed
// post-compaction restore is pending (c), is not stalled-after-claim within a bounded grace, and the grace is named.
import { describe, it, expect } from "vitest";
import {
  derivePickup, stalledPickupFinding, BACKGROUND_SHELL_GRACE_MINUTES, COMPACTION_RESTORE_GRACE_MINUTES, type PickupFacts,
} from "../src/domain/queue-pickup.js";

const now = new Date("2026-11-07T12:00:00.000Z");
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000).toISOString();
const claimed = (over: Partial<PickupFacts> = {}): PickupFacts => ({
  state: "in-progress", claimedAt: minutesAgo(90), lastHeartbeat: null, postClaimMotionCount: 0,
  lastMeaningfulAt: minutesAgo(90), activity: "idle-at-prompt", now, thresholdMinutes: 3, ...over,
});

describe("(b) a live background shell", () => {
  it("is working within its grace counted from the claim's last queue change, and says so", () => {
    expect(derivePickup(claimed({ lastMeaningfulAt: minutesAgo(20), backgroundWork: { observedAt: minutesAgo(15) } }))).toEqual({
      state: "working", grace: "background-shell",
      evidence: `owner idle at prompt with a live background shell; no queue change for 20 min (grace ${BACKGROUND_SHELL_GRACE_MINUTES} min)`,
    });
  });

  it("past its ceiling is stalled again, and the stall names the shell", () => {
    const p = derivePickup(claimed({ backgroundWork: { observedAt: minutesAgo(5) } }));
    expect(p.state).toBe("stalled-after-claim");
    expect(p.grace).toBeUndefined();
    expect(p.evidence).toContain("no meaningful queue change for 90 min");
    expect(p.evidence).toContain(`background shell live, past its ${BACKGROUND_SHELL_GRACE_MINUTES} min ceiling (90 min since the claim's last queue change)`);
    expect(stalledPickupFinding({ qitemId: "q1", destinationSession: "worker@r", pickup: p })?.evidence).toBe(p.evidence);
  });

  it("a shell that never ends, with a new turn every hour, still reads stalled after the ceiling (the maintainer's case)", () => {
    // each hourly turn starts a fresh shell (its first sighting minutes ago) but moves nothing on the queue
    for (const hours of [2, 3, 5]) {
      const p = derivePickup(claimed({ claimedAt: minutesAgo(hours * 60 + 10), lastMeaningfulAt: minutesAgo(hours * 60 + 10),
        backgroundWork: { observedAt: minutesAgo(3) } }));
      expect(p.state, `after ${hours} h`).toBe("stalled-after-claim");
    }
  });

  it("the ceiling can be given per call", () => {
    expect(derivePickup(claimed({ lastMeaningfulAt: minutesAgo(20), backgroundWork: { observedAt: minutesAgo(20) },
      backgroundShellGraceMinutes: 10 })).state).toBe("stalled-after-claim");
  });

  it("does not override a pending input: needs-input keeps the stall it rides on", () => {
    const p = derivePickup(claimed({ lastMeaningfulAt: minutesAgo(20), backgroundWork: { observedAt: minutesAgo(5) },
      needsInput: 1, needsInputReason: "dialog owns input" }));
    expect(p.state).toBe("needs-input");
    expect(p.stall).toContain("no meaningful queue change");
  });

  it("inside the stall threshold nothing changes: working with no evidence", () => {
    expect(derivePickup(claimed({ lastMeaningfulAt: minutesAgo(1), backgroundWork: { observedAt: minutesAgo(1) } })))
      .toEqual({ state: "working" });
  });

  it("leaves unclaimed, parked and closed rows alone", () => {
    const shell = { lastMeaningfulAt: minutesAgo(20), backgroundWork: { observedAt: minutesAgo(5) } };
    expect(derivePickup(claimed({ ...shell, claimedAt: null })).state).toBe("unclaimed");
    expect(derivePickup(claimed({ ...shell, state: "blocked" })).state).toBe("parked");
    expect(derivePickup(claimed({ ...shell, state: "done" })).state).toBe("terminal");
  });
});

describe("(c) a pending managed restore", () => {
  it("is working within its grace, and says so", () => {
    expect(derivePickup(claimed({ compactionOwedSince: minutesAgo(4) }))).toEqual({
      state: "working", grace: "restore-pending",
      evidence: `managed post-compaction restore owed for 4 min (grace ${COMPACTION_RESTORE_GRACE_MINUTES} min)`,
    });
  });

  it("past its ceiling is stalled again, and the stall names the restore", () => {
    const p = derivePickup(claimed({ compactionOwedSince: minutesAgo(COMPACTION_RESTORE_GRACE_MINUTES + 1) }));
    expect(p.state).toBe("stalled-after-claim");
    expect(p.evidence).toContain(`managed restore owed ${COMPACTION_RESTORE_GRACE_MINUTES + 1} min, past its ${COMPACTION_RESTORE_GRACE_MINUTES} min ceiling`);
  });

  it("an unparseable time is no evidence", () => {
    expect(derivePickup(claimed({ compactionOwedSince: "not a time" })).state).toBe("stalled-after-claim");
  });

  it("with both signals, either within its grace keeps the row working", () => {
    expect(derivePickup(claimed({ backgroundWork: { observedAt: minutesAgo(5) }, compactionOwedSince: minutesAgo(2) })).state)
      .toBe("working");
    const both = derivePickup(claimed({ backgroundWork: { observedAt: minutesAgo(5) },
      compactionOwedSince: minutesAgo(COMPACTION_RESTORE_GRACE_MINUTES + 30) }));
    expect(both.state).toBe("stalled-after-claim");
    expect(both.evidence).toMatch(/background shell live, past .*; managed restore owed /);
  });
});

// The row face and the standing sweep read the same rule (rowToItem → derivePickup → stalledPickupFinding).
import { afterEach, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { QueueRepository, type QueueItem } from "../src/domain/queue-repository.js";
import { EventBus } from "../src/domain/event-bus.js";

describe("the row face and the stuck sweep", () => {
  let db: Database.Database;
  let repo: QueueRepository;
  let shellAt: string | null;
  let owedAt: string | null;
  const ago = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db, ALL_MIGRATIONS);
    repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true, loadHumanRegistry: () => ({ ok: true, entities: [] }) });
    shellAt = null;
    owedAt = null;
    repo.attachActivityReader(() => ({ activity: "idle-at-prompt", needsInput: { count: 0, reason: null }, decidedBy: "self-report",
      backgroundWork: shellAt ? { rung: "self-report", observedAt: shellAt } : null }) as never);
    repo.attachCompactionReader(() => owedAt);
  });
  afterEach(() => db.close());

  async function quietClaim(minutes = 90): Promise<QueueItem> {
    const row = await repo.create({ sourceSession: "sender@r", destinationSession: "worker@r", body: "work" });
    repo.claim({ qitemId: row.qitemId, destinationSession: "worker@r" });
    const past = ago(minutes);
    db.prepare("UPDATE queue_items SET claimed_at = ?, ts_created = ? WHERE qitem_id = ?").run(past, past, row.qitemId);
    db.prepare("UPDATE queue_transitions SET ts = ? WHERE qitem_id = ?").run(past, row.qitemId);
    return row;
  }

  async function sweep() {
    const mod = await import("../src/domain/queue-stuck-sweep.js");
    return mod.runStuckSweep({
      db, queueRepo: repo, status: mod.createStuckSweepStatus(), resolveOrchestrator: () => null,
      unclaimedAgeMinutes: 600, log: () => {}, isRegisteredHost: () => false,
    });
  }
  const stalls = (r: Awaited<ReturnType<typeof sweep>>, id: string) =>
    r.findings.filter((f) => f.kind === "stalled-after-claim" && f.qitemId === id);

  const aging = (id: string, minutes: number) => {
    const past = ago(minutes);
    db.prepare("UPDATE queue_items SET claimed_at = ?, ts_created = ? WHERE qitem_id = ?").run(past, past, id);
    db.prepare("UPDATE queue_transitions SET ts = ? WHERE qitem_id = ?").run(past, id);
  };
  const openStall = (id: string) => repo.list({ limit: 50 }).filter((r) => r.tags?.includes(`stuck-sweep:stalled-after-claim:${id}`)
    && ["pending", "in-progress", "blocked"].includes(r.state));

  it("(b) a shell within its window: the row reads working with its reason, and the sweep opens no stall", async () => {
    const row = await quietClaim(20);
    shellAt = ago(15);
    expect(repo.getById(row.qitemId)!.pickup).toMatchObject({ state: "working", grace: "background-shell",
      evidence: expect.stringContaining("live background shell; no queue change for 20 min") });
    expect(stalls(await sweep(), row.qitemId)).toEqual([]);
  });

  it("(b) past the window: the sweep opens the stall, and its reason names the ceiling", async () => {
    const row = await quietClaim(BACKGROUND_SHELL_GRACE_MINUTES + 10);
    shellAt = ago(2); // a fresh shell does not restart the window
    expect(stalls(await sweep(), row.qitemId)).toEqual([expect.objectContaining({ action: "created" })]);
    expect(openStall(row.qitemId)).toHaveLength(1);
    expect(openStall(row.qitemId)[0]!.body).toContain(`past its ${BACKGROUND_SHELL_GRACE_MINUTES} min ceiling`);
  });

  it("(b) a stall opened before the shell stays open through the grace and is still open when it expires", async () => {
    const row = await quietClaim(10);
    expect(stalls(await sweep(), row.qitemId)).toEqual([expect.objectContaining({ action: "created" })]);
    const finding = openStall(row.qitemId)[0]!.qitemId;
    shellAt = ago(1);
    expect(repo.getById(row.qitemId)!.pickup?.grace).toBe("background-shell");
    expect((await sweep()).findings.filter((f) => f.qitemId === row.qitemId && f.action === "closed")).toEqual([]);
    expect(openStall(row.qitemId).map((r) => r.qitemId)).toEqual([finding]);
    aging(row.qitemId, BACKGROUND_SHELL_GRACE_MINUTES + 5); // the window ends with the shell still live
    expect(stalls(await sweep(), row.qitemId)).toEqual([expect.objectContaining({ action: "refreshed", findingQitemId: finding })]);
    expect(openStall(row.qitemId).map((r) => r.qitemId)).toEqual([finding]);
  });

  it("(c) a pending restore: working within its grace, stalled past it", async () => {
    const row = await quietClaim();
    owedAt = ago(3);
    expect(repo.getById(row.qitemId)!.pickup).toMatchObject({ state: "working", grace: "restore-pending" });
    expect(stalls(await sweep(), row.qitemId)).toEqual([]);
    owedAt = ago(COMPACTION_RESTORE_GRACE_MINUTES + 5);
    expect(repo.getById(row.qitemId)!.pickup?.evidence).toContain("managed restore owed");
    expect(stalls(await sweep(), row.qitemId)).toEqual([expect.objectContaining({ action: "created" })]);
  });

  it("(c) the maintainer's case: stall, a recent restore inside the grace, the grace expiring with the restore still pending: the recovery stays active", async () => {
    const row = await quietClaim();
    expect(stalls(await sweep(), row.qitemId)).toEqual([expect.objectContaining({ action: "created" })]);
    const finding = openStall(row.qitemId)[0]!.qitemId;
    owedAt = ago(2); // the daemon now owes the seat its restore
    expect(repo.getById(row.qitemId)!.pickup?.grace).toBe("restore-pending");
    expect((await sweep()).findings.filter((f) => f.qitemId === row.qitemId && f.action === "closed")).toEqual([]);
    owedAt = ago(COMPACTION_RESTORE_GRACE_MINUTES + 1); // nothing changed; the grace is over, the restore still owed
    expect(stalls(await sweep(), row.qitemId)).toEqual([expect.objectContaining({ action: "refreshed", findingQitemId: finding })]);
    expect(openStall(row.qitemId).map((r) => r.qitemId)).toEqual([finding]);
  });

  it("a real resolution still closes the stall: the owner moves the row", async () => {
    const row = await quietClaim();
    expect(stalls(await sweep(), row.qitemId)).toEqual([expect.objectContaining({ action: "created" })]);
    await repo.update({ qitemId: row.qitemId, actorSession: "worker@r", transitionNote: "resumed work" });
    expect(stalls(await sweep(), row.qitemId)).toEqual([expect.objectContaining({ action: "closed" })]);
  });

});
