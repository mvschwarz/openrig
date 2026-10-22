import fs from "node:fs";
import nodePath from "node:path";
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { OutboxHandler, type OutboxEntry } from "./outbox-handler.js";
import {
  inspectSkillDirectory, reconcileSkillLoadout, resolveSkillLoadout,
  type CatalogSkill, type ReconcileSkillLoadoutResult, type SkillRuntime,
} from "./skill-catalog.js";
import { parseSkillFrontmatter } from "./skill-discovery.js";
import { readFootprintAnswer, type FootprintAnswer } from "./footprint-choice.js";
import type { SettingsStore } from "./user-settings/settings-store.js";
import { seatSkillLocation, seatSkillPaths, writeSeatSkillCatalog, type SeatSkillPaths, SEAT_SKILL_ROUTER_ID, resolveSeatSkillRouter, writeSeatSkillRouter, type SeatSkillRouter } from "./seat-skill-storage.js";
import { seatLaunchAdditionsReport, type SeatLaunchAdditionsReport } from "./seat-launch-additions.js";

// OPR.0.7.0.13 (B) — the seat mode of `rig skill loadout`: inspect a seat's stored selection, or apply it and tell the
// running seat. Disk state and delivery state are kept apart. A delivery is recorded against the catalog's digest AND
// the receiving occupant (its generation), so a predecessor's delivery never counts for a fresh successor, and only the
// transport's own evidence is reported: rendering is not the agent having read anything. An attempt that didn't come back
// `delivered` is never resent blindly; the next invocation reports it for a targeted readback instead, and only an
// explicit resend after a finished, undelivered attempt sends it again.
//
// Each attempt is an outbox row, reserved and claimed (pending, then sending) in one transaction BEFORE the send and
// finalized after it, with the outbox's own compare-and-set. So two overlapping calls can't both send, and an attempt
// interrupted mid-send stays `sending` until the daemon's next start recovers it as indeterminate, never resent. The
// row's id is the transport's delivery id, so a typing guard's retention lands on the same row.

type Db = { prepare(sql: string): { get(...params: unknown[]): unknown; all?(...params: unknown[]): unknown[] } };

export interface SeatRef {
  nodeId: string;
  rigId: string;
  logicalId: string;
  runtime: "claude-code" | "codex";
  sessionName: string;
  cwd: string;
}

export interface SeatSkill { id: string; trigger: string; path: string }

export interface SeatDeliveryRecord {
  occupant: string;
  digest: string;
  deliveryId: string;
  /** The attempt's state in the outbox: `unconfirmed` is the outbox's indeterminate (rendered but not confirmed, an
   *  unknown result, or an attempt recovered after an interruption); `in-flight` is reserved or sending right now, or
   *  interrupted and not yet recovered. */
  outcome: "delivered" | "unconfirmed" | "failed" | "retained" | "in-flight";
  at: string;
}

export interface SeatSkillInspection {
  seat: SeatRef;
  storage: string | null;
  skills: SeatSkill[];
  catalogDigest: string | null;
  occupant: string | null;
  /** The latest delivery attempt to the current occupant, if any. */
  delivery: SeatDeliveryRecord | null;
  /** The last attempt to the current occupant that was confirmed delivered, kept apart from a newer unresolved one. */
  confirmed: SeatDeliveryRecord | null;
  /** OPR.0.7.0.13 (router): the seat's one generated router skill, or null when the seat has no storage. `written` says
   *  only that the router file matches what OpenRig last wrote there, not that it covers today's selection: `--apply`
   *  rewrites it best-effort and swallows a write error, so a failed rewrite leaves the earlier router reported. The
   *  bootstrap line is reported apart from it. */
  router: SeatSkillRouter | null;
  /** OPR.0.7.0.13 (router): the person's saved answer on the one-line bootstrap (slice 20's `readFootprintAnswer`), or
   *  `unknown` when the setting couldn't be read. Whether a launch could write the line is that launch's own result;
   *  this read writes nothing and infers nothing. Null when the caller didn't read the setting. */
  bootstrapLine: FootprintAnswer | { state: "unknown" } | null;
  /** OPR.0.7.0.9: what a Claude seat's launch passes of its own additions, and any copy missing or refused; null when
   *  it has none (or isn't a Claude seat). */
  launchAdditions: SeatLaunchAdditionsReport | null;
}

