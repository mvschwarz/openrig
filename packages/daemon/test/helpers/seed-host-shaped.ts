// Host-shaped synthetic seeder for the /api/ps + /api/rigs/summary event-loop
// regression asset (qitem-20260721000001-ps-stall-driver, slice-04).
//
// Byte-scale-faithful to the copied host snapshot SHAPE — NOT the copied DB and
// NOT enlarged-to-force: 27 rigs / 198 nodes (active 10/75 + archived 17/123) and
// EXACTLY 219,541 events, inserted in ONE transaction, in the authoritative
// per-type distribution captured from the host snapshot's
// `SELECT type, COUNT(*) FROM events GROUP BY type`. Fully deterministic — no
// Date.now / Math.random — so the fixture is CI-rerunnable.
import type Database from "better-sqlite3";
import { createDb } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";
import { coreSchema } from "../../src/db/migrations/001_core_schema.js";
import { bindingsSessionsSchema } from "../../src/db/migrations/002_bindings_sessions.js";
import { eventsSchema } from "../../src/db/migrations/003_events.js";
import { snapshotsSchema } from "../../src/db/migrations/004_snapshots.js";
import { checkpointsSchema } from "../../src/db/migrations/005_checkpoints.js";
import { resumeMetadataSchema } from "../../src/db/migrations/006_resume_metadata.js";
import { nodeSpecFieldsSchema } from "../../src/db/migrations/007_node_spec_fields.js";
import { packagesSchema } from "../../src/db/migrations/008_packages.js";
import { installJournalSchema } from "../../src/db/migrations/009_install_journal.js";
import { journalSeqSchema } from "../../src/db/migrations/010_journal_seq.js";
import { bootstrapSchema } from "../../src/db/migrations/011_bootstrap.js";
import { discoverySchema } from "../../src/db/migrations/012_discovery.js";
import { discoveryFkFix } from "../../src/db/migrations/013_discovery_fk_fix.js";
import { agentspecRebootSchema } from "../../src/db/migrations/014_agentspec_reboot.js";
import { startupContextSchema } from "../../src/db/migrations/015_startup_context.js";
import { chatMessagesSchema } from "../../src/db/migrations/016_chat_messages.js";
import { podNamespaceSchema } from "../../src/db/migrations/017_pod_namespace.js";
import { contextUsageSchema } from "../../src/db/migrations/018_context_usage.js";
import { externalCliAttachmentSchema } from "../../src/db/migrations/019_external_cli_attachment.js";
import { rigServicesSchema } from "../../src/db/migrations/020_rig_services.js";
import { seatHandoverObservabilitySchema } from "../../src/db/migrations/021_seat_handover_observability.js";
import { nodePermissionPolicySchema } from "../../src/db/migrations/055_node_permission_policy.js";
import { rigPermissionPolicySchema } from "../../src/db/migrations/056_rig_permission_policy.js";
import { nodePolicyProvenanceSchema } from "../../src/db/migrations/057_node_policy_provenance.js";
import { rigPolicyProvenanceSchema } from "../../src/db/migrations/058_rig_policy_provenance.js";
import { nodeCodexConfigProfileSchema } from "../../src/db/migrations/022_node_codex_config_profile.js";
import { streamItemsSchema } from "../../src/db/migrations/023_stream_items.js";
import { queueItemsSchema } from "../../src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../../src/db/migrations/025_queue_transitions.js";
import { rigPolicySchema } from "../../src/db/migrations/041_rig_policy.js";
import { rigArchiveSchema } from "../../src/db/migrations/042_rig_archive.js";
import { resumeProvenanceSchema } from "../../src/db/migrations/043_resume_provenance.js";
import { resumeVerificationSchema } from "../../src/db/migrations/045_resume_verification.js";
import { seatIdentityVerdictsSchema } from "../../src/db/migrations/046_seat_identity_verdicts.js";
// slice-04: the shipped hot-path indexes this fixture exercises. startup.ts applies
// BOTH; without them a readonly WAL copy full-scans/temp-sorts the events + sessions
// tables, inflating latency vs the real host. createFullTestDb's list stops at 046 —
// this fixture must be production-migration-faithful for the D2 latency budget.
import { eventsNodeTypeIndexSchema } from "../../src/db/migrations/047_events_node_type_index.js";      // idx_events_node_type_seq
import { sessionsNodeIdIndexSchema } from "../../src/db/migrations/053_sessions_node_id_index.js";       // idx_sessions_node_created_id

