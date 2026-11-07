import type Database from "better-sqlite3";
import { hasOtherSeatHistory } from "../session-registry.js";
import type { ViewMemberInput } from "./view-composer.js";

export interface TaskObligation { qitemId: string; state: string }
export interface TaskTerminalMember {
  key: { hostId: string | null; nodeId: string | null };
  seat: string;
  obligations: TaskObligation[];
  availability: "available" | "missing" | "stopped" | "hosted" | "unresolved";
  reason?: string;
  /** Membership does not provision or authorize terminal input. */
  viewerStatus: "not-provisioned" | "verified" | "unconfirmed";
  viewer?: import("./herdr-viewer.js").ViewerMapping;
}
export interface TaskMembership {
  kind: "qitem" | "slice" | "mission";
  id: string;
  /** Present only for a genuine queue episode. */
  qitemId?: string;
  name: string;
  complete: boolean;
  issues: string[];
  members: TaskTerminalMember[];
}
export interface TaskSeat {
  hostId: string | null;
  nodeId: string;
  seat: string;
  runtime?: string | null;
  tmuxSession: string | null;
  attachmentType: string | null;
  stopped: boolean;
}
export interface TaskTerminalView { task: TaskMembership; members: ViewMemberInput[] }
interface EpisodeRow {
  qitem_id: string; summary: string | null; destination_session: string; state: string;
  handed_off_from: string | null; chain_of_record: string | null;
  chain_bytes: number;
}
type LineageRow = Pick<EpisodeRow, "qitem_id" | "handed_off_from" | "chain_of_record" | "chain_bytes">;
const ACTIVE = new Set(["pending", "in-progress", "blocked"]);
const MAX_EPISODE_ROWS = 256;
const MAX_LINEAGE_ROWS = 50000;
const MAX_CHAIN_BYTES = 16384;
const MAX_LINEAGE_BYTES = 8 * 1024 * 1024;
const MAX_LINEAGE_LINKS = 100000;
const CHAIN_BYTES = "coalesce(length(CAST(chain_of_record AS BLOB)),0)";
const BOUNDED_CHAIN = `CASE WHEN ${CHAIN_BYTES}<=${MAX_CHAIN_BYTES} THEN chain_of_record ELSE 'null' END AS chain_of_record`;

/** One bounded local lineage projection, then in-memory child expansion.
 * The row, encoded-byte and link budgets bound work on unrelated history as
 * well as the returned episode. Reaching any budget means incomplete, never
 * an empty/complete team. No ancestor/sibling expansion or foreign I/O.
 */
export function readTaskTerminalView(
  db: Database.Database,
  qitemId: string,
  resolveSeat: (address: string) => TaskSeat | null,
): TaskTerminalView | null {
  return db.transaction(() => readTaskTerminalSnapshot(db, qitemId, resolveSeat))();
}

