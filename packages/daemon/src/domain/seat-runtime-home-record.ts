import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import type { EventBus } from "./event-bus.js";
import type { SessionRegistry } from "./session-registry.js";
import { RUNTIME_HOME_VAR, seatAccountHome, seatRuntimeHome, type HomeRuntime } from "./seat-runtime-home.js";
import { resolveActiveOccupantRow } from "./active-occupant.js";
import type { RuntimeHomeRecordRef, RuntimeHomeSlot } from "./seat-runtime-home-record-types.js";
export type { RuntimeHomeRecordRef, RuntimeHomeSlot } from "./seat-runtime-home-record-types.js";

/** The runtimes whose home an operator can record: a Pi seat keeps its managed login, so it isn't one of them. */
export const RECORDABLE_HOME_RUNTIMES = ["claude-code", "codex"] as const;
type RecordableRuntime = typeof RECORDABLE_HOME_RUNTIMES[number];

export interface RuntimeHomeState {
  runtime: RecordableRuntime;
  variable: string;
  /** The home the seat's next launch uses: its own, else the daemon's explicit value; null means the native default. */
  home: string | null;
  source: "member" | "rig" | "account-switch" | "daemon_environment" | "native_default";
  /** A declared value that isn't an absolute path, which the seat's launch leaves out. */
  ignored?: { source: "member" | "rig"; value: string };
  occupantGeneration: string | null;
  original: string | null;
  /** When several session rows could be the seat's current one and none is uniquely running: their ids. The seat then has
   *  no single original. */
  originalCandidates?: string[];
  /** 0 until a home is first recorded for this seat. */
  revision: number;
  record: RuntimeHomeRecordRef | null;
}

interface RecordRow {
  operation_id: string; node_id: string; runtime: string; revision: number; home: string; slot: RuntimeHomeSlot;
  previous_home: string | null; previous_source: string; original: string | null; occupant_generation: string | null;
  request_hash: string; reason: string; operator: string | null; created_at: string;
}

function hasRecords(db: Database.Database): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'seat_runtime_home_records'").get();
}

const toRef = (row: RecordRow): RuntimeHomeRecordRef => ({ revision: row.revision, home: row.home, slot: row.slot,
  original: row.original, occupantGeneration: row.occupant_generation, operationId: row.operation_id, recordedAt: row.created_at });

/** A seat's latest recorded home, or null when none was recorded (or the database predates the record). */
export function latestRuntimeHomeRecord(db: Database.Database, nodeId: string): RuntimeHomeRecordRef | null {
  if (!hasRecords(db)) return null;
  const row = db.prepare("SELECT * FROM seat_runtime_home_records WHERE node_id = ? ORDER BY revision DESC LIMIT 1").get(nodeId) as RecordRow | undefined;
  return row ? toRef(row) : null;
}

/** The latest recorded home of each seat that has one, for a snapshot to carry. */
export function runtimeHomeRecordsByNode(db: Database.Database, nodeIds: readonly string[]): Record<string, RuntimeHomeRecordRef> {
  const out: Record<string, RuntimeHomeRecordRef> = {};
  for (const nodeId of nodeIds) {
    const record = latestRuntimeHomeRecord(db, nodeId);
    if (record) out[nodeId] = record;
  }
  return out;
}

/** The seat's original conversation: the native id its current session carries. The current session is read as the restore
 *  paths read it (the occupant ladder over rows that aren't superseded or exited), so a newer row a failed launch left
 *  beside the live occupant isn't taken for it. A stopped seat, with none of those, falls back to its newest row that
 *  wasn't superseded. Several candidates with none uniquely running give no single original, and say which. */
function currentOriginal(db: Database.Database, nodeId: string): { original: string | null; candidates?: string[] } {
  const rows = db.prepare("SELECT id, node_id AS nodeId, status, resume_token AS resumeToken FROM sessions WHERE node_id = ? ORDER BY id")
    .all(nodeId) as Array<{ id: string; nodeId: string; status: string | null; resumeToken: string | null }>;
  const live = rows.filter((row) => row.status !== "superseded" && row.status !== "exited");
  const resolved = resolveActiveOccupantRow(live, undefined, nodeId);
  if (resolved.kind === "resolved") return { original: resolved.session.resumeToken ?? null };
  if (resolved.kind === "ambiguous") return { original: null, candidates: resolved.candidateIds };
  return { original: rows.filter((row) => row.status !== "superseded").at(-1)?.resumeToken ?? null };
}