// Vitest-free migrated in-memory DB — the same base migration list as
// test-app.ts::createFullTestDb PLUS the shipped 047/053 hot-path indexes, and
// with no `vitest` import, so the D2 child (a standalone `node --import tsx`
// process) can build production-index-faithful state without the vitest runtime.
// Used ONLY by the D2 child fixture; D1/D3 keep createFullTestDb (scan-count tests,
// index-independent).
export function createMigratedDb(): Database.Database {
  const db = createDb();
  migrate(db, [coreSchema, bindingsSessionsSchema, eventsSchema, snapshotsSchema, checkpointsSchema, resumeMetadataSchema, nodeSpecFieldsSchema, packagesSchema, installJournalSchema, journalSeqSchema, bootstrapSchema, discoverySchema, discoveryFkFix, agentspecRebootSchema, startupContextSchema, chatMessagesSchema, podNamespaceSchema, contextUsageSchema, externalCliAttachmentSchema, rigServicesSchema, seatHandoverObservabilitySchema, nodeCodexConfigProfileSchema, nodePermissionPolicySchema, rigPermissionPolicySchema, nodePolicyProvenanceSchema, rigPolicyProvenanceSchema, streamItemsSchema, queueItemsSchema, queueTransitionsSchema, rigPolicySchema, rigArchiveSchema, resumeProvenanceSchema, resumeVerificationSchema, seatIdentityVerdictsSchema, eventsNodeTypeIndexSchema, sessionsNodeIdIndexSchema]);
  return db;
}

const BASE_TS = "2026-07-01 00:00:00";

// Authoritative event-type vector from the host snapshot (sums to 219,541).
export const EVENT_TYPE_VECTOR: ReadonlyArray<readonly [string, number]> = [
  ["snapshot.created", 89083], ["view.changed", 76658], ["agent.activity", 26329],
  ["queue.created", 6262], ["queue.updated", 5825], ["watchdog.evaluation_fired", 4436],
  ["queue.claimed", 2829], ["queue.handed_off", 2714], ["node.launched", 650],
  ["node.startup_pending", 621], ["agent.session_identity", 618], ["session.detached", 437],
  ["node.startup_ready", 420], ["chat.message", 356], ["transport.prompt_override", 314],
  ["node.startup_failed", 201], ["node.reconciled", 168], ["watchdog.job_stopped", 141],
  ["watchdog.job_registered", 140], ["bootstrap.started", 118], ["bootstrap.failed", 112],
  ["node.held", 104], ["session.discovered", 101], ["node.added", 90], ["rig.imported", 66],
  ["node.startup_proof_verified", 66], ["node.startup_challenged", 65], ["session.vanished", 64],
  ["rig.stopped", 54], ["rig.deleted", 49], ["bootstrap.completed", 49], ["bootstrap.planned", 43],
  ["pod.created", 42], ["session.resume_token_captured", 39], ["rig.expanded", 35],
  ["restore.started", 35], ["restore.completed", 35], ["session.resume_token_set", 30],
  ["node.claimed", 21], ["restore.outcome_reconciled", 19], ["rig.archived", 17],
  ["restore.subset_completed", 16], ["node.removed", 14], ["workflow.instantiated", 13],
  ["stream.emitted", 11], ["bootstrap.partial", 10], ["qitem.fallback_routed", 8],
  ["rig.created", 5], ["pod.deleted", 3], ["inbox.absorbed", 2], ["binding.updated", 2],
  ["inbox.denied", 1],
];

export const TOTAL_EVENTS = EVENT_TYPE_VECTOR.reduce((n, [, c]) => n + c, 0); // 219541
export const ACTIVE_RIGS = 10;
export const ARCHIVED_RIGS = 17;
export const ACTIVE_NODES = 75;
export const ARCHIVED_NODES = 123;

const NODE_SCOPED = new Set([
  "agent.activity", "agent.session_identity", "node.startup_pending", "node.startup_ready",
  "node.startup_failed", "node.startup_proof_verified", "node.startup_challenged",
  "node.held", "node.launched", "node.reconciled", "node.added", "node.removed",
  "node.claimed", "session.detached", "session.discovered", "session.vanished",
  "session.resume_token_captured", "session.resume_token_set",
]);

// Evenly distribute `total` items across `bins` (deterministic).
function spread(total: number, bins: number): number[] {
  const base = Math.floor(total / bins);
  const extra = total - base * bins;
  return Array.from({ length: bins }, (_, i) => base + (i < extra ? 1 : 0));
}

function payloadFor(type: string, nid: string, rid: string, sname: string): string {
  if (type === "agent.activity") {
    return JSON.stringify({ activity: { state: "active", eventAt: "2026-07-01T00:00:00Z", runtime: "claude" }, sessionName: sname, nodeId: nid, rigId: rid });
  }
  if (type === "node.held") return JSON.stringify({ reason: "awaiting-decision" });
  if (type === "restore.completed" || type === "restore.subset_completed") {
    return JSON.stringify({ result: { nodes: [{ nodeId: nid, status: "resumed" }] } });
  }
  if (type === "restore.outcome_reconciled") return JSON.stringify({ nodeId: nid, to: "resumed" });
  if (type === "node.startup_challenged" || type === "node.startup_proof_verified") {
    return JSON.stringify({ nodeId: nid, verdict: "verified" });
  }
  return "{}";
}

