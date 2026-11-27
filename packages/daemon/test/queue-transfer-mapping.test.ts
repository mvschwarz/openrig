import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { migrate } from "../src/db/migrate.js";
import { buildQueueTransfer } from "../src/domain/queue-transfer-export.js";
import { applyTransferMapping, mappingDigest, transferReadiness } from "../src/domain/queue-transfer-mapping.js";
import { parseQueueTransfer } from "../src/domain/queue-transfer-parse.js";

it("maps live routes but leaves historical actors and lineage untouched", () => {
  const row = { qitemId: "qitem-a", destinationSession: "b@old@origin", sourceSession: "a@old",
    blockedOn: "qitem-b@origin", returnRoute: "a@old@origin", chainOfRecord: '["a@old"]',
    handedOffTo: "a@old", transitions: [{ actorSession: "a@old" }] };
  const mapping = [{ from: "a@old", to: "a@new" }, { from: "b@old@origin", to: "b@new" }];
  expect(applyTransferMapping(row, "origin", mapping)).toEqual({
    row: { ...row, destinationSession: "b@new", sourceSession: "a@new", returnRoute: "a@new" },
    remapped: expect.arrayContaining([expect.objectContaining({ field: "returnRoute", from: "a@old@origin", to: "a@new" })]),
  });
  expect(mappingDigest(mapping)).toBe(mappingDigest([...mapping].reverse()));
});

it("requires a local runnable destination even with an empty mapping", () => {
  const db = new Database(":memory:");
  try {
    migrate(db, ALL_MIGRATIONS);
    db.exec(`INSERT INTO self_host_identity VALUES (1, 'origin', 'minted', 'reconciled');
      INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, body)
      VALUES ('qitem-a', '1', '1', 'a@old', 'b@old', 'pending', 'body');`);
    const parsed = parseQueueTransfer(buildQueueTransfer(db, { kind: "host" }).archive);
    db.exec("DELETE FROM queue_items");
    expect(transferReadiness(db, parsed, []).unresolved).toEqual(["qitem-a"]);
    const local = [{ from: "b@old", to: "daemon@kernel" }];
    expect(transferReadiness(db, parsed, local)).toMatchObject({ projectedRunnable: ["qitem-a"], unresolved: [] });
  } finally {
    db.close();
  }
});
