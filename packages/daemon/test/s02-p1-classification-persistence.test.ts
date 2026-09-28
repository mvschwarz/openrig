import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { streamItemsSchema } from "../src/db/migrations/023_stream_items.js";
import { projectClassificationsSchema } from "../src/db/migrations/028_project_classifications.js";
import { classifierLeasesSchema } from "../src/db/migrations/029_classifier_leases.js";
import { classificationFieldsAndAttemptsSchema } from "../src/db/migrations/086_classification_fields_and_attempts.js";
import { classificationIdentityProvenanceSchema } from "../src/db/migrations/089_classification_identity_provenance.js";
import { StreamStore } from "../src/domain/stream-store.js";
import { projectsRoutes } from "../src/routes/projects.js";
import { EventBus } from "../src/domain/event-bus.js";
import { ClassifierLeaseManager, ClassifierLeaseError } from "../src/domain/classifier-lease-manager.js";
import { ProjectClassifier, ProjectClassifierError } from "../src/domain/project-classifier.js";
import {
  ClassificationAttemptLedger,
  ClassificationAttemptError,
  DEFAULT_BASE_BACKOFF_MS,
  DEFAULT_IN_FLIGHT_TIMEOUT_MS,
} from "../src/domain/classification-attempts.js";

/**
 * 0.6.0 S02 P1 — classification persistence and lease correctness.
 * Contract: missions/release-0.6.0/evidence/offline-contract-s01-s02-dev60/CONTRACT.md
 * (revision 2) and Review-R2 REPORT 3b6d58dd (nine offline controls). Every
 * case uses an in-memory or disposable temp database and an injected clock.
 */

const TTL = 60_000;
const V = { classifierVersion: "clf-1", taxonomyVersion: "tax-0.2", evidenceEpoch: "0" };

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof ClassifierLeaseError || err instanceof ProjectClassifierError || err instanceof ClassificationAttemptError) {
      return err.code;
    }
    throw err;
  }
  return "no-error";
}