export interface HostShape {
  activeRigIds: string[];
  archivedRigIds: string[];
  allRigIds: string[];
  nodeByRig: Map<string, string[]>;
  allNodeIds: string[];
  sessionNameByNode: Map<string, string>;
}

/** Seed the db to the host shape. Returns the id maps. One transaction for events. */
export function seedHostShaped(db: Database.Database): HostShape {
  const insRig = db.prepare("INSERT INTO rigs (id, name, created_at, archived_at) VALUES (?, ?, ?, ?)");
  const insNode = db.prepare("INSERT INTO nodes (id, rig_id, logical_id, runtime, created_at) VALUES (?, ?, ?, ?, ?)");
  const insSession = db.prepare("INSERT INTO sessions (id, node_id, session_name, status, startup_status, created_at) VALUES (?, ?, ?, ?, ?, ?)");
  const insEvent = db.prepare("INSERT INTO events (rig_id, node_id, type, payload, created_at) VALUES (?, ?, ?, ?, ?)");

  const activeRigIds: string[] = [];
  const archivedRigIds: string[] = [];
  const nodeByRig = new Map<string, string[]>();
  const allNodeIds: string[] = [];
  const sessionNameByNode = new Map<string, string>();

  const seedAll = db.transaction(() => {
    // rigs
    for (let i = 0; i < ACTIVE_RIGS; i++) { const id = `rig-act-${String(i).padStart(2, "0")}`; insRig.run(id, id, BASE_TS, null); activeRigIds.push(id); nodeByRig.set(id, []); }
    for (let i = 0; i < ARCHIVED_RIGS; i++) { const id = `rig-arc-${String(i).padStart(2, "0")}`; insRig.run(id, id, BASE_TS, "2026-07-05 00:00:00"); archivedRigIds.push(id); nodeByRig.set(id, []); }

    // nodes + one latest session each, with a deterministic mixed lifecycle
    const mkNodes = (rigIds: string[], perRig: number[]) => {
      rigIds.forEach((rid, ri) => {
        for (let k = 0; k < perRig[ri]; k++) {
          const nid = `node-${rid}-${k}`;
          insNode.run(nid, rid, `n${k}`, "claude", BASE_TS);
          nodeByRig.get(rid)!.push(nid);
          allNodeIds.push(nid);
          const sname = `sess-${nid}`;
          sessionNameByNode.set(nid, sname);
          // mix: 0 -> running/ready, 1 -> exited/ready (non-running, held-eligible), 2 -> exited/pending (non-ready)
          const m = allNodeIds.length % 3;
          const status = m === 0 ? "running" : "exited";
          const startup = m === 2 ? "pending" : "ready";
          insSession.run(`${sname}-s0`, nid, sname, status, startup, BASE_TS);
        }
      });
    };
    mkNodes(activeRigIds, spread(ACTIVE_NODES, ACTIVE_RIGS));
    mkNodes(archivedRigIds, spread(ARCHIVED_NODES, ARCHIVED_RIGS));

    // events — EXACTLY the authoritative vector, one transaction
    const allRigIds = [...activeRigIds, ...archivedRigIds];
    let ni = 0, ri = 0;
    for (const [type, count] of EVENT_TYPE_VECTOR) {
      const nodeScoped = NODE_SCOPED.has(type);
      for (let c = 0; c < count; c++) {
        if (nodeScoped) {
          const nid = allNodeIds[ni % allNodeIds.length]; ni++;
          const rid = nid.startsWith("node-") ? nid.slice(5).replace(/-\d+$/, "") : allRigIds[0];
          insEvent.run(rid, nid, type, payloadFor(type, nid, rid, sessionNameByNode.get(nid) ?? ""), BASE_TS);
        } else {
          const rid = allRigIds[ri % allRigIds.length]; ri++;
          // restore.* are rig-scoped but reference a node in payload for the outcome fold
          const anchorNode = nodeByRig.get(rid)?.[0] ?? allNodeIds[0];
          insEvent.run(rid, null, type, payloadFor(type, anchorNode, rid, ""), BASE_TS);
        }
      }
    }
  });
  seedAll();

  return { activeRigIds, archivedRigIds, allRigIds: [...activeRigIds, ...archivedRigIds], nodeByRig, allNodeIds, sessionNameByNode };
}