/** The bootstrap line's saved answer for the seat report (see SeatSkillInspection.bootstrapLine). */
export function bootstrapLineChoice(settings: Pick<SettingsStore, "resolveOne">): NonNullable<SeatSkillInspection["bootstrapLine"]> {
  try { return readFootprintAnswer(settings); } catch { return { state: "unknown" }; }
}

/** The seat a session name names (its latest session), or why not. */
export function resolveSeat(db: Db, sessionName: string): { ok: true; seat: SeatRef } | { ok: false; error: string } {
  const row = db.prepare(`SELECT n.id AS nodeId, n.rig_id AS rigId, n.logical_id AS logicalId, n.runtime AS runtime, n.cwd AS cwd
    FROM sessions s JOIN nodes n ON n.id = s.node_id WHERE s.session_name = ? ORDER BY s.id DESC LIMIT 1`).get(sessionName) as
    { nodeId: string; rigId: string; logicalId: string; runtime: string | null; cwd: string | null } | undefined;
  if (!row) return { ok: false, error: `no OpenRig seat has the session ${sessionName}` };
  if (row.runtime !== "claude-code" && row.runtime !== "codex") return { ok: false, error: `${sessionName} is a ${row.runtime ?? "unknown"} seat; seat skills are kept for Claude Code and Codex seats` };
  return { ok: true, seat: { nodeId: row.nodeId, rigId: row.rigId, logicalId: row.logicalId, runtime: row.runtime, sessionName, cwd: row.cwd ?? "." } };
}

const pathsOf = (seat: SeatRef) => seatSkillPaths({ rigId: seat.rigId, logicalId: seat.logicalId, runtime: seat.runtime });

/** Every attempt's outbox id starts with this. */
export const SEAT_SKILL_ATTEMPT_PREFIX = "seat-skill-list:";
const attemptPrefix = (seat: SeatRef, occupant: string) => `${SEAT_SKILL_ATTEMPT_PREFIX}${seat.nodeId}:${occupant}:`;

function recordOf(entry: OutboxEntry, occupant: string): SeatDeliveryRecord {
  const digest = /:([0-9a-f]{64}):\d+$/.exec(entry.outboxId)?.[1] ?? "";
  const outcome: SeatDeliveryRecord["outcome"] = entry.deliveryState === "delivered" ? "delivered"
    : entry.deliveryState === "failed" ? "failed"
      : entry.deliveryState === "retained" || entry.deliveryState === "retired" ? "retained"
        : entry.deliveryState === "indeterminate" ? "unconfirmed" : "in-flight";
  return { occupant, digest, deliveryId: entry.outboxId, outcome, at: entry.deliveredAt ?? entry.tsDispatched };
}

/** This occupant's attempts, oldest first. */
function attemptsFor(db: Database.Database, seat: SeatRef, occupant: string): SeatDeliveryRecord[] {
  const prefix = attemptPrefix(seat, occupant);
  const rows = db.prepare(`SELECT outbox_id FROM outbox_entries WHERE substr(outbox_id, 1, ?) = ? ORDER BY ts_dispatched ASC, rowid ASC`)
    .all(prefix.length, prefix) as Array<{ outbox_id: string }>;
  const outbox = new OutboxHandler(db);
  return rows.map((row) => outbox.getById(row.outbox_id)).filter((e): e is OutboxEntry => e !== null).map((e) => recordOf(e, occupant));
}

/** At a daemon start: attempts a previous process left mid-send become indeterminate, without sending. */
export function recoverSeatSkillAttempts(db: Database.Database): number {
  return new OutboxHandler(db).reconcileAbandonedSending(SEAT_SKILL_ATTEMPT_PREFIX);
}