describe("S02 P1 classification persistence and lease correctness", () => {
  let db: Database.Database;
  let bus: EventBus;
  let clock: number;
  let leases: ClassifierLeaseManager;
  let classifier: ProjectClassifier;
  let ledger: ClassificationAttemptLedger;
  let stream: StreamStore;
  const now = () => new Date(clock);

  function seed(n: number, prefix = "item"): string[] {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const id = `${prefix}-${String(i).padStart(3, "0")}`;
      stream.emit({ streamItemId: id, sourceSession: "obs@rig", body: `observation ${i}` });
      ids.push(id);
    }
    return ids;
  }

  beforeEach(() => {
    clock = Date.parse("2026-09-26T20:00:00.000Z");
    db = createDb();
    migrate(db, [coreSchema, eventsSchema, streamItemsSchema, projectClassificationsSchema, classifierLeasesSchema, classificationFieldsAndAttemptsSchema, classificationIdentityProvenanceSchema]);
    bus = new EventBus(db);
    stream = new StreamStore(db, bus);
    leases = new ClassifierLeaseManager(db, bus, { ttlMs: TTL, now });
    classifier = new ProjectClassifier(db, bus, leases, { now });
    ledger = new ClassificationAttemptLedger(db, leases, { now });
  });

  afterEach(() => db.close());

  describe("lease binding (R2 controls 1-3, now passing the corrected direction)", () => {
    it("same-session acquire after TTL issues a NEW lease id instead of returning the expired one", () => {
      const first = leases.acquire("occ@rig");
      clock += TTL + 1;
      const second = leases.acquire("occ@rig");
      expect(second.leaseId).not.toBe(first.leaseId);
      expect(leases.getById(first.leaseId)?.state).toBe("expired");
      expect(second.state).toBe("active");
    });

    it("same-session acquire before TTL stays idempotent", () => {
      const first = leases.acquire("occ@rig");
      clock += TTL - 1;
      expect(leases.acquire("occ@rig").leaseId).toBe(first.leaseId);
    });

    it("heartbeat on a TTL-passed lease refuses with lease_expired and does not revive it", () => {
      const lease = leases.acquire("occ@rig");
      clock += TTL + 1;
      expect(code(() => leases.heartbeat(lease.leaseId, "occ@rig"))).toBe("lease_expired");
      expect(leases.getById(lease.leaseId)?.expiresAt).toBe(lease.expiresAt);
    });

    it("a late result bound to a replaced same-session lease is refused (lease_mismatch), nothing written", () => {
      seed(1);
      const old = leases.acquire("occ@rig");
      clock += TTL + 1;
      leases.acquire("occ@rig");
      expect(code(() => classifier.classify({ streamItemId: "item-000", classifierSession: "occ@rig", leaseId: old.leaseId }))).toBe(
        "lease_mismatch",
      );
      expect(classifier.getByStreamItemId("item-000")).toBeNull();
    });

    it("a different session cannot take an expired lease without the evaluated acquire, then can", () => {
      leases.acquire("occ@rig");
      clock += TTL + 1;
      expect(code(() => leases.acquire("other@rig"))).toBe("lease_held");
      leases.evaluateDeadness();
      expect(leases.acquire("other@rig").classifierSession).toBe("other@rig");
    });

    it("an expired lease (not yet replaced) refuses the write", () => {
      seed(1);
      const lease = leases.acquire("occ@rig");
      clock += TTL + 1;
      expect(code(() => classifier.classify({ streamItemId: "item-000", classifierSession: "occ@rig", leaseId: lease.leaseId }))).toBe(
        "lease_expired",
      );
    });

    it("an old caller without leaseId gets a clear refusal, not a silent write", () => {
      seed(1);
      leases.acquire("occ@rig");
      expect(code(() => classifier.classify({ streamItemId: "item-000", classifierSession: "occ@rig" } as never))).toBe(
        "lease_id_required",
      );
    });
  });

  describe("classification fields (migration 086)", () => {
    it("stores the four fields and version bindings; unknown needs_human stays null, not false", () => {
      seed(3);
      const { leaseId } = leases.acquire("occ@rig");
      const yes = classifier.classify({
        streamItemId: "item-001", classifierSession: "occ@rig", leaseId,
        area: "coordination-stream-queue", scopeRef: "OPR.0.6.0.2", candidateSetVersion: "scope@2026-09-26",
        duplicateOfStreamItemId: "item-000", needsHuman: true, classifierVersion: "clf-1", taxonomyVersion: "tax-0.2",
      });
      const no = classifier.classify({ streamItemId: "item-002", classifierSession: "occ@rig", leaseId, needsHuman: false });
      const unknown = classifier.classify({ streamItemId: "item-000", classifierSession: "occ@rig", leaseId });
      expect(yes).toMatchObject({
        area: "coordination-stream-queue", scopeRef: "OPR.0.6.0.2", candidateSetVersion: "scope@2026-09-26",
        duplicateOfStreamItemId: "item-000", needsHuman: true, leaseId, classifierVersion: "clf-1", taxonomyVersion: "tax-0.2",
      });
      expect(no.needsHuman).toBe(false);
      expect(unknown.needsHuman).toBeNull();
      expect(classifier.list({ needsHuman: "false" }).map((p) => p.streamItemId)).toEqual(["item-002"]);
      expect(classifier.list({ needsHuman: "unknown" }).map((p) => p.streamItemId)).toEqual(["item-000"]);
      expect(classifier.list({ area: "coordination-stream-queue" }).map((p) => p.streamItemId)).toEqual(["item-001"]);
      expect(classifier.list({ scopeRef: "OPR.0.6.0.2" })).toHaveLength(1);
    });

    it("validates consumed shapes: duplicate must exist and not be self; scopeRef needs a candidate-set version", () => {
      seed(1);
      const { leaseId } = leases.acquire("occ@rig");
      const base = { streamItemId: "item-000", classifierSession: "occ@rig", leaseId };
      expect(code(() => classifier.classify({ ...base, duplicateOfStreamItemId: "item-000" }))).toBe("invalid_duplicate_of");
      expect(code(() => classifier.classify({ ...base, duplicateOfStreamItemId: "missing" }))).toBe("invalid_duplicate_of");
      expect(code(() => classifier.classify({ ...base, scopeRef: "OPR.0.6.0.2" }))).toBe("candidate_set_version_required");
      expect(code(() => classifier.classify({ ...base, needsHuman: "yes" as never }))).toBe("invalid_needs_human");
      expect(classifier.getByStreamItemId("item-000")).toBeNull();
    });

    it("first write still wins", () => {
      seed(1);
      const { leaseId } = leases.acquire("occ@rig");
      classifier.classify({ streamItemId: "item-000", classifierSession: "occ@rig", leaseId, area: "a" });
      expect(code(() => classifier.classify({ streamItemId: "item-000", classifierSession: "occ@rig", leaseId, area: "b" }))).toBe(
        "idempotency_violation",
      );
      expect(classifier.getByStreamItemId("item-000")?.area).toBe("a");
    });
  });

  describe("attempt ledger", () => {
    it("abstention is terminal for its identity, and a new version or evidence epoch makes the item eligible again", () => {
      seed(1);
      const { leaseId } = leases.acquire("occ@rig");
      const a = ledger.begin({ streamItemId: "item-000", ...V, leaseId, classifierSession: "occ@rig" });
      ledger.abstain({ attemptId: a.attemptId, executionId: a.executionId, leaseId, classifierSession: "occ@rig", reason: "margin below threshold" });
      expect(code(() => ledger.begin({ streamItemId: "item-000", ...V, leaseId, classifierSession: "occ@rig" }))).toBe("attempt_terminal");
      expect(ledger.eligible(V).items).toHaveLength(0);
      expect(ledger.eligible({ ...V, classifierVersion: "clf-2" }).items.map((i) => i.streamItemId)).toEqual(["item-000"]);
      expect(ledger.eligible({ ...V, evidenceEpoch: "evidence:sha256:abc" }).items).toHaveLength(1);
      // Abstention never touched the immutable classification row.
      expect(classifier.getByStreamItemId("item-000")).toBeNull();
    });

    it("errors retry after a bounded, doubling delay and exhaust at the budget", () => {
      seed(1);
      // The test lease TTL (60 s) is shorter than the backoff, so the occupant
      // re-acquires after each wait; its own expired lease yields a new id.
      let leaseId = leases.acquire("occ@rig").leaseId;
      const begin = () => ledger.begin({ streamItemId: "item-000", ...V, leaseId, classifierSession: "occ@rig" });
      const fail = (x: { attemptId: string; executionId: string }) =>
        ledger.fail({ attemptId: x.attemptId, executionId: x.executionId, leaseId, classifierSession: "occ@rig", reason: "provider 503" });
      const a = begin();
      const failed = fail(a);
      expect(failed.status).toBe("error");
      expect(Date.parse(failed.retryAfter!)).toBe(clock + DEFAULT_BASE_BACKOFF_MS);
      expect(ledger.eligible(V).items).toHaveLength(0);
      expect(code(begin)).toBe("attempt_not_due");
      clock += DEFAULT_BASE_BACKOFF_MS;
      leaseId = leases.acquire("occ@rig").leaseId;
      expect(ledger.eligible(V).items).toHaveLength(1);
      const b = begin();
      expect(b.attemptCount).toBe(2);
      expect(b.executionId).not.toBe(a.executionId);
      const second = fail(b);
      expect(Date.parse(second.retryAfter!)).toBe(clock + 2 * DEFAULT_BASE_BACKOFF_MS);
      clock += 2 * DEFAULT_BASE_BACKOFF_MS;
      leaseId = leases.acquire("occ@rig").leaseId;
      const c = begin();
      expect(c.attemptCount).toBe(3);
      const last = fail(c);
      expect(last.status).toBe("exhausted");
      expect(ledger.eligible(V).items).toHaveLength(0);
    });

    it("an abandoned in-flight attempt (crash) becomes eligible after the timeout and counts toward the budget", () => {
      seed(1);
      const lease = leases.acquire("occ@rig");
      ledger.begin({ streamItemId: "item-000", ...V, leaseId: lease.leaseId, classifierSession: "occ@rig" });
      expect(ledger.eligible(V).items).toHaveLength(0);
      expect(code(() => ledger.begin({ streamItemId: "item-000", ...V, leaseId: lease.leaseId, classifierSession: "occ@rig" }))).toBe(
        "attempt_in_flight",
      );
      clock += DEFAULT_IN_FLIGHT_TIMEOUT_MS;
      const fresh = leases.acquire("occ@rig"); // own lease past TTL -> new lease id
      expect(ledger.eligible(V).items).toHaveLength(1);
      expect(ledger.begin({ streamItemId: "item-000", ...V, leaseId: fresh.leaseId, classifierSession: "occ@rig" }).attemptCount).toBe(2);
    });

    it("an in-flight attempt under a replaced lease can be resumed by the new lease but not finished by the old one", () => {
      seed(1);
      const old = leases.acquire("occ@rig");
      const a = ledger.begin({ streamItemId: "item-000", ...V, leaseId: old.leaseId, classifierSession: "occ@rig" });
      clock += TTL + 1;
      const fresh = leases.acquire("occ@rig");
      expect(code(() => ledger.abstain({ attemptId: a.attemptId, executionId: a.executionId, leaseId: old.leaseId, classifierSession: "occ@rig", reason: "x" }))).toBe(
        "lease_mismatch",
      );
      const resumed = ledger.begin({ streamItemId: "item-000", ...V, leaseId: fresh.leaseId, classifierSession: "occ@rig" });
      expect(resumed.leaseId).toBe(fresh.leaseId);
      expect(resumed.attemptCount).toBe(2);
    });

    it("a classify bound to the attempt marks it written in the same transaction", () => {
      seed(1);
      const { leaseId } = leases.acquire("occ@rig");
      const a = ledger.begin({ streamItemId: "item-000", ...V, leaseId, classifierSession: "occ@rig" });
      classifier.classify({
        streamItemId: "item-000", classifierSession: "occ@rig", leaseId, attemptId: a.attemptId, executionId: a.executionId,
        classifierVersion: V.classifierVersion, taxonomyVersion: V.taxonomyVersion, classificationType: "bug",
      });
      expect(ledger.getById(a.attemptId)?.status).toBe("written");
      expect(ledger.eligible(V).items).toHaveLength(0);
      expect(ledger.eligible({ ...V, classifierVersion: "clf-2" }).items).toHaveLength(0); // classified items never re-offered
    });

    it("a classify with mismatched attempt versions is refused and writes nothing", () => {
      seed(1);
      const { leaseId } = leases.acquire("occ@rig");
      const a = ledger.begin({ streamItemId: "item-000", ...V, leaseId, classifierSession: "occ@rig" });
      expect(
        code(() =>
          classifier.classify({
            streamItemId: "item-000", classifierSession: "occ@rig", leaseId, attemptId: a.attemptId, executionId: a.executionId,
            classifierVersion: "clf-other", taxonomyVersion: V.taxonomyVersion,
          }),
        ),
      ).toBe("attempt_mismatch");
      expect(classifier.getByStreamItemId("item-000")).toBeNull();
      expect(ledger.getById(a.attemptId)?.status).toBe("in_flight");
    });

    it("a transaction failure after the checks rolls back both the row and the attempt", () => {
      seed(1);
      const { leaseId } = leases.acquire("occ@rig");
      const a = ledger.begin({ streamItemId: "item-000", ...V, leaseId, classifierSession: "occ@rig" });
      const original = bus.persistWithinTransaction.bind(bus);
      bus.persistWithinTransaction = ((event: Parameters<typeof original>[0]) => {
        if (event.type === "project.classified") throw new Error("injected event-store failure");
        return original(event);
      }) as typeof bus.persistWithinTransaction;
      expect(() =>
        classifier.classify({
          streamItemId: "item-000", classifierSession: "occ@rig", leaseId, attemptId: a.attemptId, executionId: a.executionId,
          classifierVersion: V.classifierVersion, taxonomyVersion: V.taxonomyVersion,
        }),
      ).toThrow("injected event-store failure");
      bus.persistWithinTransaction = original;
      expect(classifier.getByStreamItemId("item-000")).toBeNull();
      expect(ledger.getById(a.attemptId)?.status).toBe("in_flight");
    });
  });

  describe("F1 execution fencing (R2 510ef2da finding): old execution vs current execution", () => {
    // A long TTL with periodic heartbeats keeps ONE lease alive across the retry,
    // so only the execution fence (not the lease) can refuse the old execution.
    const LONG_TTL = 60 * 60_000;
    let fenceLeases: ClassifierLeaseManager;
    let fenceLedger: ClassificationAttemptLedger;
    let fenceClassifier: ProjectClassifier;
    beforeEach(() => {
      fenceLeases = new ClassifierLeaseManager(db, bus, { ttlMs: LONG_TTL, now });
      fenceLedger = new ClassificationAttemptLedger(db, fenceLeases, { now });
      fenceClassifier = new ProjectClassifier(db, bus, fenceLeases, { now });
    });

    function retried(cause: "timeout" | "error") {
      seed(1);
      const { leaseId } = fenceLeases.acquire("occ@rig");
      const begin = () => fenceLedger.begin({ streamItemId: "item-000", ...V, leaseId, classifierSession: "occ@rig" });
      const oldExec = begin();
      if (cause === "timeout") {
        for (let t = 0; t < 3; t++) { clock += 5 * 60_000; fenceLeases.heartbeat(leaseId, "occ@rig"); }
      } else {
        fenceLedger.fail({ attemptId: oldExec.attemptId, executionId: oldExec.executionId, leaseId, classifierSession: "occ@rig", reason: "provider 503" });
        clock += DEFAULT_BASE_BACKOFF_MS;
        fenceLeases.heartbeat(leaseId, "occ@rig");
      }
      const current = begin();
      expect(current.attemptId).toBe(oldExec.attemptId);
      expect(fenceLeases.getActiveLease()?.leaseId).toBe(leaseId); // same, still-live lease
      expect(current.executionId).not.toBe(oldExec.executionId);
      return { leaseId, oldExec, current };
    }

    for (const cause of ["timeout", "error"] as const) {
      it(`${cause} retry: the old execution cannot classify, abstain or fail; the current one can`, () => {
        const { leaseId, oldExec, current } = retried(cause);
        const finish = { attemptId: oldExec.attemptId, leaseId, classifierSession: "occ@rig", reason: "late" };
        expect(code(() => fenceLedger.abstain({ ...finish, executionId: oldExec.executionId }))).toBe("attempt_superseded");
        expect(code(() => fenceLedger.fail({ ...finish, executionId: oldExec.executionId }))).toBe("attempt_superseded");
        expect(code(() => fenceClassifier.classify({
          streamItemId: "item-000", classifierSession: "occ@rig", leaseId, attemptId: oldExec.attemptId,
          executionId: oldExec.executionId, classifierVersion: V.classifierVersion, taxonomyVersion: V.taxonomyVersion,
        }))).toBe("attempt_superseded");
        // Nothing the old execution tried touched the current one.
        expect(fenceClassifier.getByStreamItemId("item-000")).toBeNull();
        expect(fenceLedger.getById(current.attemptId)).toMatchObject({ status: "in_flight", executionId: current.executionId });
        // The current execution finishes normally.
        fenceClassifier.classify({
          streamItemId: "item-000", classifierSession: "occ@rig", leaseId, attemptId: current.attemptId,
          executionId: current.executionId, classifierVersion: V.classifierVersion, taxonomyVersion: V.taxonomyVersion,
        });
        expect(fenceLedger.getById(current.attemptId)?.status).toBe("written");
      });
    }

    it("a missing executionId is refused on every finish path", () => {
      seed(1);
      const { leaseId } = fenceLeases.acquire("occ@rig");
      const a = fenceLedger.begin({ streamItemId: "item-000", ...V, leaseId, classifierSession: "occ@rig" });
      const finish = { attemptId: a.attemptId, leaseId, classifierSession: "occ@rig", reason: "x" };
      expect(code(() => fenceLedger.abstain(finish as never))).toBe("invalid_field");
      expect(code(() => fenceLedger.fail(finish as never))).toBe("invalid_field");
      expect(code(() => fenceClassifier.classify({
        streamItemId: "item-000", classifierSession: "occ@rig", leaseId, attemptId: a.attemptId,
        classifierVersion: V.classifierVersion, taxonomyVersion: V.taxonomyVersion,
      }))).toBe("execution_id_required");
      expect(fenceLedger.getById(a.attemptId)?.status).toBe("in_flight");
    });

    it("a manual classification (no attemptId) needs no executionId and is not ledger-bound", () => {
      seed(1);
      const { leaseId } = fenceLeases.acquire("occ@rig");
      fenceClassifier.classify({ streamItemId: "item-000", classifierSession: "occ@rig", leaseId, area: "tui" });
      expect(db.prepare(`SELECT count(*) AS n FROM classification_attempts`).get()).toEqual({ n: 0 });
    });
  });

  describe("F2 consumed-shape validation through HTTP (R2 510ef2da finding)", () => {
    function app(): Hono {
      const a = new Hono();
      a.use("*", async (c, next) => {
        c.set("eventBus" as never, bus);
        c.set("projectClassifier" as never, classifier);
        c.set("classifierLeaseManager" as never, leases);
        c.set("classificationAttemptLedger" as never, ledger);
        await next();
      });
      a.route("/api/projects", projectsRoutes());
      return a;
    }
    const post = (path: string, body: unknown) =>
      app().request(`/api/projects${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    it("rejects number, object and null for string fields with a field-specific 400 and no write", async () => {
      seed(1);
      const { leaseId } = leases.acquire("occ@rig");
      const base = { streamItemId: "item-000", classifierSession: "occ@rig", leaseId };
      const cases: Array<[string, unknown]> = [
        ["scopeRef", 7], ["candidateSetVersion", 8], ["area", 9], ["scopeRef", { id: "x" }],
        ["area", null], ["classificationType", ["bug"]], ["classifierVersion", ""], ["duplicateOfStreamItemId", 0],
        ["executionId", 5],
      ];
      for (const [field, value] of cases) {
        const res = await post("/project", { ...base, [field]: value });
        const body = (await res.json()) as { error: string; field?: string };
        expect([field, res.status, body.error, body.field]).toEqual([field, 400, "invalid_field", field]);
      }
      const objSession = await post("/project", { ...base, classifierSession: { s: 1 } });
      expect(objSession.status).toBe(400);
      expect(classifier.getByStreamItemId("item-000")).toBeNull();
    });

    it("legitimate strings and needsHuman true/false/null still succeed", async () => {
      seed(3);
      const { leaseId } = leases.acquire("occ@rig");
      const ok = await post("/project", {
        streamItemId: "item-000", classifierSession: "occ@rig", leaseId, area: "tui", scopeRef: "OPR.0.6.0.2",
        candidateSetVersion: "scope@1", classificationType: "", needsHuman: null,
      });
      expect(ok.status).toBe(201);
      expect(await ok.json()).toMatchObject({ area: "tui", scopeRef: "OPR.0.6.0.2", classificationType: "", needsHuman: null });
      expect((await post("/project", { streamItemId: "item-001", classifierSession: "occ@rig", leaseId, needsHuman: false })).status).toBe(201);
      expect((await post("/project", { streamItemId: "item-002", classifierSession: "occ@rig", leaseId, needsHuman: "no" })).status).toBe(400);
    });

    it("attempt routes reject non-string identity and finish fields", async () => {
      seed(1);
      const { leaseId } = leases.acquire("occ@rig");
      const bad = await post("/attempts/begin", { streamItemId: "item-000", ...V, classifierVersion: 1, leaseId, classifierSession: "occ@rig" });
      expect(bad.status).toBe(400);
      const begun = await post("/attempts/begin", { streamItemId: "item-000", ...V, leaseId, classifierSession: "occ@rig" });
      const a = (await begun.json()) as { attemptId: string; executionId: string };
      const r = await post(`/attempts/${a.attemptId}/abstain`, { executionId: 1, leaseId, classifierSession: "occ@rig", reason: "x" });
      expect([r.status, ((await r.json()) as { field?: string }).field]).toEqual([400, "executionId"]);
      expect(ledger.getById(a.attemptId)?.status).toBe("in_flight");
    });
  });

  describe("eligible pages", () => {
    it("pages more than 50 items completely, in stream order, excluding archived and classified", () => {
      const ids = seed(57);
      stream.archive(ids[3]!);
      const { leaseId } = leases.acquire("occ@rig");
      classifier.classify({ streamItemId: ids[10]!, classifierSession: "occ@rig", leaseId });
      const seen: string[] = [];
      let after: string | undefined;
      let pages = 0;
      do {
        const page = ledger.eligible({ ...V, limit: 20, afterSortKey: after });
        expect(page.items.length).toBeLessThanOrEqual(20);
        seen.push(...page.items.map((i) => i.streamItemId));
        after = page.nextAfterSortKey ?? undefined;
        pages++;
      } while (after);
      expect(pages).toBe(3);
      expect(seen).toEqual(ids.filter((id) => id !== ids[3] && id !== ids[10]));
    });

    it("caps the page size and refuses an unknown cursor", () => {
      seed(120);
      expect(ledger.eligible({ ...V, limit: 1000 }).items).toHaveLength(100);
      expect(code(() => ledger.eligible({ ...V, afterSortKey: "not-a-key" }))).toBe("unknown_cursor");
    });
  });
});

describe("S02 P1 migration 086 on a populated base database (upgrade + reopen)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "s02-p1-upgrade-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("keeps old rows readable with null new fields and first-write-wins after upgrade", () => {
    const file = join(dir, "base.sqlite");
    const base = ALL_MIGRATIONS.filter((m) => m.name !== classificationFieldsAndAttemptsSchema.name && m.name !== classificationIdentityProvenanceSchema.name);
    expect(base.length).toBe(ALL_MIGRATIONS.length - 2);

    // Base (through 085): one classification written the old way, one active lease.
    const before = createDb(file);
    migrate(before, base);
    before.prepare(`INSERT INTO stream_items (stream_item_id, ts_emitted, stream_sort_key, source_session, body) VALUES (?, ?, ?, ?, ?)`)
      .run("old-1", "2026-09-01T00:00:00.000Z", "01OLD0000000000000000000001", "obs@rig", "old observation");
    before.prepare(`INSERT INTO classifier_leases (lease_id, classifier_session, acquired_at, expires_at, last_heartbeat, state) VALUES (?, ?, ?, ?, ?, 'active')`)
      .run("lease-old", "occ@rig", "2026-09-01T00:00:00.000Z", "2099-01-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z");
    before.prepare(`INSERT INTO project_classifications (project_id, stream_item_id, classification_type, classifier_session, ts_projected) VALUES (?, ?, ?, ?, ?)`)
      .run("proj-old", "old-1", "idea", "occ@rig", "2026-09-01T00:00:01.000Z");
    before.close();

    // Upgrade and reopen.
    const upgraded = createDb(file);
    migrate(upgraded, ALL_MIGRATIONS);
    upgraded.close();
    const reopened = createDb(file);
    migrate(reopened, ALL_MIGRATIONS); // idempotent second pass
    const bus = new EventBus(reopened);
    const leases = new ClassifierLeaseManager(reopened, bus);
    const classifier = new ProjectClassifier(reopened, bus, leases);
    const old = classifier.getByStreamItemId("old-1")!;
    expect(old).toMatchObject({
      classificationType: "idea", area: null, scopeRef: null, duplicateOfStreamItemId: null,
      needsHuman: null, leaseId: null, classifierVersion: null, taxonomyVersion: null, candidateSetVersion: null,
    });
    expect(code(() => classifier.classify({ streamItemId: "old-1", classifierSession: "occ@rig", leaseId: "lease-old" }))).toBe(
      "idempotency_violation",
    );
    const tables = reopened.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'classification_attempts'`).all();
    expect(tables).toHaveLength(1);
    const cols = (reopened.prepare(`PRAGMA table_info(classification_attempts)`).all() as Array<{ name: string; notnull: number }>);
    expect(cols.find((c) => c.name === "execution_id")?.notnull).toBe(1);
    reopened.close();
  });

  it("a durable error retry survives close/reopen, and the fence still refuses the pre-restart execution", () => {
    const file = join(dir, "durable.sqlite");
    let clock = Date.parse("2026-09-27T02:00:00.000Z");
    const now = () => new Date(clock);
    const open = () => {
      const db = createDb(file);
      migrate(db, ALL_MIGRATIONS);
      const bus = new EventBus(db);
      const leases = new ClassifierLeaseManager(db, bus, { ttlMs: 60 * 60_000, now });
      return { db, bus, leases, ledger: new ClassificationAttemptLedger(db, leases, { now }), classifier: new ProjectClassifier(db, bus, leases, { now }) };
    };
    let s1 = open();
    new StreamStore(s1.db, s1.bus).emit({ streamItemId: "d-1", sourceSession: "obs@rig", body: "durable" });
    const leaseId = s1.leases.acquire("occ@rig").leaseId;
    const a = s1.ledger.begin({ streamItemId: "d-1", ...V, leaseId, classifierSession: "occ@rig" });
    s1.ledger.fail({ attemptId: a.attemptId, executionId: a.executionId, leaseId, classifierSession: "occ@rig", reason: "provider 503" });
    s1.db.close();

    clock += DEFAULT_BASE_BACKOFF_MS;
    const s2 = open();
    expect(s2.ledger.getById(a.attemptId)).toMatchObject({ status: "error", attemptCount: 1, executionId: a.executionId });
    expect(s2.ledger.eligible(V).items.map((i) => i.streamItemId)).toEqual(["d-1"]);
    const b = s2.ledger.begin({ streamItemId: "d-1", ...V, leaseId, classifierSession: "occ@rig" });
    expect(b.attemptCount).toBe(2);
    expect(code(() => s2.ledger.abstain({ attemptId: a.attemptId, executionId: a.executionId, leaseId, classifierSession: "occ@rig", reason: "late" }))).toBe(
      "attempt_superseded",
    );
    s2.ledger.abstain({ attemptId: b.attemptId, executionId: b.executionId, leaseId, classifierSession: "occ@rig", reason: "below threshold" });
    s2.db.close();
    s1 = open();
    expect(s1.ledger.getById(a.attemptId)?.status).toBe("abstained");
    expect(s1.ledger.eligible(V).items).toHaveLength(0);
    s1.db.close();
  });
});