export function readRuntimeHomeState(db: Database.Database, sessions: SessionRegistry, nodeId: string, runtime: RecordableRuntime,
  daemonEnv: NodeJS.ProcessEnv = process.env): RuntimeHomeState {
  const variable = RUNTIME_HOME_VAR[runtime];
  const own = seatRuntimeHome(db, nodeId, runtime);
  const daemonHome = daemonEnv[variable];
  const record = latestRuntimeHomeRecord(db, nodeId);
  const current = currentOriginal(db, nodeId);
  return { runtime, variable,
    home: own.home ?? daemonHome ?? null,
    source: own.source ?? (daemonHome ? "daemon_environment" : "native_default"),
    ...(own.ignored ? { ignored: own.ignored } : {}),
    occupantGeneration: sessions.currentOccupantTenure(nodeId)?.generationUuid ?? null,
    original: current.original, ...(current.candidates ? { originalCandidates: current.candidates } : {}),
    revision: record?.revision ?? 0, record };
}

export interface RuntimeHomeObservation {
  home: "present" | "missing" | "not_a_directory" | "unreadable";
  /** Whether the original conversation's record is in that home. Finding it there doesn't say this copy is fresher
   *  than one in another home: nothing here compares them. */
  original: "found" | "not_found" | "unknown" | "none";
  /** A recording never reads or changes a running process, so which home it uses isn't known from here. */
  runningProcess: "unverified";
}

/** Look for the original's record in a home. Codex keeps `sessions/YYYY/MM/DD/rollout-…-<id>.jsonl`, read with an entry
 *  budget and a depth bound; Claude keeps `projects/<project>/<id>.jsonl`, read one project level deep with no entry
 *  bound. Only what the filesystem reports absent reads not_found; a path it won't let us read reads unknown. */
export function observeRuntimeHome(home: string, runtime: RecordableRuntime, original: string | null): RuntimeHomeObservation {
  const runningProcess = "unverified" as const;
  // `notADirectoryIsAbsent`: a path under an entry that isn't a directory can't hold the record, so ENOTDIR reads absent.
  const look = (target: string, notADirectoryIsAbsent = false): "present" | "absent" | "unreadable" => {
    try { fs.statSync(target); return "present"; } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return code === "ENOENT" || (notADirectoryIsAbsent && code === "ENOTDIR") ? "absent" : "unreadable";
    }
  };
  let stat: fs.Stats;
  try { stat = fs.statSync(home); } catch (error) {
    return { home: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable", original: original ? "unknown" : "none", runningProcess };
  }
  if (!stat.isDirectory()) return { home: "not_a_directory", original: original ? "unknown" : "none", runningProcess };
  if (!original) return { home: "present", original: "none", runningProcess };
  try {
    if (runtime === "claude-code") {
      const projects = path.join(home, "projects");
      const top = look(projects);
      if (top !== "present") return { home: "present", original: top === "absent" ? "not_found" : "unknown", runningProcess };
      // Each entry is followed as stat follows it, so a linked project directory is read through its link.
      const seen = fs.readdirSync(projects).map(dir => look(path.join(projects, dir, `${original}.jsonl`), true));
      return { home: "present", original: seen.includes("present") ? "found" : seen.includes("unreadable") ? "unknown" : "not_found", runningProcess };
    }
    let budget = 50_000;
    const walk = (dir: string, depth: number): boolean | null => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (--budget < 0) return null;
        if (entry.isDirectory() && depth < 3) {
          const inner = walk(path.join(dir, entry.name), depth + 1);
          if (inner !== false) return inner;
        } else if (entry.isFile() && entry.name.endsWith(`${original}.jsonl`)) return true;
      }
      return false;
    };
    const sessions = path.join(home, "sessions");
    const top = look(sessions);
    if (top === "unreadable") return { home: "present", original: "unknown", runningProcess };
    const found = top === "present" ? walk(sessions, 0) : false;
    return { home: "present", original: found === null ? "unknown" : found ? "found" : "not_found", runningProcess };
  } catch {
    return { home: "present", original: "unknown", runningProcess };
  }
}

/** Write a home into the slot that decides the seat's home today (see RuntimeHomeSlot). Null, writing nothing, when the
 *  member's stored env can't be read. */
