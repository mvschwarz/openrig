import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { writerAuthorityLeasesSchema } from "../src/db/migrations/118_writer_authority_leases.js";
import { EventBus } from "../src/domain/event-bus.js";
import {
  WriterAuthority,
  WriterAuthorityError,
} from "../src/domain/writer-authority.js";
import type { PersistedEvent } from "../src/domain/types.js";

describe("WriterAuthority (OpenRig fenced writer)", () => {
  let db: Database.Database;
  let bus: EventBus;
  let writers: WriterAuthority;
  let captured: PersistedEvent[];

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, eventsSchema, writerAuthorityLeasesSchema]);
    bus = new EventBus(db);
    writers = new WriterAuthority(db, bus, { ttlMs: 5_000 });
    captured = [];
    bus.subscribe((e) => captured.push(e));
  });

  afterEach(() => db.close());

  it("acquire / renew / release lifecycle + events", () => {
    const lease = writers.acquire("candidate", "cand-1", "executor@dev");
    expect(lease.state).toBe("active");
    expect(lease.generation).toBe(1);
    expect(captured.some((e) => e.type === "writer.acquired")).toBe(true);

    const renewed = writers.renew(lease.leaseId, "executor@dev");
    expect(renewed.expiresAt >= lease.expiresAt).toBe(true);

    const released = writers.release(lease.leaseId, "executor@dev");
    expect(released.state).toBe("released");
    expect(captured.some((e) => e.type === "writer.released")).toBe(true);
  });

  it("second holder is refused while lease is active", () => {
    writers.acquire("candidate", "cand-1", "executor@dev");
    expect(() => writers.acquire("candidate", "cand-1", "other@dev")).toThrow(
      WriterAuthorityError,
    );
  });

  it("transfer bumps generation and hands the fence to the new holder", () => {
    const a = writers.acquire("candidate", "cand-1", "executor@dev");
    const b = writers.transfer(a.leaseId, "executor@dev", "reviewer@dev");
    expect(b.holderSession).toBe("reviewer@dev");
    expect(b.generation).toBe(a.generation + 1);
    expect(() =>
      writers.assertHolder("candidate", "cand-1", "executor@dev", a.generation),
    ).toThrow(WriterAuthorityError);
    try {
      writers.assertHolder("candidate", "cand-1", "executor@dev", a.generation);
    } catch (err) {
      expect(["generation_mismatch", "writer_held"]).toContain((err as WriterAuthorityError).code);
    }
    expect(
      writers.assertHolder("candidate", "cand-1", "reviewer@dev", b.generation).leaseId,
    ).toBe(b.leaseId);
  });

  it("revoke blocks protected mutation for the prior holder", () => {
    const lease = writers.acquire("publish_target", "main", "executor@dev");
    writers.revoke(lease.leaseId, "operator@dev", "test-revoke");
    expect(() =>
      writers.withProtectedMutation(
        "publish_target",
        "main",
        "executor@dev",
        lease.generation,
        () => "mutated",
      ),
    ).toThrow(WriterAuthorityError);
    expect(captured.some((e) => e.type === "writer.revoked")).toBe(true);
  });
});

describe("WriterAuthority 2-process fencing (shared SQLite)", () => {
  it("process B cannot mutate after process A revokes", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-writer-"));
    const dbPath = path.join(dir, "writer.db");

    // Two connections on one file DB = shared fence (same exclusivity as two processes).
    const db = createDb(dbPath);
    migrate(db, [coreSchema, eventsSchema, writerAuthorityLeasesSchema]);
    const busA = new EventBus(db);
    const a = new WriterAuthority(db, busA, { ttlMs: 60_000 });
    const lease = a.acquire("candidate", "shared-cand", "proc-a");

    const dbB = createDb(dbPath);
    const busB = new EventBus(dbB);
    const b = new WriterAuthority(dbB, busB, { ttlMs: 60_000 });

    a.revoke(lease.leaseId, "operator", "cross-process-revoke");

    expect(() =>
      b.withProtectedMutation(
        "candidate",
        "shared-cand",
        "proc-a",
        lease.generation,
        () => "should-not-run",
      ),
    ).toThrow(WriterAuthorityError);

    const fresh = b.acquire("candidate", "shared-cand", "proc-b");
    expect(fresh.holderSession).toBe("proc-b");
    expect(fresh.generation).toBeGreaterThan(lease.generation);

    dbB.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
