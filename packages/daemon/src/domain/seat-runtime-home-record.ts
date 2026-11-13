import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import type { EventBus } from "./event-bus.js";
import type { SessionRegistry } from "./session-registry.js";
import { RUNTIME_HOME_VAR, seatAccountHome, seatRuntimeHome, type HomeRuntime } from "./seat-runtime-home.js";

/** The runtimes whose home an operator can record: a Pi seat keeps its managed login, so it isn't one of them. */
export const RECORDABLE_HOME_RUNTIMES = ["claude-code", "codex"] as const;
type RecordableRuntime = typeof RECORDABLE_HOME_RUNTIMES[number];

/** Where a recorded home is stored: in the slot that decides the seat's home today, so its credential handling stays
 *  as it is. A seat on an account switch's home (`account_home`, whose launch unsets provider credentials) keeps that
 *  class with a new path; any other seat gets its member `env:` value, which launch, restore and status already read
 *  and which unsets nothing. A recording never moves a seat into or out of the account-switch class. */
export type RuntimeHomeSlot = "account_home" | "member_env";

export interface RuntimeHomeRecordRef {
  revision: number;
  home: string;
  slot: RuntimeHomeSlot;
  /** The original conversation (native session or thread id) it was recorded against; null when the seat had none. */
  original: string | null;
  occupantGeneration: string | null;
  operationId: string;
  recordedAt: string;
}

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

/** The seat's original conversation: the native id its newest session row carries, else none. */
function currentOriginal(db: Database.Database, nodeId: string): string | null {
  const row = db.prepare("SELECT resume_token FROM sessions WHERE node_id = ? ORDER BY id DESC LIMIT 1").get(nodeId) as
    { resume_token: string | null } | undefined;
  return row?.resume_token ?? null;
}

export function readRuntimeHomeState(db: Database.Database, sessions: SessionRegistry, nodeId: string, runtime: RecordableRuntime,
  daemonEnv: NodeJS.ProcessEnv = process.env): RuntimeHomeState {
  const variable = RUNTIME_HOME_VAR[runtime];
  const own = seatRuntimeHome(db, nodeId, runtime);
  const daemonHome = daemonEnv[variable];
  const record = latestRuntimeHomeRecord(db, nodeId);
  return { runtime, variable,
    home: own.home ?? daemonHome ?? null,
    source: own.source ?? (daemonHome ? "daemon_environment" : "native_default"),
    ...(own.ignored ? { ignored: own.ignored } : {}),
    occupantGeneration: sessions.currentOccupantTenure(nodeId)?.generationUuid ?? null,
    original: currentOriginal(db, nodeId),
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

/** Look for the original's record in a home, bounded: Codex keeps `sessions/YYYY/MM/DD/rollout-…-<id>.jsonl`, Claude
 *  keeps `projects/<project>/<id>.jsonl`. */
export function observeRuntimeHome(home: string, runtime: RecordableRuntime, original: string | null): RuntimeHomeObservation {
  const runningProcess = "unverified" as const;
  let stat: fs.Stats;
  try { stat = fs.statSync(home); } catch (error) {
    return { home: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable", original: original ? "unknown" : "none", runningProcess };
  }
  if (!stat.isDirectory()) return { home: "not_a_directory", original: original ? "unknown" : "none", runningProcess };
  if (!original) return { home: "present", original: "none", runningProcess };
  try {
    if (runtime === "claude-code") {
      const projects = path.join(home, "projects");
      if (!fs.existsSync(projects)) return { home: "present", original: "not_found", runningProcess };
      const found = fs.readdirSync(projects).some(dir => fs.existsSync(path.join(projects, dir, `${original}.jsonl`)));
      return { home: "present", original: found ? "found" : "not_found", runningProcess };
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
    const found = fs.existsSync(sessions) ? walk(sessions, 0) : false;
    return { home: "present", original: found === null ? "unknown" : found ? "found" : "not_found", runningProcess };
  } catch {
    return { home: "present", original: "unknown", runningProcess };
  }
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
  if (!runtime || !(RECORDABLE_HOME_RUNTIMES as readonly string[]).includes(runtime)) {
    return refused("runtime_home_unsupported", `A runtime home can be recorded for Claude Code and Codex seats; this seat runs ${runtime ?? "no runtime"}.`);
  }
  const recordable = runtime as RecordableRuntime;
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
  const requestHash = createHash("sha256").update(JSON.stringify({ nodeId: input.node.id, runtime, home, ...expected })).digest("hex");

  type Applied = Omit<Extract<RecordRuntimeHomeResult, { ok: true }>, "observation">;
  let persisted = null as ReturnType<EventBus["persistWithinTransaction"]> | null;
  const outcome = db.transaction((): Applied | Extract<RecordRuntimeHomeResult, { ok: false }> => {
    const prior = db.prepare("SELECT * FROM seat_runtime_home_records WHERE operation_id = ?").get(operationId) as RecordRow | undefined;
    if (prior) {
      if (prior.request_hash !== requestHash) {
        return refused("operation_conflict", "This operation id was already used for a different recording; nothing was applied. Use a new id.");
      }
      return { ok: true, runtime: recordable, variable: RUNTIME_HOME_VAR[recordable], from: { home: prior.previous_home, source: prior.previous_source },
        to: prior.home, slot: prior.slot, revision: prior.revision, operationId, original: prior.original,
        occupantGeneration: prior.occupant_generation, changed: prior.previous_home !== prior.home, replayed: true, effect: "next_launch" };
    }
    const current = readRuntimeHomeState(db, deps.sessions, input.node.id, recordable);
    if (current.occupantGeneration !== expected.occupant || current.original !== expected.original || current.revision !== expected.revision) {
      return { ...refused("runtime_home_conflict",
        `The seat's occupant, original conversation or recorded revision isn't the one you read, so nothing was applied. Now: occupant ${current.occupantGeneration ?? "none"}, original ${current.original ?? "none"}, revision ${current.revision}. Decide for the current one.`),
        current: { occupantGeneration: current.occupantGeneration, original: current.original, revision: current.revision,
          home: current.home, source: current.source } };
    }
    const variable = RUNTIME_HOME_VAR[recordable];
    const slot: RuntimeHomeSlot = seatAccountHome(db, input.node.id, recordable) ? "account_home" : "member_env";
    if (slot === "account_home") {
      db.prepare("UPDATE nodes SET account_home = ? WHERE id = ?").run(home, input.node.id);
    } else {
      // Only this variable changes; every other entry of the member's env is kept exactly as stored.
      const row = db.prepare("SELECT env_json FROM nodes WHERE id = ?").get(input.node.id) as { env_json: string | null };
      let env: unknown = {};
      if (row.env_json) { try { env = JSON.parse(row.env_json); } catch { env = null; } }
      if (!env || typeof env !== "object" || Array.isArray(env)) {
        return refused("member_env_unreadable", "The seat's stored env can't be read, so it wasn't rewritten; nothing was applied.");
      }
      db.prepare("UPDATE nodes SET env_json = ? WHERE id = ?").run(JSON.stringify({ ...env, [variable]: home }), input.node.id);
    }
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
  return outcome.ok ? { ...outcome, observation: observeRuntimeHome(outcome.to, recordable, outcome.original) } : outcome;
}
