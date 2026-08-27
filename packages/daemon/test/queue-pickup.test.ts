// S04 (OPR.0.5.5.4) — PICKUP RECEIPTS, RED-first. "A durable row nobody woke is
// indistinguishable from work in progress" — this slice derives the distinction from EXISTING
// facts only: claimedAt + the first substantive post-claim transition (or heartbeat) within a
// config-keyed threshold. No claimant-written receipt field, no sweep loop. States:
//   unclaimed            — no claim yet;
//   working              — claimed AND (substantive motion since the claim OR still inside
//                          the threshold — the anti-noise direction);
//   stalled-after-claim  — claimed, past threshold, zero substantive motion; evidence named;
//   parked               — state=blocked (the deliberate fourth honest state: a park carries
//                          its wake and legitimately waits — never stalled).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { QueueRepository, type QueueItem } from "../src/domain/queue-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { ViewProjector } from "../src/domain/view-projector.js";
import { SettingsStore } from "../src/domain/user-settings/settings-store.js";

const THRESHOLD_ENV = "OPENRIG_QUEUE_PICKUP_STALL_THRESHOLD_MINUTES";

interface PickupShape {
  state: "unclaimed" | "working" | "stalled-after-claim" | "parked";
  evidence?: string;
}
const pickupOf = (item: QueueItem): PickupShape | undefined =>
  (item as unknown as { pickup?: PickupShape }).pickup;