function writeHomeSlot(db: Database.Database, nodeId: string, runtime: RecordableRuntime, home: string): RuntimeHomeSlot | null {
  if (seatAccountHome(db, nodeId, runtime)) {
    db.prepare("UPDATE nodes SET account_home = ? WHERE id = ?").run(home, nodeId);
    return "account_home";
  }
  // Only this variable changes; every other entry of the member's env keeps its value.
  const row = db.prepare("SELECT env_json FROM nodes WHERE id = ?").get(nodeId) as { env_json: string | null };
  let env: unknown = {};
  if (row.env_json) { try { env = JSON.parse(row.env_json); } catch { env = null; } }
  if (!env || typeof env !== "object" || Array.isArray(env)) return null;
  db.prepare("UPDATE nodes SET env_json = ? WHERE id = ?").run(JSON.stringify({ ...env, [RUNTIME_HOME_VAR[runtime]]: home }), nodeId);
  return "member_env";
}

export interface RecordRuntimeHomeInput {
  node: { id: string; runtime: string | null };
  seat: { rigId: string; logicalId: string };
  home: unknown;
  /** The occupant generation, original conversation and revision the operator read; any of them stale means not applied. */
  expectedOccupant: unknown;
  expectedOriginal: unknown;
  expectedRevision: unknown;
  operationId: unknown;
  reason: string;
  operator: string | null;
}

export type RecordRuntimeHomeResult =
  | { ok: true; runtime: RecordableRuntime; variable: string; from: { home: string | null; source: string }; to: string;
      slot: RuntimeHomeSlot; revision: number; operationId: string; original: string | null; occupantGeneration: string | null;
      changed: boolean; replayed: boolean; effect: "next_launch"; observation: RuntimeHomeObservation }
  | { ok: false; code: string; message: string; applied: false; current?: { occupantGeneration: string | null; original: string | null;
      revision: number; home: string | null; source: string } };

const OPERATION_ID_RE = /^[A-Za-z0-9._:-]{8,128}$/;
const refused = (code: string, message: string) => ({ ok: false as const, code, message, applied: false as const });

/** Record an operator-selected runtime home for an existing seat's next launch, against the occupant, original
 *  conversation and revision the operator read. It writes only that home and an audit row and event: no process, pane,
 *  login, credential, conversation token, model, effort or cwd changes, and nothing is launched. A retry with the same
 *  operation id returns what was recorded; a stale expectation is a conflict and nothing is applied. */