function listSkills(paths: SeatSkillPaths): SeatSkill[] {
  let ids: string[] = [];
  // As in the catalog: only OpenRig's own generated router is left out; anything else under that name is listed.
  const routerGenerated = resolveSeatSkillRouter(paths).written;
  try { ids = fs.readdirSync(paths.skillsRoot, { withFileTypes: true }).filter((e) => e.isDirectory() && !(e.name === SEAT_SKILL_ROUTER_ID && routerGenerated)).map((e) => e.name).sort(); } catch {}
  const out: SeatSkill[] = [];
  for (const id of ids) {
    const file = nodePath.join(paths.skillsRoot, id, "SKILL.md");
    try {
      const parsed = parseSkillFrontmatter(fs.readFileSync(file, "utf8"));
      if (parsed.ok) out.push({ id: String(parsed.frontmatter.name), trigger: String(parsed.frontmatter.description).replace(/\s+/g, " ").trim(), path: file });
    } catch {}
  }
  return out;
}

/** What a seat has on disk, and what its current occupant was last sent. Reads only. */
export function inspectSeatSkills(seat: SeatRef, occupant: string | null, db?: Database.Database,
  bootstrapLine: SeatSkillInspection["bootstrapLine"] = null): SeatSkillInspection {
  const paths = pathsOf(seat);
  const exists = fs.existsSync(paths.root);
  const digest = (() => { try { return createHash("sha256").update(fs.readFileSync(paths.catalogPath)).digest("hex"); } catch { return null; } })();
  return {
    seat,
    storage: exists ? paths.root : null,
    skills: exists ? listSkills(paths) : [],
    router: exists ? resolveSeatSkillRouter(paths) : null,
    bootstrapLine,
    launchAdditions: seat.runtime === "claude-code" ? seatLaunchAdditionsReport(paths) : null,
    catalogDigest: digest,
    occupant,
    ...(() => {
      const attempts = occupant && db ? attemptsFor(db, seat, occupant) : [];
      return { delivery: attempts.at(-1) ?? null, confirmed: attempts.filter((a) => a.outcome === "delivered").at(-1) ?? null };
    })(),
  };
}

export interface SeatSkillApplyResult {
  inspection: SeatSkillInspection;
  /** The on-disk reconciliation of the seat's stored selection: `none` when the seat has no stored selection, and
   *  `unreadable` (never ok) when its record exists but can't be read or parsed. */
  disk: { ok: boolean; selection: "reconciled" | "none" | "unreadable"; receipts: ReconcileSkillLoadoutResult["receipts"]; removed: string[]; errors: string[] };
  /** What the running seat was told, by the transport's own evidence. */
  delivery:
    | { state: "sent"; record: SeatDeliveryRecord; transportOutcome: string; detail?: string }
    | { state: "already-delivered"; record: SeatDeliveryRecord }
    | { state: "earlier-attempt-unconfirmed"; record: SeatDeliveryRecord }
    | { state: "attempt-in-flight"; record: SeatDeliveryRecord }
    | { state: "not-sent"; reason: string };
}

export interface SeatSkillSender {
  send(sessionName: string, text: string, opts: { deliveryId: string; verify: boolean; waitForIdleMs?: number }): Promise<{ ok: boolean; outcome?: "delivered" | "rendered-unconfirmed" | "failed" | "retained" | "unknown"; error?: string; reason?: string }>;
}

/**
 * Reconcile the seat's stored selection into its own storage, then, for a Codex seat whose catalog the current occupant
 * hasn't been sent, send it once through the existing transport and record exactly what the transport reported.
 */