function readTaskTerminalSnapshot(
  db: Database.Database, qitemId: string, resolveSeat: (address: string) => TaskSeat | null,
): TaskTerminalView | null {
  const load = db.prepare(`SELECT qitem_id,summary,destination_session,state,handed_off_from,${BOUNDED_CHAIN},${CHAIN_BYTES} AS chain_bytes
    FROM queue_items WHERE qitem_id=?`);
  const root = load.get(qitemId) as EpisodeRow | undefined;
  if (!root) return null;
  const issues: string[] = [];
  const scanIssues = new Set<string>();
  const knownIds = new Set([qitemId]);
  const exists = db.prepare("SELECT 1 FROM queue_items WHERE qitem_id=?");
  const children = new Map<string, string[]>();
  const indexed = new Set<string>();
  const ancestors: string[] = [], queued = new Set<string>();
  let scanned = 0, bytes = 0, links = 0;
  const indexRow = (row: LineageRow): boolean => {
    if (indexed.has(row.qitem_id)) return true;
    if (scanned++ === MAX_LINEAGE_ROWS) { scanIssues.add(`Lineage scan reached its ${MAX_LINEAGE_ROWS}-row work limit; membership is incomplete.`); return false; }
    indexed.add(row.qitem_id);
    knownIds.add(row.qitem_id);
    if (bytes + row.chain_bytes > MAX_LINEAGE_BYTES) { scanIssues.add("Lineage scan reached its encoded-byte work limit; membership is incomplete."); return false; }
    bytes += row.chain_bytes;
    let chain: unknown = [];
    try { chain = JSON.parse(row.chain_of_record ?? "[]"); } catch { chain = null; }
    if (!Array.isArray(chain)) { scanIssues.add("Some local lineage could not be read within its per-record work limit; membership is incomplete."); chain = []; }
    const refs = new Set([row.handed_off_from, ...(chain as unknown[]).filter((id): id is string => typeof id === "string")]);
    for (const parent of refs) {
      if (!parent) continue;
      if (++links > MAX_LINEAGE_LINKS) { scanIssues.add("Lineage scan reached its link work limit; membership is incomplete."); return false; }
      const list = children.get(parent) ?? []; list.push(row.qitem_id); children.set(parent, list);
      if (!knownIds.has(parent) && !queued.has(parent)) { queued.add(parent); ancestors.push(parent); }
    }
    return true;
  };
  const projection = `SELECT qitem_id,handed_off_from,${BOUNDED_CHAIN},${CHAIN_BYTES} AS chain_bytes FROM queue_items`;
  const lineage = db.prepare(`/* task-lineage */ ${projection}
    WHERE rowid >= (SELECT rowid FROM queue_items WHERE qitem_id=?) ORDER BY rowid LIMIT ?`);
  let withinBudget = true;
  for (const value of lineage.iterate(qitemId, MAX_LINEAGE_ROWS + 1)) {
    if (!indexRow(value as LineageRow)) { withinBudget = false; break; }
  }
  // Earlier active obligations can reference a root that arrived later. The
  // existing state index avoids scanning unrelated closed history. Follow
  // their ancestry by primary key, including closed intermediaries; every
  // loaded row/link shares the same budgets and is processed at most once.
  if (withinBudget) {
    const earlier = db.prepare(`/* task-lineage-older-active */ ${projection} INDEXED BY idx_queue_items_state
      WHERE state IN ('pending','in-progress','blocked')
        AND rowid < (SELECT rowid FROM queue_items WHERE qitem_id=?) LIMIT ?`);
    for (const value of earlier.iterate(qitemId, MAX_LINEAGE_ROWS + 1)) {
      if (!indexRow(value as LineageRow)) { withinBudget = false; break; }
    }
  }
  for (let i = 0; withinBudget && i < ancestors.length; i++) {
    const id = ancestors[i]!;
    if (knownIds.has(id)) continue;
    const row = load.get(id) as EpisodeRow | undefined;
    if (row && !indexRow(row)) withinBudget = false;
  }
  issues.push(...scanIssues);
  const episode = [qitemId], seen = new Set(episode);
  expand: for (const parent of episode) {
    for (const child of children.get(parent) ?? []) {
      if (seen.has(child)) continue;
      if (episode.length === MAX_EPISODE_ROWS) { issues.push(`Episode exceeds ${MAX_EPISODE_ROWS} local rows; membership is incomplete.`); break expand; }
      seen.add(child); episode.push(child);
    }
  }
  const selected = episode.map(id => id === qitemId ? root : load.get(id) as EpisodeRow);
  const ids = new Set(selected.map(row => row.qitem_id));
  const parents = new Map<string, string[]>();
  for (const row of selected) {
    let chain: unknown = [];
    try { chain = JSON.parse(row.chain_of_record ?? "[]"); } catch { chain = null; }
    if (!Array.isArray(chain)) {
      issues.push(`Unreadable lineage on ${row.qitem_id}.`);
      chain = [];
    }
    const refs = [...new Set([row.handed_off_from, ...(chain as unknown[])
      .filter((id): id is string => typeof id === "string" && id.startsWith("qitem-"))]
      .filter((id): id is string => id !== null))];
    // The root's own ancestry is deliberately outside this view.
    if (row.qitem_id !== qitemId) {
      for (const ref of refs) {
        if (!knownIds.has(ref) && !exists.get(ref)) {
          if (scanIssues.size) continue; // Already incomplete; an unscanned row is not proven absent.
          issues.push(`Lineage ${ref} referenced by ${row.qitem_id} is not available locally.`);
        }
      }
    }
    parents.set(row.qitem_id, refs.filter(id => ids.has(id)));
  }
  const visiting = new Set<string>(), visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) { issues.push(`Cyclic lineage at ${id}.`); return; }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const parent of parents.get(id) ?? []) visit(parent);
    visiting.delete(id); visited.add(id);
  };
  for (const row of selected) visit(row.qitem_id);

  return projectTaskOwners({ kind: "qitem", id: qitemId, qitemId, name: selected[0]!.summary?.trim() || qitemId,
    complete: issues.length === 0, issues: [...new Set(issues)] }, selected, resolveSeat);
}

