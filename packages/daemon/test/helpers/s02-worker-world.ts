import type Database from "better-sqlite3";
// Leaf-only fixture: no daemon startup, disk DB, terminal, scheduler or network.
import { createDb } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";
import { coreSchema } from "../../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../../src/db/migrations/003_events.js";
import { streamItemsSchema } from "../../src/db/migrations/023_stream_items.js";
import { projectClassificationsSchema } from "../../src/db/migrations/028_project_classifications.js";
import { classifierLeasesSchema } from "../../src/db/migrations/029_classifier_leases.js";
import { classificationFieldsAndAttemptsSchema } from "../../src/db/migrations/086_classification_fields_and_attempts.js";
import { classificationIdentityProvenanceSchema } from "../../src/db/migrations/089_classification_identity_provenance.js";
import { EventBus } from "../../src/domain/event-bus.js";
import { StreamStore } from "../../src/domain/stream-store.js";
import { ProjectClassifier } from "../../src/domain/project-classifier.js";
import { ClassificationAttemptLedger } from "../../src/domain/classification-attempts.js";
import { ClassifierLeaseManager } from "../../src/domain/classifier-lease-manager.js";
import { StreamClassificationWorker, type ClassificationCandidates, type WorkerOptions } from "../../src/domain/stream-classification-worker.js";

export const V = { classifierVersion: "classifier-test", taxonomyVersion: "taxonomy-test", evidenceEpoch: "retained:sha256:test" };
export const C: ClassificationCandidates = {
  version: "roster+scopes+taxonomy:test",
  values: { classificationType: ["question", "lesson"], classificationUrgency: ["now"], classificationMaturity: ["data"],
    classificationConfidence: [], classificationDestination: ["reader@rig"], area: ["cli-surface"], scopeRef: ["OPR.0.6.0.2"] },
  duplicateCandidates: [], relatedRefs: ["qitem-related", "PR:15"],
};
export interface WorkerWorld {
  db: Database.Database;
  clock: { ms: number };
  now: () => Date;
  bus: EventBus;
  leases: ClassifierLeaseManager;
  attempts: ClassificationAttemptLedger;
  classifier: ProjectClassifier;
  stream: StreamStore;
  seed: (id: string) => void;
  worker: (overrides?: Partial<WorkerOptions>) => StreamClassificationWorker;
}
export function world(): WorkerWorld {
  const db: Database.Database = createDb();
  migrate(db, [coreSchema,eventsSchema,streamItemsSchema,projectClassificationsSchema,classifierLeasesSchema,classificationFieldsAndAttemptsSchema,classificationIdentityProvenanceSchema]);
  const clock = { ms: Date.parse("2026-09-27T00:00:00Z") };
  const now = () => new Date(clock.ms);
  const bus = new EventBus(db);
  const leases = new ClassifierLeaseManager(db,bus,{now,ttlMs:90_000});
  const attempts = new ClassificationAttemptLedger(db,leases,{now,baseBackoffMs:1_000,maxBackoffMs:2_000,inFlightTimeoutMs:4_000});
  const classifier = new ProjectClassifier(db,bus,leases,{now});
  const stream = new StreamStore(db,bus);
  const seed = (id: string) => stream.emit({streamItemId:id,sourceSession:"emitter@rig",body:"does this need a change?"});
  const worker = (overrides: Partial<WorkerOptions> = {}) => new StreamClassificationWorker({
    ...V,session:"worker@rig",candidates:C,now,leases,attempts,classifier,stream,pageSize:3,leaseBackoffMs:1_000,
    classify:async()=>({kind:"classify",labels:{classificationType:"question",needsHuman:null}}),...overrides,
  });
  return {db,clock,now,bus,leases,attempts,classifier,stream,seed,worker};
}