export async function applySeatSkills(input: {
  db: Database.Database;
  seat: SeatRef;
  occupant: string | null;
  catalogRoot: string;
  sender?: SeatSkillSender;
  waitForIdleMs?: number;
  /** Send this list again after a finished attempt that wasn't delivered (failed or unconfirmed), once a person has
   *  checked the pane. Never while an attempt is in flight, retained by the typing guard, or already delivered. */
  resend?: boolean;
  /** Who is sending, as the transport records it (a guard's retention must match the reserved row). */
  actorSession?: string;
  bootstrapLine?: SeatSkillInspection["bootstrapLine"];
}): Promise<SeatSkillApplyResult> {
  const { seat, db } = input;
  const paths = pathsOf(seat);
  const disk = reconcileStoredSelection(seat, paths, input.catalogRoot);
  // The seat's generated router follows what is now in its storage, for either runtime. A router that isn't written
  // is reported (kept or refused) in the inspection; it never stops the apply.
  if (disk.ok && fs.existsSync(paths.root)) {
    try { writeSeatSkillRouter(paths); } catch { /* reported by the inspection: the router isn't there as written */ }
  }
  const result = (delivery: SeatSkillApplyResult["delivery"]): SeatSkillApplyResult => ({ inspection: inspectSeatSkills(seat, input.occupant, db, input.bootstrapLine ?? null), disk, delivery });
  if (seat.runtime !== "codex") return result({ state: "not-sent", reason: "a Claude seat reads its skills from its own plugin; nothing is sent to the running session" });
  // An unreadable selection never reaches the catalog or the seat.
  if (!disk.ok) return result({ state: "not-sent", reason: disk.selection === "unreadable"
    ? "the seat's stored selection couldn't be read, so nothing was reconciled or sent" : "the seat's selection was not reconciled, so its list was not sent" });
  let catalog: ReturnType<typeof writeSeatSkillCatalog>;
  try { catalog = writeSeatSkillCatalog(paths); } catch (error) {
    return result({ state: "not-sent", reason: `the seat's catalog couldn't be written (${(error as Error).message}), so nothing was sent` });
  }
  if (catalog.kept) return result({ state: "not-sent", reason: catalog.reason === "linked"
    ? `${catalog.path} is not inside this seat's storage (a link on the way); nothing was written or sent`
    : `${catalog.path} differs from what OpenRig last wrote; kept as it is and not sent` });
  const occupant = input.occupant;
  if (!occupant) return result({ state: "not-sent", reason: "the seat has no running occupant to send to" });
  if (!input.sender) return result({ state: "not-sent", reason: "no transport is available on this daemon" });

  const text = fs.readFileSync(catalog.path, "utf8");
  const outbox = new OutboxHandler(db);
  // Reserve and claim this attempt in one transaction, after reading the earlier ones: two overlapping calls can't
  // both get here, and the row exists before anything is sent.
  const reserved = db.transaction((): { send: string } | { state: SeatSkillApplyResult["delivery"] } => {
    const attempts = attemptsFor(db, seat, occupant).filter((a) => a.digest === catalog.digest);
    const delivered = attempts.find((a) => a.outcome === "delivered");
    if (delivered) return { state: { state: "already-delivered", record: delivered } };
    const last = attempts.at(-1);
    if (last?.outcome === "in-flight") return { state: { state: "attempt-in-flight", record: last } };
    if (last && !(input.resend && (last.outcome === "failed" || last.outcome === "unconfirmed"))) {
      return { state: { state: "earlier-attempt-unconfirmed", record: last } };
    }
    const id = `${attemptPrefix(seat, occupant)}${catalog.digest}:${attempts.length + 1}`;
    outbox.record({ outboxId: id, senderSession: input.actorSession ?? "unknown", destinationSession: seat.sessionName, body: text, tags: ["seat-skill-list"] });
    if (!outbox.claimForDelivery(id)) throw new Error(`seat skill attempt ${id} could not be claimed`);
    return { send: id };
  })();
  if ("state" in reserved) return result(reserved.state);

  const deliveryId = reserved.send;
  let sent: Awaited<ReturnType<SeatSkillSender["send"]>>;
  try {
    sent = await input.sender.send(seat.sessionName, text, { deliveryId, verify: true, ...(input.waitForIdleMs ? { waitForIdleMs: input.waitForIdleMs } : {}) });
  } catch (error) {
    sent = { ok: false, outcome: "unknown", error: (error as Error).message };
  }
  const transportOutcome = sent.outcome ?? (sent.ok ? "unknown" : "failed");
  // Only a confirmed delivery or a definite failure is final as such; rendering without confirmation, or not knowing,
  // is indeterminate. A guard's retention has already moved the row to retained, which this leaves as it is.
  const finalized = outbox.finalizeDelivery(deliveryId, transportOutcome === "delivered" ? "delivered"
    : transportOutcome === "failed" ? "failed" : transportOutcome === "retained" ? "retained" : "indeterminate");
  return result({ state: "sent", record: recordOf(finalized, occupant), transportOutcome, ...(sent.error || sent.reason ? { detail: sent.error ?? sent.reason } : {}) });
}

