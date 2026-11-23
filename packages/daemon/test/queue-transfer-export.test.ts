import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { migrate } from "../src/db/migrate.js";
import { buildQueueTransfer, QUEUE_TRANSFER_COLUMNS, readQueueTransfer } from "../src/domain/queue-transfer-export.js";

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  migrate(db, ALL_MIGRATIONS);
});
afterEach(() => db.close());

function seed() {
  db.exec(`INSERT INTO self_host_identity VALUES (1, 'origin', 'minted', 'reconciled');
    INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session,
      state, body, tags, human_answers, return_route, return_route_basis, handed_off_to, claimed_by_generation_uuid) VALUES
      ('qitem-b', '1', '1', 'a@other@elsewhere', 'b@other', 'pending', 'unrelated', '[]', NULL, NULL, NULL, NULL, NULL),
      ('qitem-a', '1', '1', 'a@demo@origin', 'b@other@elsewhere', 'in-progress', 'body', '["mission:demo","slice:one"]',
       '["answer"]', 'reply@demo@origin', 'inherited', 'qitem-outside@elsewhere', 'generation-a');
    INSERT INTO queue_transitions_archive (transition_id, qitem_id, ts, state, actor_session, transition_note, archived_at,
      identity_provenance, identity_principal, owner_notification_kind, owner_notification_level)
      VALUES (3, 'qitem-a', '1', 'blocked', 'a@demo@origin', 'archived note', 'archive time', 'transport:v1', 'old principal', 'ask', 'urgent');
    INSERT INTO queue_transitions (transition_id, qitem_id, ts, state, actor_session, transition_note,
      identity_provenance, identity_principal, owner_notification_kind, owner_notification_level)
      VALUES (5, 'qitem-a', '1', 'in-progress', 'a@demo@origin', 'live note', 'principal:v1', 'current principal', 'update', 'routine');
    INSERT INTO queue_transition_wakes VALUES (3, 'qitem-a', 'armed', 'timer', 'timer-a', NULL);
    INSERT INTO mission_control_actions (action_id, action_verb, qitem_id, actor_session, acted_at, reason, identity_provenance)
      VALUES ('action-a', 'note', 'qitem-a', 'a@demo@origin', '2', 'audit reason', 'transport:v1');
    INSERT INTO queue_erased_ids VALUES ('qitem-erased', '2', 'delete'), ('qitem-unrelated', '2', 'delete');
    INSERT INTO queue_erased_rigs VALUES ('rig-demo', 'demo', 'digest', '1', NULL), ('rig-other', 'other', 'digest', '1', NULL);`);
}

it("matches the migrated queue and source history column inventories", () => {
  for (const [table, columns] of Object.entries({ ...QUEUE_TRANSFER_COLUMNS,
    mission_control_actions: [...QUEUE_TRANSFER_COLUMNS.mission_control_actions, "imported_from"],
    queue_transitions_archive: [...QUEUE_TRANSFER_COLUMNS.queue_transitions, "archived_at"] })) {
    expect(db.prepare<[], { name: string }>(`PRAGMA table_info(${table})`).all().map(row => row.name).sort()).toEqual([...columns].sort());
  }
  expect(QUEUE_TRANSFER_COLUMNS.queue_items).toHaveLength(39);
});

it("refuses an unreconciled source and an incomplete explicit ID selection", () => {
  expect(() => buildQueueTransfer(db, { kind: "host" })).toThrow(/origin_identity_missing/);
  seed();
  expect(() => buildQueueTransfer(db, { kind: "qitems", names: ["qitem-a", "qitem-missing"] })).toThrow(/selection_not_found/);
});

it("preserves source history and verbatim routes without copying outside work or delivery intents", () => {
  seed();
  const result = readQueueTransfer(db, { kind: "qitems", names: ["qitem-a"] });
  expect(result.rows).toEqual([expect.objectContaining({ qitemId: "qitem-a", state: "in-progress", humanAnswers: '["answer"]',
    body: "body", returnRoute: "reply@demo@origin", handedOffTo: "qitem-outside@elsewhere", claimedByGenerationUuid: "generation-a",
    transitions: [expect.objectContaining({ transitionId: 3, archivedAt: "archive time", transitionNote: "archived note",
      identityProvenance: "transport:v1", identityPrincipal: "old principal", ownerNotificationKind: "ask", ownerNotificationLevel: "urgent" }),
    expect.objectContaining({ transitionId: 5, archivedAt: null, transitionNote: "live note", identityProvenance: "principal:v1",
      identityPrincipal: "current principal", ownerNotificationKind: "update", ownerNotificationLevel: "routine" })],
    wakeEvidence: [expect.objectContaining({ transitionId: 3, wakeRef: "timer-a" })],
    missionControlActions: [expect.objectContaining({ actionId: "action-a", reason: "audit reason", identityProvenance: "transport:v1" })] })]);
  expect(Object.keys(result).sort()).toEqual(["createdAt", "erasedIds", "erasedRigs", "format", "origin", "rows", "scope", "transferId"]);
  expect(result.origin).not.toHaveProperty("generation");
});

