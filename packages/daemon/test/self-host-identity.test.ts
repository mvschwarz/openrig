// 51-09 increment 1 — durable daemon SELF-HOST identity (RED-first).
//
// Grounds: arch ruling cb19867f (canonical self-host identity is NET-NEW; extend
// the seat-identity substrate; NEVER host.name-display / NEVER the 'local'
// sentinel) + IMPL-PLAN 426ec065. host.name is a DISPLAY-ONLY candidate SEED.

import { describe, it, expect } from "vitest";
import { createFullTestDb } from "./helpers/test-app.js";
import { SelfHostIdentityStore } from "../src/domain/seat-identity-store.js";
import {
  reconcileSelfHostIdentity,
  assertNeverReservedHostId,
} from "../src/domain/seat-identity-reconciler.js";

const RESERVED = ["local", "kernel", "host", "localhost"];

describe("51-09 incr1: durable self-host identity", () => {
  it("no-record-at-base: fresh canonical DB has the table but NO self-host record before reconcile", () => {
    const db = createFullTestDb();
    // verify-at-source encoded: nothing durable self-id exists until minted.
    expect(new SelfHostIdentityStore(db).get()).toBeNull();
    // the table exists (migration wired) — a query must not throw.
    expect(() => db.prepare("SELECT * FROM self_host_identity").all()).not.toThrow();
  });

  it("mint-on-first-boot: first reconcile mints a non-empty, non-reserved id", () => {
    const db = createFullTestDb();
    const store = new SelfHostIdentityStore(db);
    const r = reconcileSelfHostIdentity(store, { nowIso: "2026-08-06T00:00:00.000Z", hostNameCandidate: null });
    expect(r.minted).toBe(true);
    expect(r.hostId).toBeTruthy();
    expect(RESERVED).not.toContain(r.hostId.toLowerCase());
    expect(store.get()?.hostId).toBe(r.hostId);
  });

  it("stable-across-restart: second reconcile keeps the id + updates reconciled_at, minted_at unchanged", () => {
    const db = createFullTestDb();
    const store = new SelfHostIdentityStore(db);
    const first = reconcileSelfHostIdentity(store, { nowIso: "2026-08-06T00:00:00.000Z", hostNameCandidate: "mars-01" });
    const rec1 = store.get()!;
    const second = reconcileSelfHostIdentity(store, { nowIso: "2026-08-06T01:00:00.000Z", hostNameCandidate: "mars-01" });
    const rec2 = store.get()!;
    expect(second.minted).toBe(false);
    expect(second.hostId).toBe(first.hostId);
    expect(rec2.mintedAt).toBe(rec1.mintedAt); // minted_at NEVER moves
    expect(rec1.reconciledAt).toBe("2026-08-06T00:00:00.000Z");
    expect(rec2.reconciledAt).toBe("2026-08-06T01:00:00.000Z"); // reconciled_at advances
  });

  it("never-'local': minted id is never a reserved/default; the assert throws on them; a reserved seed is rejected → generated", () => {
    for (const reserved of ["local", "kernel", "host", "localhost", "LOCAL", "Localhost"]) {
      expect(() => assertNeverReservedHostId(reserved), reserved).toThrow();
    }
    expect(() => assertNeverReservedHostId("mars-01")).not.toThrow();
    for (const bad of ["local", "localhost", "kernel", "host"]) {
      const db = createFullTestDb();
      const r = reconcileSelfHostIdentity(new SelfHostIdentityStore(db), { nowIso: "2026-08-06T00:00:00.000Z", hostNameCandidate: bad });
      expect(r.minted).toBe(true);
      expect(r.hostId.toLowerCase()).not.toBe(bad.toLowerCase());
      expect(RESERVED).not.toContain(r.hostId.toLowerCase());
    }
  });

  it("adopt: an unambiguous host.name seeds the self-id (operator-meaningful)", () => {
    const db = createFullTestDb();
    const r = reconcileSelfHostIdentity(new SelfHostIdentityStore(db), { nowIso: "2026-08-06T00:00:00.000Z", hostNameCandidate: "mars-01" });
    expect(r.minted).toBe(true);
    expect(r.hostId).toBe("mars-01");
    expect(r.conflict).toBeNull();
  });

  it("conflict: a stored id + a differing host.name keeps the stored id AND surfaces a LOUD conflict naming both — never silent re-key", () => {
    const db = createFullTestDb();
    const store = new SelfHostIdentityStore(db);
    reconcileSelfHostIdentity(store, { nowIso: "2026-08-06T00:00:00.000Z", hostNameCandidate: "mars-01" });
    const logs: string[] = [];
    const r = reconcileSelfHostIdentity(store, {
      nowIso: "2026-08-06T02:00:00.000Z",
      hostNameCandidate: "jupiter-02",
      log: (m) => logs.push(m),
    });
    expect(r.hostId).toBe("mars-01"); // never silent re-key
    expect(store.get()?.hostId).toBe("mars-01");
    expect(r.conflict).toEqual({ storedId: "mars-01", candidate: "jupiter-02" });
    expect(logs.join(" ")).toContain("mars-01");
    expect(logs.join(" ")).toContain("jupiter-02");
  });
});
