import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

export const OPERATION_CONTRACT = "operation-correlation.v1";
export const OPERATION_KINDS = ["rig.create", "rig.import", "member.add"] as const;
type OperationKind = typeof OPERATION_KINDS[number];
type Row = { request_hash: string; rig_id: string | null; node_ids_json: string };

export type RecordCreated = (rigId: string, nodeId?: string) => void;

/** Accept RFC UUID versions used by clients; a missing header is an ordinary request. */
export function validOperationId(header: string | undefined): boolean {
  return header === undefined || /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(header);
}

/** Reserve synchronously before asynchronous preflight or effects. The hash binds the exact request envelope. */
export function reserveOperation(
  db: Database.Database,
  header: string | undefined,
  kind: OperationKind,
  targets: string[],
  body: string,
  headers: (string | null)[] = [],
) {
  if (header === undefined) return { state: "absent" as const };
  const operationId = header.toLowerCase();
  if (!validOperationId(header)) {
    return { state: "invalid" as const };
  }
  const hash = createHash("sha256").update(JSON.stringify(["v1", kind, targets, body, headers])).digest("hex");
  const inserted = db.prepare("INSERT OR IGNORE INTO operation_correlations (operation_id, request_hash) VALUES (?, ?)")
    .run(operationId, hash).changes === 1;
  const read = () => db.transaction(() => {
    const row = db.prepare("SELECT request_hash, rig_id, node_ids_json FROM operation_correlations WHERE operation_id = ?")
      .get(operationId) as Row;
    const nodeIds = JSON.parse(row.node_ids_json) as string[];
    const rig = row.rig_id
      ? db.prepare("SELECT id, archived_at AS archivedAt FROM rigs WHERE id = ?").get(row.rig_id) as { id: string; archivedAt: string | null } | undefined
      : undefined;
    const nodes = nodeIds.map((id) => {
      const exists = !!db.prepare("SELECT 1 FROM nodes WHERE id = ?").get(id);
      const session = exists ? db.prepare(
        "SELECT id, status, startup_status AS startupStatus FROM sessions WHERE node_id = ? ORDER BY created_at DESC, id DESC LIMIT 1",
      ).get(id) as { id: string; status: string; startupStatus: string | null } | undefined : undefined;
      return { id, exists, latestSession: session ?? null };
    });
    return { contract: OPERATION_CONTRACT, operationId, rigId: row.rig_id, nodeIds,
      current: { rig: row.rig_id ? { id: row.rig_id, exists: !!rig, archivedAt: rig?.archivedAt ?? null } : null, nodes } };
  })();
  if (!inserted) {
    const existing = db.prepare("SELECT request_hash FROM operation_correlations WHERE operation_id = ?")
      .get(operationId) as Pick<Row, "request_hash">;
    return existing.request_hash === hash
      ? { state: "replay" as const, operation: read() }
      : { state: "conflict" as const };
  }
  const recordCreated = (rigId: string, nodeId?: string) => {
    const row = db.prepare("SELECT rig_id, node_ids_json FROM operation_correlations WHERE operation_id = ?")
      .get(operationId) as Pick<Row, "rig_id" | "node_ids_json">;
    if (row.rig_id && row.rig_id !== rigId) throw new Error("Operation rig identity changed");
    const ids = JSON.parse(row.node_ids_json) as string[];
    if (nodeId && !ids.includes(nodeId)) ids.push(nodeId);
    db.prepare("UPDATE operation_correlations SET rig_id = ?, node_ids_json = ? WHERE operation_id = ?")
      .run(rigId, JSON.stringify(ids), operationId);
  };
  return { state: "fresh" as const, recordCreated, read };
}
