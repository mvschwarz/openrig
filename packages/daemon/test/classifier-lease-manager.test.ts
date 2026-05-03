import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { classifierLeasesSchema } from "../src/db/migrations/029_classifier_leases.js";
import { EventBus } from "../src/domain/event-bus.js";
import {
  ClassifierLeaseManager,
  ClassifierLeaseError,
} from "../src/domain/classifier-lease-manager.js";
import type { PersistedEvent } from "../src/domain/types.js";

describe("ClassifierLeaseManager (PL-004 Phase B; L2 lease lifecycle)", () => {
  let db: Database.Database;
  let bus: EventBus;
  let mgr: ClassifierLeaseManager;
  let captured: PersistedEvent[];

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, eventsSchema, classifierLeasesSchema]);
    bus = new EventBus(db);
    mgr = new ClassifierLeaseManager(db, bus, { ttlMs: 1000 });
    captured = [];
    bus.subscribe((e) => captured.push(e));
  });

  afterEach(() => db.close());

  it("acquire creates an active lease + emits classifier.lease_acquired", () => {
    const lease = mgr.acquire("alice@rig");
    expect(lease.classifierSession).toBe("alice@rig");
    expect(lease.state).toBe("active");
    expect(lease.acquiredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(lease.expiresAt > lease.acquiredAt).toBe(true);
    expect(captured.some((e) => e.type === "classifier.lease_acquired")).toBe(true);
  });

  it("acquire is idempotent for the same classifier session (returns existing lease unchanged)", () => {
    const a = mgr.acquire("alice@rig");
    const b = mgr.acquire("alice@rig");
    expect(b.leaseId).toBe(a.leaseId);
    // Only ONE lease.acquired event (idempotent path doesn't re-emit).
    expect(captured.filter((e) => e.type === "classifier.lease_acquired")).toHaveLength(1);
  });

  it("acquire by a different session when one is active throws lease_held (409)", () => {
    mgr.acquire("alice@rig");
    expect(() => mgr.acquire("bob@rig")).toThrow(ClassifierLeaseError);
    try {
      mgr.acquire("bob@rig");
    } catch (err) {
      expect((err as ClassifierLeaseError).code).toBe("lease_held");
      expect((err as ClassifierLeaseError).meta?.holder).toBe("alice@rig");
    }
  });

  it("heartbeat extends expires_at and updates last_heartbeat", () => {
    const fakeNow = (() => {
      let t = new Date("2026-05-03T00:00:00.000Z").getTime();
      return () => { const d = new Date(t); t += 100; return d; };
    })();
    const m = new ClassifierLeaseManager(db, bus, { ttlMs: 1000, now: fakeNow });
    const acquired = m.acquire("alice@rig");
    const beat = m.heartbeat(acquired.leaseId, "alice@rig");
    expect(beat.lastHeartbeat > acquired.lastHeartbeat).toBe(true);
    expect(beat.expiresAt > acquired.expiresAt).toBe(true);
  });

  it("heartbeat by mismatched session throws lease_session_mismatch (403)", () => {
    const lease = mgr.acquire("alice@rig");
    expect(() => mgr.heartbeat(lease.leaseId, "bob@rig")).toThrow(/lease_session_mismatch|alice@rig/);
  });

  it("evaluateDeadness on alive holder returns null (no expiry)", () => {
    mgr.acquire("alice@rig");
    const result = mgr.evaluateDeadness();
    expect(result).toBeNull();
  });

  it("evaluateDeadness on dead holder marks lease expired + emits classifier.dead", () => {
    const m = new ClassifierLeaseManager(db, bus, {
      ttlMs: 1000,
      isAlive: (s) => s !== "alice@rig", // alice is reported dead
    });
    m.acquire("alice@rig");
    const result = m.evaluateDeadness();
    expect(result).not.toBeNull();
    expect(result!.state).toBe("expired");
    expect(captured.some((e) => e.type === "classifier.lease_expired")).toBe(true);
    expect(captured.some((e) => e.type === "classifier.dead")).toBe(true);
  });

  it("evaluateDeadness on TTL-expired lease marks expired (without classifier.dead)", () => {
    let t = new Date("2026-05-03T00:00:00.000Z").getTime();
    const m = new ClassifierLeaseManager(db, bus, {
      ttlMs: 100,
      now: () => new Date(t),
    });
    m.acquire("alice@rig");
    t += 200; // advance past TTL
    const result = m.evaluateDeadness();
    expect(result).not.toBeNull();
    expect(result!.state).toBe("expired");
    expect(captured.some((e) => e.type === "classifier.lease_expired")).toBe(true);
    expect(captured.some((e) => e.type === "classifier.dead")).toBe(false);
  });

  it("after evaluateDeadness expires the lease, a new session can acquire", () => {
    const m = new ClassifierLeaseManager(db, bus, {
      ttlMs: 1000,
      isAlive: (s) => s !== "alice@rig",
    });
    m.acquire("alice@rig");
    m.evaluateDeadness(); // marks alice's lease expired
    const fresh = m.acquire("bob@rig");
    expect(fresh.classifierSession).toBe("bob@rig");
    expect(fresh.state).toBe("active");
  });

  it("reclaim takes the active lease away from previous holder + emits classifier.reclaimed", () => {
    mgr.acquire("alice@rig");
    const result = mgr.reclaim("operator@rig", { reason: "alice unresponsive" });
    expect(result.state).toBe("reclaimed");
    expect(result.reclaimedBySession).toBe("operator@rig");
    expect(result.reclaimReason).toBe("alice unresponsive");
    expect(captured.some((e) => e.type === "classifier.reclaimed")).toBe(true);
  });

  it("reclaim --if-dead refuses when holder is alive", () => {
    mgr.acquire("alice@rig"); // default isAlive returns true
    try {
      mgr.reclaim("operator@rig", { ifDead: true });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ClassifierLeaseError);
      expect((err as ClassifierLeaseError).code).toBe("lease_still_active");
    }
  });

  it("reclaim --if-dead succeeds when holder is dead", () => {
    const m = new ClassifierLeaseManager(db, bus, {
      ttlMs: 1000,
      isAlive: (s) => s !== "alice@rig",
    });
    m.acquire("alice@rig");
    const result = m.reclaim("operator@rig", { ifDead: true });
    expect(result.state).toBe("reclaimed");
  });

  it("requireActiveHolder validates the supplied session holds the active lease", () => {
    const lease = mgr.acquire("alice@rig");
    const checked = mgr.requireActiveHolder("alice@rig");
    expect(checked.leaseId).toBe(lease.leaseId);
  });

  it("requireActiveHolder throws lease_held when supplied a different session", () => {
    mgr.acquire("alice@rig");
    expect(() => mgr.requireActiveHolder("bob@rig")).toThrow(ClassifierLeaseError);
  });

  it("requireActiveHolder throws no_active_lease when nothing is held", () => {
    try {
      mgr.requireActiveHolder("alice@rig");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ClassifierLeaseError);
      expect((err as ClassifierLeaseError).code).toBe("no_active_lease");
    }
  });

  it("partial UNIQUE index enforces single-writer at DB layer", () => {
    mgr.acquire("alice@rig");
    // Manual INSERT with state='active' via raw SQL would be blocked by the
    // partial UNIQUE index `idx_classifier_leases_active_singleton`.
    expect(() => {
      db.prepare(
        `INSERT INTO classifier_leases (
          lease_id, classifier_session, acquired_at, expires_at, last_heartbeat, state
        ) VALUES (?, ?, ?, ?, ?, 'active')`
      ).run("dup-lease", "bob@rig", "2026-05-03T00:00:00Z", "2026-05-03T00:00:01Z", "2026-05-03T00:00:00Z");
    }).toThrow(/UNIQUE constraint/);
  });
});