export function recordRuntimeHome(deps: { db: Database.Database; sessions: SessionRegistry; eventBus: EventBus },
  input: RecordRuntimeHomeInput): RecordRuntimeHomeResult {
  const { db } = deps;
  const runtime = input.node.runtime;
  if (typeof input.home !== "string" || !input.home.trim()) return refused("missing_home", "An absolute runtime home is required (--home).");
  if (!path.isAbsolute(input.home) || /[\0\r\n]/.test(input.home)) {
    return refused("invalid_home", "The runtime home must be an absolute path on the daemon's host.");
  }
  const home = path.normalize(input.home);
  const nullable = (value: unknown) => value === null || (typeof value === "string" && value.length > 0);
  if (!nullable(input.expectedOccupant) || !nullable(input.expectedOriginal)
    || typeof input.expectedRevision !== "number" || !Number.isInteger(input.expectedRevision) || input.expectedRevision < 0) {
    return refused("missing_expectation", "State the occupant generation, original conversation and revision you read (null for none); read them with rig seat runtime-home.");
  }
  if (typeof input.operationId !== "string" || !OPERATION_ID_RE.test(input.operationId)) {
    return refused("invalid_operation_id", "An operation id of 8 to 128 letters, digits, '.', '_', ':' or '-' is required, so a retry is safe.");
  }
  if (!hasRecords(db)) return refused("runtime_home_unavailable", "This daemon's database has no place for a recorded runtime home yet; nothing was saved.");
  const operationId = input.operationId;
  const expected = { occupant: input.expectedOccupant as string | null, original: input.expectedOriginal as string | null,
    revision: input.expectedRevision };
  const hashFor = (recordedRuntime: string | null) =>
    createHash("sha256").update(JSON.stringify({ nodeId: input.node.id, runtime: recordedRuntime, home, ...expected })).digest("hex");
  type Applied = Omit<Extract<RecordRuntimeHomeResult, { ok: true }>, "observation">;
  // A completed operation answers first, under the runtime it was recorded for: the same request retried after the seat's
  // runtime changed returns what was recorded, not a conflict or a refusal. A different request is still a conflict.
  const replay = (prior: RecordRow): Applied | Extract<RecordRuntimeHomeResult, { ok: false }> => {
    if (prior.request_hash !== hashFor(prior.runtime)) {
      return refused("operation_conflict", "This operation id was already used for a different recording; nothing was applied. Use a new id.");
    }
    const recorded = prior.runtime as RecordableRuntime;
    return { ok: true, runtime: recorded, variable: RUNTIME_HOME_VAR[recorded], from: { home: prior.previous_home, source: prior.previous_source },
      to: prior.home, slot: prior.slot, revision: prior.revision, operationId, original: prior.original,
      occupantGeneration: prior.occupant_generation, changed: prior.previous_home !== prior.home, replayed: true, effect: "next_launch" };
  };
  const observed = (outcome: Applied | Extract<RecordRuntimeHomeResult, { ok: false }>): RecordRuntimeHomeResult =>
    outcome.ok ? { ...outcome, observation: observeRuntimeHome(outcome.to, outcome.runtime, outcome.original) } : outcome;
  const stored = db.prepare("SELECT * FROM seat_runtime_home_records WHERE operation_id = ?").get(operationId) as RecordRow | undefined;
  if (stored) return observed(replay(stored));
  if (!runtime || !(RECORDABLE_HOME_RUNTIMES as readonly string[]).includes(runtime)) {
    return refused("runtime_home_unsupported", `A runtime home can be recorded for Claude Code and Codex seats; this seat runs ${runtime ?? "no runtime"}.`);
  }
  const recordable = runtime as RecordableRuntime;
  const requestHash = hashFor(runtime);

  let persisted = null as ReturnType<EventBus["persistWithinTransaction"]> | null;
  const outcome = db.transaction((): Applied | Extract<RecordRuntimeHomeResult, { ok: false }> => {
    // The same id written meanwhile, by another request on this daemon.
    const prior = db.prepare("SELECT * FROM seat_runtime_home_records WHERE operation_id = ?").get(operationId) as RecordRow | undefined;
    if (prior) return replay(prior);
    const current = readRuntimeHomeState(db, deps.sessions, input.node.id, recordable);
    if (current.occupantGeneration !== expected.occupant || current.original !== expected.original || current.revision !== expected.revision) {
      return { ...refused("runtime_home_conflict",
        `The seat's occupant, original conversation or recorded revision isn't the one you read, so nothing was applied. Now: occupant ${current.occupantGeneration ?? "none"}, original ${current.original ?? "none"}, revision ${current.revision}. Decide for the current one.`),
        current: { occupantGeneration: current.occupantGeneration, original: current.original, revision: current.revision,
          home: current.home, source: current.source } };
    }
    const variable = RUNTIME_HOME_VAR[recordable];
    const slot = writeHomeSlot(db, input.node.id, recordable, home);
    if (!slot) return refused("member_env_unreadable", "The seat's stored env can't be read, so it wasn't rewritten; nothing was applied.");
    const revision = current.revision + 1;
    db.prepare(`INSERT INTO seat_runtime_home_records (operation_id, node_id, runtime, revision, home, slot, previous_home, previous_source,
      original, occupant_generation, request_hash, reason, operator, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(operationId, input.node.id, runtime, revision, home, slot, current.home, current.source, current.original,
        current.occupantGeneration, requestHash, input.reason, input.operator, new Date().toISOString());
    persisted = deps.eventBus.persistWithinTransaction({ type: "seat.runtime_home_recorded", rigId: input.seat.rigId, nodeId: input.node.id,
      logicalId: input.seat.logicalId, runtime, from: current.home, to: home, slot, revision, operationId, original: current.original,
      occupantGeneration: current.occupantGeneration, reason: input.reason, operator: input.operator });
    return { ok: true, runtime: recordable, variable, from: { home: current.home, source: current.source }, to: home, slot, revision,
      operationId, original: current.original, occupantGeneration: current.occupantGeneration, changed: current.home !== home,
      replayed: false, effect: "next_launch" };
  }).immediate();
  if (persisted) deps.eventBus.notifySubscribers(persisted);
  // Read after the write commits, outside its transaction.
  return observed(outcome);
}

/** Which runtime home a resume of a selected original conversation uses, so the home, original and revision stay one
 *  tuple through review and effect, and a record made for one conversation is never presented as another's. The seat's
 *  home is still a record's only when it's the same path from the same kind of slot the record wrote: a path that now
 *  comes from elsewhere (the rig's declaration after an account home was cleared, say) is another setting, even when it
 *  names the same directory.
 *  - as_recorded: the latest record was made for this original, and the seat's home is still that record's home;
 *  - apply: the seat's home is still the latest record's, which was made for another conversation, and one was made for
 *    this original. The newest of those is written back to the slot before the launch, as a new revision for this
 *    original, and put back only when the launch is known to have been rolled back or never to have run;
 *  - as_set: the seat's home as it's set, with no record revision for this original. Either nothing was recorded, or
 *    the home changed since the latest record (an account or runtime switch, say) and isn't reapplied over that change,
 *    or no record was made for this original (`otherConversation` then names the latest, another conversation's). */
export type SelectedHomePlan =
  | { kind: "as_recorded"; record: RuntimeHomeRecordRef }
  | { kind: "apply"; record: RuntimeHomeRecordRef; latest: RuntimeHomeRecordRef }
  | { kind: "as_set"; why: "nothing_recorded" | "home_changed_since_record" | "no_record_for_this_conversation";
      otherConversation?: RuntimeHomeRecordRef };

export function selectedHomePlan(db: Database.Database, nodeId: string, runtime: RecordableRuntime, selectedOriginal: string | null): SelectedHomePlan {
  const latest = latestRuntimeHomeRecord(db, nodeId);
  if (!latest) return { kind: "as_set", why: "nothing_recorded" };
  // The slot no longer holds the latest record's home: something else set it since, and that setting stands.
  const current = seatRuntimeHome(db, nodeId, runtime);
  const sameSlot = latest.slot === "account_home" ? current.source === "account-switch" : current.source === "member";
  if (current.home !== latest.home || !sameSlot) return { kind: "as_set", why: "home_changed_since_record" };
  if (selectedOriginal !== null && latest.original === selectedOriginal) return { kind: "as_recorded", record: latest };
  const own = selectedOriginal === null ? undefined
    : db.prepare("SELECT * FROM seat_runtime_home_records WHERE node_id = ? AND original = ? ORDER BY revision DESC LIMIT 1")
      .get(nodeId, selectedOriginal) as RecordRow | undefined;
  return own ? { kind: "apply", record: toRef(own), latest } : { kind: "as_set", why: "no_record_for_this_conversation", otherConversation: latest };
}

/** The plan's apply: write the selected original's recorded home back to the seat's slot, as a new revision recorded for
 *  that original, with its audit row and event, before the resume launches. The operation id is the review it was bound
 *  to, so a retry of the same apply writes nothing more. Null, writing nothing, when the records moved since the review
 *  or the member's env can't be read. */
export function applySelectedHome(deps: { db: Database.Database; sessions: SessionRegistry; eventBus: EventBus },
  input: { node: { id: string; runtime: RecordableRuntime }; seat: { rigId: string; logicalId: string }; plan: Extract<SelectedHomePlan, { kind: "apply" }>;
    original: string; operationId: string; operator: string | null }): RuntimeHomeRecordRef | null {
  const { db } = deps;
  if (!hasRecords(db)) return null;
  const { record, latest } = input.plan;
  const requestHash = createHash("sha256").update(JSON.stringify({ nodeId: input.node.id, runtime: input.node.runtime, home: record.home,
    original: input.original, from: latest.revision })).digest("hex");
  let persisted = null as ReturnType<EventBus["persistWithinTransaction"]> | null;
  const applied = db.transaction((): RuntimeHomeRecordRef | null => {
    const prior = db.prepare("SELECT * FROM seat_runtime_home_records WHERE operation_id = ?").get(input.operationId) as RecordRow | undefined;
    if (prior) return prior.request_hash === requestHash ? toRef(prior) : null;
    const current = readRuntimeHomeState(db, deps.sessions, input.node.id, input.node.runtime);
    if (current.revision !== latest.revision) return null;
    const slot = writeHomeSlot(db, input.node.id, input.node.runtime, record.home);
    if (!slot) return null;
    const revision = current.revision + 1;
    const reason = `resume of the selected conversation, with the home recorded for it at revision ${record.revision}`;
    const createdAt = new Date().toISOString();
    db.prepare(`INSERT INTO seat_runtime_home_records (operation_id, node_id, runtime, revision, home, slot, previous_home, previous_source,
      original, occupant_generation, request_hash, reason, operator, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(input.operationId, input.node.id, input.node.runtime, revision, record.home, slot, current.home, current.source, input.original,
        current.occupantGeneration, requestHash, reason, input.operator, createdAt);
    persisted = deps.eventBus.persistWithinTransaction({ type: "seat.runtime_home_recorded", rigId: input.seat.rigId, nodeId: input.node.id,
      logicalId: input.seat.logicalId, runtime: input.node.runtime, from: current.home, to: record.home, slot, revision,
      operationId: input.operationId, original: input.original, occupantGeneration: current.occupantGeneration, reason, operator: input.operator });
    return { revision, home: record.home, slot, original: input.original, occupantGeneration: current.occupantGeneration,
      operationId: input.operationId, recordedAt: createdAt };
  }).immediate();
  if (persisted) deps.eventBus.notifySubscribers(persisted);
  return applied;
}

/** After a selected launch that was rolled back, or never launched, with the seat's conversation the one it had before,
 *  put the slot back to the home the apply replaced, as a new revision recorded for the seat's current conversation, so its next launch
 *  doesn't run it under the selected one's home. That home was the seat's own (an earlier record wrote it), so it goes
 *  back to the same slot. CAS on the applied revision: a record made since is left alone. Null when nothing was put back. */
export function revertSelectedHome(deps: { db: Database.Database; sessions: SessionRegistry; eventBus: EventBus },
  input: { node: { id: string; runtime: RecordableRuntime }; seat: { rigId: string; logicalId: string }; applied: RuntimeHomeRecordRef;
    operator: string | null }): RuntimeHomeRecordRef | null {
  const { db } = deps;
  const operationId = `${input.applied.operationId}-put-back`;
  let persisted = null as ReturnType<EventBus["persistWithinTransaction"]> | null;
  const restored = db.transaction((): RuntimeHomeRecordRef | null => {
    const prior = db.prepare("SELECT * FROM seat_runtime_home_records WHERE operation_id = ?").get(operationId) as RecordRow | undefined;
    if (prior) return toRef(prior);
    const applied = db.prepare("SELECT * FROM seat_runtime_home_records WHERE operation_id = ?").get(input.applied.operationId) as RecordRow | undefined;
    if (!applied?.previous_home || (applied.previous_source !== "member" && applied.previous_source !== "account-switch")) return null;
    const current = readRuntimeHomeState(db, deps.sessions, input.node.id, input.node.runtime);
    if (current.revision !== applied.revision) return null;
    const slot = writeHomeSlot(db, input.node.id, input.node.runtime, applied.previous_home);
    if (!slot) return null;
    const revision = current.revision + 1;
    const reason = `put back after the selected launch at revision ${applied.revision} was rolled back or didn't run`;
    const createdAt = new Date().toISOString();
    db.prepare(`INSERT INTO seat_runtime_home_records (operation_id, node_id, runtime, revision, home, slot, previous_home, previous_source,
      original, occupant_generation, request_hash, reason, operator, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(operationId, input.node.id, input.node.runtime, revision, applied.previous_home, slot, current.home, current.source, current.original,
        current.occupantGeneration, `put-back:${applied.operation_id}`, reason, input.operator, createdAt);
    persisted = deps.eventBus.persistWithinTransaction({ type: "seat.runtime_home_recorded", rigId: input.seat.rigId, nodeId: input.node.id,
      logicalId: input.seat.logicalId, runtime: input.node.runtime, from: current.home, to: applied.previous_home, slot, revision, operationId,
      original: current.original, occupantGeneration: current.occupantGeneration, reason, operator: input.operator });
    return { revision, home: applied.previous_home, slot, original: current.original, occupantGeneration: current.occupantGeneration,
      operationId, recordedAt: createdAt };
  }).immediate();
  if (persisted) deps.eventBus.notifySubscribers(persisted);
  return restored;
}