it("includes all erasure receipts when exporting the whole host", () => {
  seed();
  const host = readQueueTransfer(db, { kind: "host" });
  expect(host.scope.qitemIds).toEqual(["qitem-a", "qitem-b", "qitem-erased", "qitem-unrelated"]);
  expect(host.erasedIds.map(row => row.qitemId)).toEqual(["qitem-erased", "qitem-unrelated"]);
  expect(host.erasedRigs.map(row => row.rigId)).toEqual(["rig-demo", "rig-other"]);
});

it("selects only local endpoints and includes receipts for named rigs or IDs", () => {
  seed();
  const rig = readQueueTransfer(db, { kind: "rig", names: ["demo"] });
  expect(rig.scope.qitemIds).toEqual(["qitem-a"]);
  expect(rig.erasedRigs.map(row => row.rigId)).toEqual(["rig-demo"]);
  expect(readQueueTransfer(db, { kind: "qitems", names: ["qitem-erased"] }).erasedIds.map(row => row.qitemId)).toEqual(["qitem-erased"]);
});

it.each([{ kind: "mission", name: "demo" }, { kind: "slice", name: "one" }] as const)(
  "includes only traceable erasure receipts when exporting a $kind", ({ kind, name }) => {
    seed();
    db.exec("INSERT INTO queue_erased_ids VALUES ('qitem-a', '0', 'delete')");
    const result = readQueueTransfer(db, { kind, names: [name] });
    expect(result.scope.qitemIds).toEqual(["qitem-a"]);
    expect(result.erasedIds.map(row => row.qitemId)).toEqual(["qitem-a"]);
    expect(result.erasedRigs.map(row => row.rigId)).toEqual(["rig-demo"]);
  },
);

it("warns and skips host-qualified rig selectors, keeping the valid part", () => {
  seed();
  db.exec("UPDATE queue_items SET source_session = 'a@demo@elsewhere' WHERE qitem_id = 'qitem-b'");
  // A mixed list keeps its valid part and names the skipped selector; the selection is
  // shown as given.
  // The sealed envelope keeps the fixed shape; the summary carries skippedSelectors.
  const plain = buildQueueTransfer(db, { kind: "rig", names: ["demo"] });
  const mixed = buildQueueTransfer(db, { kind: "rig", names: ["demo", "demo@elsewhere"] });
  expect(mixed.skippedSelectors).toEqual(["demo@elsewhere"]);
  expect(mixed.scope.rigs).toEqual(["demo", "demo@elsewhere"]);
  // The same rows a plain --rig demo export selects — and the plain export provably
  // leaves the foreign endpoint's work out.
  expect(plain.rows.map(row => row.qitemId)).toEqual(["qitem-a"]);
  expect(mixed.rows).toEqual(plain.rows);
  // A host-qualified selector must not pick up an erased-rig receipt by that name:
  // the mixed export's receipts equal the plain one's, and the all-skipped export has none.
  db.exec("INSERT INTO queue_erased_rigs (rig_id, rig_name, members_digest, verified_at) VALUES ('rig-elsewhere', 'demo@elsewhere', 'digest', '2026-02-03T04:05:06.000Z')");
  const plainReceipts = buildQueueTransfer(db, { kind: "rig", names: ["demo"] });
  const mixedReceipts = buildQueueTransfer(db, { kind: "rig", names: ["demo", "demo@elsewhere"] });
  expect(mixedReceipts.erasedRigs).toEqual(plainReceipts.erasedRigs);
  const emptyReceipts = buildQueueTransfer(db, { kind: "rig", names: ["demo@elsewhere", "other@x"] });
  expect(emptyReceipts.erasedRigs).toEqual([]);
  // All-@ input: the empty archive stays valid, with both selectors named as skipped.
  const empty = buildQueueTransfer(db, { kind: "rig", names: ["demo@elsewhere", "other@x"] });
  expect(empty.rows).toEqual([]);
  expect(empty.skippedSelectors).toEqual(["demo@elsewhere", "other@x"]);
  expect(empty.scope.rigs).toEqual(["demo@elsewhere", "other@x"]);
});

it("leaves claims, unrelated work and late reports untouched across disjoint exports", () => {
  seed();
  const before = db.serialize();
  db.pragma("query_only = ON");
  const earlier = buildQueueTransfer(db, { kind: "qitems", names: ["qitem-a"] });
  buildQueueTransfer(db, { kind: "qitems", names: ["qitem-b"] });
  expect(db.serialize()).toEqual(before);
  db.pragma("query_only = OFF");
  db.exec(`UPDATE queue_items SET state = 'done', resolution = 'late report' WHERE qitem_id = 'qitem-a';
    UPDATE queue_items SET state = 'in-progress' WHERE qitem_id = 'qitem-b';`);
  expect(earlier.archive).not.toContain("late report");
  const later = buildQueueTransfer(db, { kind: "host" });
  expect(later.archive).toContain("late report");
  expect(later.rows.map(row => row.state)).toEqual(["done", "in-progress"]);
});

it("retains the scrub marker but never re-exports content written after a scrub", () => {
  seed();
  db.exec("UPDATE queue_items SET content_erased_at = 'scrub time' WHERE qitem_id = 'qitem-a'");
  const { archive } = buildQueueTransfer(db, { kind: "qitems", names: ["qitem-a"] });
  expect(JSON.parse(archive).rows[0]).toMatchObject({ contentErasedAt: "scrub time", body: "", humanAnswers: null });
  for (const text of ["archived note", "live note", "old principal", "current principal", "audit reason"]) expect(archive).not.toContain(text);
});