describe("S04 pickup receipts — derived, visible, threshold-honest", () => {
  let db: Database.Database;
  let repo: QueueRepository;
  let priorEnv: string | undefined;

  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db, ALL_MIGRATIONS);
    repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true });
    priorEnv = process.env[THRESHOLD_ENV];
    delete process.env[THRESHOLD_ENV];
  });
  afterEach(() => {
    if (priorEnv === undefined) delete process.env[THRESHOLD_ENV];
    else process.env[THRESHOLD_ENV] = priorEnv;
    db.close();
  });

  /** Age a claim: move claimed_at (and the claim transition) N minutes into the past. Fixture
   *  aging of an EXISTING fact — the product code never sees an injected clock. */
  function ageClaim(qitemId: string, minutes: number): void {
    const past = new Date(Date.now() - minutes * 60_000).toISOString();
    db.prepare("UPDATE queue_items SET claimed_at = ? WHERE qitem_id = ?").run(past, qitemId);
    db.prepare("UPDATE queue_transitions SET ts = ? WHERE qitem_id = ? AND transition_note = 'claimed'").run(past, qitemId);
  }

  async function mkRow(): Promise<QueueItem> {
    return repo.create({ sourceSession: "a@r", destinationSession: "worker@r", body: "work" });
  }

  it("UNCLAIMED: a never-claimed row reads pickup.state=unclaimed on the getById projection", async () => {
    const row = await mkRow();
    const item = repo.getById(row.qitemId)!;
    expect(pickupOf(item)?.state).toBe("unclaimed");
  });

  it("WORKING (early motion): a claim followed by a substantive transition reads working — even past the threshold", async () => {
    const row = await mkRow();
    repo.claim({ qitemId: row.qitemId, destinationSession: "worker@r" });
    repo.update({ qitemId: row.qitemId, actorSession: "worker@r", transitionNote: "starting on the seam" });
    ageClaim(row.qitemId, 60); // well past any sane threshold — motion already proved pickup
    const item = repo.getById(row.qitemId)!;
    expect(pickupOf(item)?.state).toBe("working");
  });

  it("WORKING (heartbeat): a post-claim heartbeat counts as motion", async () => {
    const row = await mkRow();
    repo.claim({ qitemId: row.qitemId, destinationSession: "worker@r" });
    ageClaim(row.qitemId, 60);
    db.prepare("UPDATE queue_items SET last_heartbeat = ? WHERE qitem_id = ?").run(new Date().toISOString(), row.qitemId);
    const item = repo.getById(row.qitemId)!;
    expect(pickupOf(item)?.state).toBe("working");
  });

  it("NEGATIVE CONTROL (threshold honesty): a fresh claim with no motion yet reads WORKING inside the threshold — never prematurely stalled", async () => {
    const row = await mkRow();
    repo.claim({ qitemId: row.qitemId, destinationSession: "worker@r" });
    const item = repo.getById(row.qitemId)!;
    expect(pickupOf(item)?.state).toBe("working");
  });

  it("FOUNDER DEFAULT: the daemon config surface defaults the pickup stall threshold to 3 minutes", () => {
    const missingConfig = `/tmp/openrig-s04-missing-${process.pid}-${Date.now()}.json`;
    const setting = new SettingsStore(missingConfig).resolveOne(
      "queue.pickup_stall_threshold_minutes" as never,
    );
    expect(setting).toMatchObject({ value: 3, source: "default", defaultValue: 3 });
  });

  it("FOUNDER DEFAULT: the pickup resolver's fail-open fallback is also 3 minutes", async () => {
    const mod = await import("../src/domain/queue-pickup.js");
    expect(mod.DEFAULT_PICKUP_STALL_THRESHOLD_MINUTES).toBe(3);
  });

  it("STALLED-AFTER-CLAIM: past threshold, zero substantive motion — and the EVIDENCE is named in the projection", async () => {
    const row = await mkRow();
    repo.claim({ qitemId: row.qitemId, destinationSession: "worker@r" });
    ageClaim(row.qitemId, 60); // default threshold is far below 60min
    const item = repo.getById(row.qitemId)!;
    const p = pickupOf(item);
    expect(p?.state).toBe("stalled-after-claim");
    expect(p?.evidence).toMatch(/claimed .* ago/i); // "claimed N min ago…"
    expect(p?.evidence).toMatch(/zero (substantive )?transitions/i); // "…zero transitions since"
  });

  it("PARKED (the fourth honest state): a blocked row is NEVER stalled — it reads parked", async () => {
    const blocker = await mkRow();
    const row = await mkRow();
    repo.claim({ qitemId: row.qitemId, destinationSession: "worker@r" });
    repo.update({ qitemId: row.qitemId, actorSession: "worker@r", state: "blocked", blockedOn: blocker.qitemId, transitionNote: "parked on blocker" });
    ageClaim(row.qitemId, 60);
    const item = repo.getById(row.qitemId)!;
    expect(pickupOf(item)?.state).toBe("parked");
  });

  it("THRESHOLD from CONFIG, observed by EFFECT: raising the threshold flips a stalled row back to working", async () => {
    const row = await mkRow();
    repo.claim({ qitemId: row.qitemId, destinationSession: "worker@r" });
    ageClaim(row.qitemId, 60);
    expect(pickupOf(repo.getById(row.qitemId)!)?.state).toBe("stalled-after-claim");
    process.env[THRESHOLD_ENV] = "120"; // fresh-read config surface: no restart needed
    expect(pickupOf(repo.getById(row.qitemId)!)?.state).toBe("working");
  });

  it("LIST projection carries pickup too (the row face answers park-vs-strand in one read)", async () => {
    const row = await mkRow();
    repo.claim({ qitemId: row.qitemId, destinationSession: "worker@r" });
    ageClaim(row.qitemId, 60);
    const listed = repo.list({ destinationSession: "worker@r" }).find((i) => i.qitemId === row.qitemId)!;
    expect(pickupOf(listed)?.state).toBe("stalled-after-claim");
  });

  it("SCHEMA PROOF: no new claimant-written receipt field exists — queue tables carry NO pickup/receipt column", () => {
    for (const table of ["queue_items", "queue_transitions"]) {
      const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
      expect(cols.some((c) => /pickup|receipt/i.test(c)), `${table} must carry no derived-state column`).toBe(false);
    }
  });

  it("S02 SEAM: stalledPickupFinding() is a pure INPUT CONTRACT (kind, claimant target, evidence) — a library shape, not a loop", async () => {
    const mod = (await import("../src/domain/queue-pickup.js")) as {
      stalledPickupFinding: (item: QueueItem) => { kind: string; target: string; qitemId: string; evidence: string } | null;
    };
    const row = await mkRow();
    repo.claim({ qitemId: row.qitemId, destinationSession: "worker@r" });
    ageClaim(row.qitemId, 60);
    const finding = mod.stalledPickupFinding(repo.getById(row.qitemId)!);
    expect(finding?.kind).toBe("stalled-after-claim");
    expect(finding?.target).toBe("worker@r"); // the claimant first; S02 owns the escalation chain
    expect(finding?.qitemId).toBe(row.qitemId);
    expect(finding?.evidence).toMatch(/claimed .* ago/i);
    // and a WORKING row produces no finding:
    const fresh = await mkRow();
    repo.claim({ qitemId: fresh.qitemId, destinationSession: "worker@r" });
    expect(mod.stalledPickupFinding(repo.getById(fresh.qitemId)!)).toBeNull();
  });

  it("VIEW LENS 'pickup': claimed rows with derived state + named stalled evidence, queryable", async () => {
    const row = await mkRow();
    repo.claim({ qitemId: row.qitemId, destinationSession: "worker@r" });
    ageClaim(row.qitemId, 60);
    const projector = new ViewProjector(db, new EventBus(db));
    const result = projector.query("pickup" as never, {});
    const mine = result.rows.find((r) => r.qitem_id === row.qitemId) as Record<string, unknown> | undefined;
    expect(mine, "the pickup lens must list the claimed row").toBeDefined();
    expect(String(mine!.pickup_state)).toBe("stalled-after-claim");
    expect(String(mine!.pickup_evidence)).toMatch(/claimed .* ago/i);
  });
});