/** The seat's stored selection, from its own record: the catalog skills it selected (re-resolved against the catalog as it
 *  is now) and its plugin skills (re-inspected at their recorded sources), reconciled into its storage. */
function reconcileStoredSelection(seat: SeatRef, paths: SeatSkillPaths, catalogRoot: string): SeatSkillApplyResult["disk"] {
  let manifest: { topologySelections?: Record<string, string[]>; projectSelection?: string[]; skills?: Array<Record<string, unknown>> };
  let raw: string;
  try { raw = fs.readFileSync(paths.manifestPath, "utf8"); } catch (err) {
    // No record at all: the seat has no stored selection, which is its own outcome. Any other read failure is not.
    return (err as NodeJS.ErrnoException).code === "ENOENT"
      ? { ok: true, selection: "none", receipts: [], removed: [], errors: [] }
      : { ok: false, selection: "unreadable", receipts: [], removed: [], errors: [`${paths.manifestPath}: ${(err as Error).message}`] };
  }
  try {
    manifest = JSON.parse(raw);
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error("not a selection record");
  } catch (err) {
    return { ok: false, selection: "unreadable", receipts: [], removed: [], errors: [`${paths.manifestPath}: ${(err as Error).message}`] };
  }
  const owners = Object.keys(manifest.topologySelections ?? {});
  const owner = owners[0] ?? seat.sessionName;
  const selected = new Set(Object.values(manifest.topologySelections ?? {}).flat());
  const pluginEntries: CatalogSkill[] = [];
  for (const skill of manifest.skills ?? []) {
    const pluginId = /^plugin:([^@]+)/.exec(String(skill["revision"] ?? ""))?.[1];
    if (!pluginId || typeof skill["sourceDir"] !== "string") continue;
    try {
      pluginEntries.push({ id: String(skill["id"]), sourceDir: skill["sourceDir"], sourceRoot: String(skill["sourceRoot"]), revision: String(skill["revision"]),
        ...inspectSkillDirectory(skill["sourceDir"]), selectedBy: ["topology"], pluginId });
      selected.delete(String(skill["id"]));
    } catch {}
  }
  const resolved = resolveSkillLoadout({ catalogRoot, topologySkills: [...selected], projectSkills: manifest.projectSelection ?? [] });
  if (!resolved.ok) return { ok: false, selection: "reconciled", receipts: [], removed: [], errors: resolved.errors.map((e) => `${e.code}: ${e.message}`) };
  const projection = reconcileSkillLoadout({
    loadout: { ...resolved.loadout, entries: [...resolved.loadout.entries, ...pluginEntries] },
    runtime: seat.runtime as SkillRuntime, cwd: seat.cwd, apply: true, topologyOwner: owner, location: seatSkillLocation(paths, seat.runtime),
  });
  return { ok: projection.ok, selection: "reconciled", receipts: projection.receipts, removed: projection.removed, errors: projection.errors.map((e) => `${e.code}: ${e.message}`) };
}