/** Shared owner/availability fold; the caller owns authoritative work enumeration. */
export function projectTaskOwners(
  task: Omit<TaskMembership, "members">,
  selected: readonly { qitem_id: string; destination_session: string; state: string }[],
  resolveSeat: (address: string) => TaskSeat | null,
): TaskTerminalView {
  const owners = new Map<string, TaskTerminalMember>();
  const inputs = new Map<string, ViewMemberInput>();
  const resolved = new Map<string, TaskSeat | null>();
  for (const row of selected) {
    if (!ACTIVE.has(row.state)) continue;
    const address = row.destination_session;
    if (!resolved.has(address)) resolved.set(address, resolveSeat(address));
    const seat = resolved.get(address)!;
    // An unresolved address is retained separately: two unknowns are not one node.
    const id = JSON.stringify(seat ? [seat.hostId, seat.nodeId] : [null, null, address]);
    const existing = owners.get(id);
    if (existing) { existing.obligations.push({ qitemId: row.qitem_id, state: row.state }); continue; }
    const availability = !seat ? "unresolved" : seat.stopped ? "stopped"
      : seat.attachmentType === "external_cli" ? "hosted" : !seat.tmuxSession ? "missing" : "available";
    const reason = availability === "unresolved" ? "Owner has no unambiguous local seat binding; remote owners are not crawled."
      : availability === "stopped" ? "Seat is stopped."
      : availability === "hosted" ? "Seat has no tmux terminal attachment."
      : availability === "missing" ? "No tmux session is recorded for this seat." : undefined;
    owners.set(id, { key: { hostId: seat?.hostId ?? null, nodeId: seat?.nodeId ?? null }, seat: seat?.seat ?? address,
      obligations: [{ qitemId: row.qitem_id, state: row.state }], availability, ...(reason ? { reason } : {}), viewerStatus: "not-provisioned" });
    if (availability === "available" && seat) inputs.set(id, {
      seat: seat.seat, label: seat.seat, ...(seat.runtime ? { runtime: seat.runtime } : {}),
      tmuxSession: seat.tmuxSession, host: null, alive: true,
      // A task can span rigs. Membership is not authority to type; retain the
      // existing derived-scope read-only policy, independent of owner ensure.
      readOnly: true,
    });
  }
  const members = [...owners.values()].sort((a, b) => JSON.stringify(a.key).localeCompare(JSON.stringify(b.key)) || a.seat.localeCompare(b.seat));
  return { task: { ...task, members }, members: [...inputs.values()] };
}

/** Preserve local stopped/unlaunched owners as well as current registry aliases.
 * The registry's node id wins; an unresolved spelling must match exactly one
 * unarchived node/latest-session record. No host suffix is guessed or stripped.
 */
export function resolveLocalTaskSeat(
  db: Database.Database, address: string, hostId: string | null, currentNodeId?: string,
): TaskSeat | null {
  const rows = db.prepare(`SELECT n.id AS nodeId, n.runtime, s.session_name AS seat,
      s.status, b.tmux_session AS tmuxSession, b.attachment_type AS attachmentType
    FROM nodes n JOIN rigs r ON r.id=n.rig_id
    LEFT JOIN sessions s ON s.id=(SELECT id FROM sessions WHERE node_id=n.id ORDER BY id DESC LIMIT 1)
    LEFT JOIN bindings b ON b.node_id=n.id
      AND (b.attachment_type='external_cli' OR b.tmux_session=s.session_name)
    WHERE r.archived_at IS NULL AND (n.id=? OR
      (? IS NULL AND (s.session_name=? OR replace(n.logical_id, '.', '-') || '@' || r.name=?)))`)
    .all(currentNodeId ?? null, currentNodeId ?? null, address, address) as Array<{
      nodeId: string; runtime: string | null; seat: string | null;
      status: string | null; tmuxSession: string | null; attachmentType: string | null;
    }>;
  if (rows.length !== 1) return null;
  const row = rows[0]!;
  if (!currentNodeId && row.seat !== address && hasOtherSeatHistory(db, address, row.nodeId)) return null;
  return { ...row, hostId, seat: row.seat ?? address,
    stopped: row.status === "exited" || row.status === "detached" || row.status === "superseded" };
}
