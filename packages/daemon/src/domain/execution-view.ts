// S27 (OPR.0.5.6.27) — the execution view: one JSON document answering the six
// execution questions (who-where, sequencing, care-dial, done-ness-by-rung, park
// honesty, parallelism health), EVERY field derived at read time.
//
// The laws this module obeys (design contract, DESIGN-execution-view-data-contract):
// - DERIVED, NEVER AUTHORED: no field is copied from a label a human wrote about
//   state; volatile facts come from the DB, slice frontmatter, git, statfs, and
//   the daemon's own build stamp — at read time, per call. No cache, no scheduler.
// - INDETERMINATE FLOOR: an unreachable or unconfigured source renders the string
//   "INDETERMINATE" (with a named basis), never idle/dead/done/false.
// - THE LADDER IS THE SCHEMA: done-ness is five named rungs
//   (locked/built/reviewed/folded/adopted); a single "done" boolean does not exist.
// - PROJECTION, NOT AUTHORITY: every cell carries the row/artifact/command that
//   makes it one command from source.
//
// Data conventions consumed (landed with this slice):
// - EC-1: slice frontmatter `depends_on:` + `SOFT-AFTER: [ids] — reason` line in
//   the Territory section (exact regex below — a designated machine line, not
//   prose scraping).
// - EC-2: the latest queue row tagged `format:wave-map-v1` carries a fenced
//   ```json block with {waves:[{id,slices,serialized_order?,review_model?}]}.
//   Dial: frontmatter `approved-spec-dial`.
// - EC-3: dispatch batons carry a body line `worktree_path=<path>`; rows without
//   it join by naming only and are marked fragile_join.

import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { parse as parseYaml } from "yaml";
import type Database from "better-sqlite3";
import { parseFrontmatter } from "./slices/slice-indexer.js";
import { derivePickup } from "./queue-pickup.js";
import { resolveWorkNodeDirs } from "./current-work.js";
import { resolveLegacyTopologyRigsRoot } from "./user-settings/settings-store.js";
import { BUILD_INFO, type BuildInfo } from "../build-info.js";
import { validateMissionComposition } from "./lifecycle-manifest.js";

export const INDETERMINATE = "INDETERMINATE" as const;
export type Indeterminate = typeof INDETERMINATE;

export interface ExecutionViewDeps {
  db: Database.Database;
  /** The missions root (workspace.slices_root). Null => fs-derived sections floor
   *  to INDETERMINATE; the queue-derived sections still answer. */
  slicesRoot: () => string | null;
  /** THE one activity oracle (S19 locked contract): SeatActivityService's
   *  ARBITRATED seat-keyed read — the same source rig ps, node inventory, and
   *  parked-query consume. The vocabulary (working | idle-at-prompt | unknown)
   *  and the separate needsInput {count, reason} pass through UNTRANSLATED —
   *  this module never re-arbitrates. sessions.status and the parallel
   *  AgentActivityStore ingest are NOT acceptable stand-ins (live specimen:
   *  working lanes labeled `superseded`). Absent => INDETERMINATE floors. */
  seatActivity?: {
    getSeatStateBySession(sessionName: string): {
      activity: "working" | "idle-at-prompt" | "unknown";
      needsInput: { count: number; reason: string | null };
      decidedBy: string | null;
      changedAt: string;
    } | null;
  };
  now?: () => Date;
  buildInfo?: BuildInfo;
  /** Injectable for tests. Same signature subset as node's execFileSync. */
  exec?: (cmd: string, args: string[]) => string;
  /** Injectable rigs root for review-artifact scanning (tests). */
  rigsRoot?: () => string;
}

interface QueueRowLite {
  qitem_id: string;
  source_session: string;
  destination_session: string;
  state: string;
  tags: string | null;
  body: string | null;
  claimed_at: string | null;
  last_heartbeat: string | null;
  blocked_on: string | null;
  ts_created: string;
  ts_updated: string;
  post_claim_motion?: number;
}

function defaultExec(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function parseTags(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return raw.split(",").map((s) => s.trim()).filter(Boolean);
  }
}

/** EC-3 — the designated machine line, exact. */
const WORKTREE_LINE = /^worktree_path=(\S+)$/m;
/** EC-1 — the designated soft-edge machine line, exact. */
const SOFT_AFTER_LINE = /^SOFT-AFTER:\s*\[([^\]]*)\]/m;
/** EC-2 — the fenced JSON block in a wave-map row body. */
const WAVE_MAP_BLOCK = /```json\s*\n([\s\S]*?)\n```/;

/** Frontmatter values arrive as raw strings from parseFrontmatter; EC-1 writes
 *  inline JSON arrays (`depends_on: ["OPR..."]`), so parse that shape here. */
function parseArrayField(v: unknown): string[] | Indeterminate {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string" && v.trim().startsWith("[")) {
    try {
      const parsed = JSON.parse(v.trim());
      return Array.isArray(parsed) ? parsed.map(String) : INDETERMINATE;
    } catch {
      return INDETERMINATE;
    }
  }
  return INDETERMINATE;
}

const SLICE_TAG = /^slice:(.+)$/;
const CANDIDATE_TAG = /^candidate:(.+)$/;

/** Candidate identity is a COMMIT, not a string. Production carries mixed forms —
 *  abbreviated tags (`dced9edb0`), full 40-hex artifact fields, and annotated
 *  fields (`dced9edb0 (exact tip over base …)`). Extract the leading hex token;
 *  anything without one is malformed and floors excluded, never matched. */
const SHA_TOKEN = /^([0-9a-fA-F]{7,40})(?:\b|$)/;
function extractShaToken(raw: string | null): string | null {
  if (!raw) return null;
  const m = raw.trim().match(SHA_TOKEN);
  return m?.[1] ? m[1].toLowerCase() : null;
}

/** Resolve a (possibly abbreviated) sha token to its full commit id via the repo
 *  context. Ambiguous or non-resolving tokens return null — raw prefix string
 *  equality is never accepted as commit identity. */
function resolveCommit(
  exec: (cmd: string, args: string[]) => string,
  repoCtx: string,
  token: string,
  cache: Map<string, string | null>,
): string | null {
  if (cache.has(token)) return cache.get(token) ?? null;
  let full: string | null = null;
  try {
    full = exec("git", ["-C", repoCtx, "rev-parse", "--verify", `${token}^{commit}`]).toLowerCase();
  } catch {
    full = null; // ambiguous, unknown, or malformed at the object store — floors honestly
  }
  cache.set(token, full);
  return full;
}

/** Numeric-aware compare of release-mission dir names (release-0.5.10 > release-0.5.6). */
function compareReleaseDirs(a: string, b: string): number {
  const nums = (s: string) => (s.match(/\d+/g) ?? []).map(Number);
  const na = nums(a);
  const nb = nums(b);
  for (let i = 0; i < Math.max(na.length, nb.length); i++) {
    const d = (na[i] ?? -1) - (nb[i] ?? -1);
    if (d !== 0) return d;
  }
  return a.localeCompare(b);
}

function missionReferences(missionsRoot: string | null, mission: string): string[] {
  const references = new Set([mission]);
  if (!missionsRoot) return [...references];
  try {
    const fm = parseFrontmatter(fs.readFileSync(path.join(missionsRoot, mission, "SPEC.md"), "utf8"));
    if (typeof fm["id"] === "string") references.add(fm["id"] as string);
  } catch {
    // A missing mission SPEC is valid legacy state; the directory name still binds.
  }
  return [...references];
}

interface SliceFacts {
  dir: string;
  specPath: string;
  id: string | Indeterminate;
  frontmatter: Record<string, unknown>;
  body: string;
}

function readMissionSlices(missionsRoot: string, mission: string): SliceFacts[] {
  const slicesDir = path.join(missionsRoot, mission, "slices");
  let entries: string[];
  try {
    entries = fs.readdirSync(slicesDir);
  } catch {
    return [];
  }
  const out: SliceFacts[] = [];
  for (const dir of entries.sort()) {
    const specPath = path.join(slicesDir, dir, "SPEC.md");
    let raw: string;
    try {
      raw = fs.readFileSync(specPath, "utf8");
    } catch {
      continue;
    }
    const fm = parseFrontmatter(raw);
    out.push({
      dir,
      specPath,
      id: typeof fm["id"] === "string" ? (fm["id"] as string) : INDETERMINATE,
      frontmatter: fm,
      body: raw.replace(/^---\n[\s\S]*?\n---\n?/, ""),
    });
  }
  return out;
}

/** Locate the slice facts for a dep id, resolving out-of-mission deps to their
 *  own release dir by id prefix (OPR.0.5.5.x -> release-0.5.5). */
function resolveDep(
  depId: string,
  current: SliceFacts[],
  missionsRoot: string | null,
  cache: Map<string, SliceFacts | null>,
): SliceFacts | null {
  const inMission = current.find((s) => s.id === depId);
  if (inMission) return inMission;
  if (cache.has(depId)) return cache.get(depId) ?? null;
  let found: SliceFacts | null = null;
  const m = depId.match(/^OPR\.(\d+\.\d+\.\d+)\.\d+$/);
  if (m && missionsRoot) {
    const releaseDir = `release-${m[1]}`;
    for (const s of readMissionSlices(missionsRoot, releaseDir)) {
      if (s.id === depId) {
        found = s;
        break;
      }
    }
  }
  cache.set(depId, found);
  return found;
}

interface WaveMapData {
  rowId: string | Indeterminate;
  waves: { id: string; slices: string[]; serialized_order?: string[]; review_model?: string }[];
}

interface ArrangementSlice {
  path: string;
  order: number;
  wave?: string;
  reviewModel?: string;
  dependsOn?: string[];
}

type ArrangementData =
  | { state: "missing"; missionPath: string }
  | { state: "malformed"; missionPath: string; warning: string }
  | {
      state: "valid";
      missionPath: string;
      byId: Map<string, ArrangementSlice>;
      byDir: Map<string, ArrangementSlice>;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function hasTable(db: Database.Database, table: string): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table));
}

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  if (!hasTable(db, table)) return false;
  return db.prepare(`PRAGMA table_info(${table})`).all().some((row) => (row as { name?: string }).name === column);
}

/**
 * S06 lifecycle projection for the existing execution view. Mutable owner,
 * queue state, and blocker facts are joined from queue_items at read time;
 * lifecycle_binding_json carries identity/provenance only. Older databases
 * have no migration-079 columns and therefore return an honest empty list.
 */
function readLifecycleExecutions(db: Database.Database, mission: string): Array<Record<string, unknown>> {
  if (!hasColumn(db, "workflow_instances", "lifecycle_binding_json")) return [];
  const rows = db.prepare(
    `SELECT wi.*, ws.spec_json
       FROM workflow_instances wi
       LEFT JOIN workflow_specs ws
         ON ws.name = wi.workflow_name AND ws.version = wi.workflow_version
      WHERE wi.lifecycle_binding_json IS NOT NULL
      ORDER BY wi.created_at, wi.instance_id`,
  ).all() as Array<Record<string, unknown>>;
  const hasBindings = hasTable(db, "workflow_frontier_bindings");
  const hasFailures = hasTable(db, "workflow_failure_occurrences");
  const output: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    const binding = parseJsonRecord(row["lifecycle_binding_json"]);
    const identity = isRecord(binding["identity"]) ? binding["identity"] as Record<string, unknown> : {};
    if (identity["mission"] !== mission) continue;
    const instanceId = String(row["instance_id"]);
    const frontier = parseJsonStringList(row["current_frontier_json"]);
    const specRoot = parseJsonRecord(row["spec_json"]);
    const steps = Array.isArray(specRoot["steps"])
      ? (specRoot["steps"] as unknown[]).filter(isRecord)
      : [];
    const unknowns: string[] = [];
    const packets = frontier.map((packetId) => {
      const matches = hasBindings
        ? db.prepare(`SELECT * FROM workflow_frontier_bindings WHERE instance_id = ? AND packet_id = ?`).all(instanceId, packetId) as Array<Record<string, unknown>>
        : [];
      const packet = db.prepare(
        `SELECT destination_session, state, blocked_on FROM queue_items WHERE qitem_id = ?`,
      ).get(packetId) as { destination_session?: string; state?: string; blocked_on?: string | null } | undefined;
      if (matches.length !== 1) unknowns.push(`frontier packet ${packetId} has ${matches.length} step bindings`);
      if (!packet) unknowns.push(`frontier packet ${packetId} has no queue row`);
      const stepId = matches.length === 1 ? String(matches[0]!["step_id"]) : null;
      const step = stepId ? steps.find((candidate) => candidate["id"] === stepId) : undefined;
      return {
        packet_id: packetId,
        step_id: stepId ?? INDETERMINATE,
        owner: packet?.destination_session ?? INDETERMINATE,
        queue_state: packet?.state ?? INDETERMINATE,
        blocked_on: packet?.blocked_on ?? null,
        depends_on: step && Array.isArray(step["depends_on"]) ? step["depends_on"] : [],
        gate: step && isRecord(step["gate"]) ? step["gate"] : null,
        acceptance: step && isRecord(step["acceptance"]) ? step["acceptance"] : null,
        targeted_action: matches.length === 1 && packet
          ? `rig workflow project --instance ${instanceId} --current-packet ${packetId} --exit <handoff|waiting|done|failed> --actor-session ${packet.destination_session}`
          : INDETERMINATE,
      };
    });
    const failures = hasFailures
      ? (db.prepare(
          `SELECT occurrence_id, step_id, failure_reason, status, redrive_packet_id, failed_at, resolved_at
             FROM workflow_failure_occurrences WHERE instance_id = ? ORDER BY failed_at, occurrence_id`,
        ).all(instanceId) as Array<Record<string, unknown>>).map((failure) => ({
          occurrence_id: failure["occurrence_id"],
          step_id: failure["step_id"],
          status: failure["status"],
          failure_reason: failure["failure_reason"],
          redrive_packet_id: failure["redrive_packet_id"],
          failed_at: failure["failed_at"],
          resolved_at: failure["resolved_at"],
          targeted_action:
            failure["status"] === "unresolved" &&
            row["status"] !== "completed" &&
            row["status"] !== "aborted"
            ? `rig workflow resume ${instanceId} --occurrence ${String(failure["occurrence_id"])} --actor-session <you>`
            : null,
        }))
      : [];
    output.push({
      instance_id: instanceId,
      status: row["status"],
      operation_key: row["lifecycle_operation_key"],
      compiled_input_digest: row["compiled_input_digest"],
      identity,
      sources: Array.isArray(binding["sources"]) ? binding["sources"] : [],
      dependencies: Array.isArray(binding["dependencies"]) ? binding["dependencies"] : [],
      frontier_packets: packets,
      failure_occurrences: failures,
      unknowns,
    });
  }
  return output;
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseJsonStringList(value: unknown): string[] {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : [];
  } catch {
    return [];
  }
}

/** The manifest arrangement is optional. Missing means compatibility fallback;
 * malformed means the same fallback plus ONE named warning cell in `sources`.
 * A valid manifest becomes the ordering/wave/dependency authority. */
function readArrangement(missionsRoot: string, mission: string, slices: SliceFacts[]): ArrangementData {
  const missionRoot = path.join(missionsRoot, mission);
  const missionPath = path.join(missionRoot, "mission.yaml");
  if (!fs.existsSync(missionPath)) return { state: "missing", missionPath };
  try {
    const manifest = parseYaml(fs.readFileSync(missionPath, "utf8")) as unknown;
    if (!isRecord(manifest)) throw new Error("root is not a mapping");
    const compositionMembers = validateMissionComposition(manifest, missionPath);
    const waveReview = new Map<string, string>();
    const waveBySlice = new Map<string, string>();
    const arrangement = manifest["arrangement"];
    if (isRecord(arrangement) && arrangement["waves"] != null) {
      if (!Array.isArray(arrangement["waves"])) throw new Error("arrangement.waves is not a list");
      for (const rawWave of arrangement["waves"]) {
        if (!isRecord(rawWave) || typeof rawWave["id"] !== "string") {
          throw new Error("arrangement.waves contains an invalid entry");
        }
        let waveSlices: unknown[];
        if (Array.isArray(rawWave["slices"])) {
          waveSlices = rawWave["slices"];
        } else if (isRecord(rawWave["lanes"])) {
          const lanes = Object.values(rawWave["lanes"]);
          if (lanes.some((value) => !Array.isArray(value))) throw new Error("arrangement.waves lanes are not lists");
          waveSlices = lanes.flatMap((value) => value as unknown[]);
        } else {
          throw new Error("arrangement.waves entry has neither slices nor lanes");
        }
        if (waveSlices.some((value) => typeof value !== "string")) {
          throw new Error("arrangement.waves contains a non-string slice id");
        }
        for (const sliceId of waveSlices as string[]) waveBySlice.set(sliceId, rawWave["id"]);
        if (typeof rawWave["review_model"] === "string") waveReview.set(rawWave["id"], rawWave["review_model"]);
      }
    }
    const byId = new Map<string, ArrangementSlice>();
    const byDir = new Map<string, ArrangementSlice>();
    for (const member of compositionMembers) {
      if (!member.active) continue;
      const ref = member.ref;
      const resolved = member.path;
      if (path.basename(resolved) !== "slice.yaml") throw new Error(`slice ref must address slice.yaml: ${ref}`);
      const relative = path.relative(fs.realpathSync(path.join(missionRoot, "slices")), resolved);
      const dir = relative.split(path.sep)[0];
      if (!dir || dir === "..") throw new Error(`slice ref is outside slices/: ${ref}`);
      const sliceManifest = parseYaml(fs.readFileSync(resolved, "utf8")) as unknown;
      if (!isRecord(sliceManifest)) throw new Error(`${ref} root is not a mapping`);
      const execution = sliceManifest["execution"];
      if (execution != null && !isRecord(execution)) throw new Error(`${ref} execution is not a mapping`);
      const dependsRaw = isRecord(execution) ? execution["depends_on"] : undefined;
      if (dependsRaw != null && (!Array.isArray(dependsRaw) || dependsRaw.some((v) => typeof v !== "string"))) {
        throw new Error(`${ref} execution.depends_on is not a string list`);
      }
      const facts = slices.find((slice) => slice.dir === dir);
      const wave = isRecord(execution) && typeof execution["wave"] === "string"
        ? execution["wave"]
        : facts && facts.id !== INDETERMINATE
          ? waveBySlice.get(facts.id)
          : undefined;
      const entry: ArrangementSlice = {
        path: resolved,
        order: member.order,
        ...(wave ? { wave } : {}),
        ...(wave && waveReview.has(wave) ? { reviewModel: waveReview.get(wave)! } : {}),
        ...(dependsRaw ? { dependsOn: dependsRaw as string[] } : {}),
      };
      byDir.set(dir, entry);
      if (facts && facts.id !== INDETERMINATE) byId.set(facts.id, entry);
    }
    return { state: "valid", missionPath, byId, byDir };
  } catch (err) {
    return {
      state: "malformed",
      missionPath,
      warning: err instanceof Error ? err.message : String(err),
    };
  }
}

function readWaveMap(db: Database.Database, missions: string[]): WaveMapData {
  const missionWhere = missions.map(() => "tags LIKE ?").join(" OR ");
  const row = db
    .prepare(
      `SELECT qitem_id, body FROM queue_items
        WHERE tags LIKE '%format:wave-map-v1%' AND (${missionWhere})
        ORDER BY ts_created DESC LIMIT 1`,
    )
    .get(...missions.map((mission) => `%mission:${mission}%`)) as { qitem_id: string; body: string | null } | undefined;
  if (!row?.body) return { rowId: INDETERMINATE, waves: [] };
  const block = row.body.match(WAVE_MAP_BLOCK);
  if (!block) return { rowId: INDETERMINATE, waves: [] };
  try {
    const parsed = JSON.parse(block[1] ?? "");
    if (parsed?.format !== "wave-map-v1" || !Array.isArray(parsed.waves)) {
      return { rowId: INDETERMINATE, waves: [] };
    }
    return { rowId: row.qitem_id, waves: parsed.waves };
  } catch {
    return { rowId: INDETERMINATE, waves: [] };
  }
}

interface ReviewArtifactFact {
  path: string;
  verdict: string;
  candidateSha: string | null;
  artifactType: string | null;
}

/** Scan rigs/<rig>/state/review… dirs for review artifacts naming this slice.
 *  Root resolution follows the shipped shared-docs precedent. */
function scanReviewArtifacts(rigsRoot: string, sliceDirOrId: string[]): ReviewArtifactFact[] | Indeterminate {
  let rigs: string[];
  try {
    rigs = fs.readdirSync(rigsRoot);
  } catch {
    return INDETERMINATE;
  }
  const out: ReviewArtifactFact[] = [];
  for (const rig of rigs) {
    const stateDir = path.join(rigsRoot, rig, "state");
    let stateEntries: string[];
    try {
      stateEntries = fs.readdirSync(stateDir);
    } catch {
      continue;
    }
    for (const entry of stateEntries.filter((e) => e.startsWith("review"))) {
      const dir = path.join(stateDir, entry);
      let files: string[];
      try {
        files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
      } catch {
        continue;
      }
      for (const f of files) {
        let raw: string;
        try {
          raw = fs.readFileSync(path.join(dir, f), "utf8");
        } catch {
          continue;
        }
        const fm = parseFrontmatter(raw);
        const sliceVal = typeof fm["slice"] === "string" ? (fm["slice"] as string) : null;
        if (!sliceVal || !sliceDirOrId.includes(sliceVal)) continue;
        out.push({
          path: path.join(dir, f),
          verdict: typeof fm["verdict"] === "string" ? (fm["verdict"] as string) : INDETERMINATE,
          candidateSha: typeof fm["candidate_sha"] === "string" ? (fm["candidate_sha"] as string) : null,
          artifactType: typeof fm["artifact_type"] === "string" ? (fm["artifact_type"] as string) : null,
        });
      }
    }
  }
  return out;
}

type Rung =
  | { value: boolean; basis: string }
  | { value: Indeterminate; basis: string };

function gitAncestor(exec: ExecutionViewDeps["exec"], repoCtx: string, sha: string, ref: string): Rung {
  const run = exec ?? defaultExec;
  try {
    run("git", ["-C", repoCtx, "merge-base", "--is-ancestor", sha, ref]);
    return { value: true, basis: `git -C ${repoCtx} merge-base --is-ancestor ${sha} ${ref} (exit 0)` };
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 1) {
      return { value: false, basis: `git -C ${repoCtx} merge-base --is-ancestor ${sha} ${ref} (exit 1)` };
    }
    return { value: INDETERMINATE, basis: `merge-base failed in ${repoCtx}: ${(err as Error).message?.slice(0, 120)}` };
  }
}

export function buildExecutionView(deps: ExecutionViewDeps, opts?: { mission?: string; rig?: string }): Record<string, unknown> {
  const now = deps.now ?? (() => new Date());
  const exec = deps.exec ?? defaultExec;
  const buildInfo = deps.buildInfo ?? BUILD_INFO;
  const derivedAt = now().toISOString();
  const asof = () => now().toISOString();

  const missionsRoot = deps.slicesRoot();

  // Default mission: the newest real in-progress mission on the board. The TUI
  // asks without a mission before it has any mission state of its own; choosing
  // the lexically newest directory can surface a planned future release instead
  // of the mission people are actually executing. Explicit `?mission=` still
  // wins, and the historical newest-directory behavior remains the fallback.
  let mission: string | Indeterminate = opts?.mission ?? INDETERMINATE;
  if (mission !== INDETERMINATE && missionsRoot) {
    const matches = resolveWorkNodeDirs(missionsRoot, mission);
    if (matches.length === 1) mission = matches[0]!.dir;
  }
  if (mission === INDETERMINATE && missionsRoot) {
    const active = deps.db
      .prepare(`SELECT tags, body FROM queue_items WHERE state = 'in-progress' ORDER BY ts_updated DESC`)
      .all() as Array<{ tags: string | null; body: string | null }>;
    for (const row of active) {
      const tag = parseTags(row.tags).find((value) => value.startsWith("mission:"));
      // Canonical tags win; the conventional handoff line keeps older/body-only batons visible.
      const bodyMissions = [...new Set(
        [...(row.body?.matchAll(/^Mission:[ \t]+(\S+)[ \t]*$/gm) ?? [])].map((match) => match[1]!),
      )];
      const candidate = tag?.slice("mission:".length) ?? (bodyMissions.length === 1 ? bodyMissions[0] : undefined);
      const matches = candidate ? resolveWorkNodeDirs(missionsRoot, candidate) : [];
      if (matches.length === 1) {
        mission = matches[0]!.dir;
        break;
      }
    }
  }
  if (mission === INDETERMINATE && missionsRoot) {
    try {
      const releases = fs.readdirSync(missionsRoot).filter((d) => /^release-\d/.test(d));
      const newest = releases.sort(compareReleaseDirs)[releases.length - 1];
      if (newest) mission = newest;
    } catch {
      /* stays INDETERMINATE */
    }
  }

  const slices = missionsRoot && mission !== INDETERMINATE ? readMissionSlices(missionsRoot, mission) : [];
  const sliceIds = slices.map((s) => s.id).filter((x): x is string => x !== INDETERMINATE);
  const depCache = new Map<string, SliceFacts | null>();

  // ---- queue rows bound to this mission (tag or body mention, per the binding law) ----
  const missionLikes = mission === INDETERMINATE
    ? ["%"]
    : missionReferences(missionsRoot, mission).map((reference) => `%${reference}%`);
  const missionWhere = missionLikes.map(() => "(tags LIKE ? OR body LIKE ?)").join(" OR ");
  const rows = deps.db
    .prepare(
      `SELECT qitem_id, source_session, destination_session, state, tags, body, claimed_at,
              last_heartbeat, blocked_on, ts_created, ts_updated,
              (SELECT COUNT(*) FROM queue_transitions t
                 WHERE t.qitem_id = queue_items.qitem_id
                   AND t.ts > queue_items.claimed_at
                   AND t.transition_note IS NOT 'claimed') AS post_claim_motion
         FROM queue_items
        WHERE (${missionWhere})`,
    )
    .all(...missionLikes.flatMap((like) => [like, like])) as QueueRowLite[];

  const sliceOfRow = (r: QueueRowLite): string | null => {
    for (const t of parseTags(r.tags)) {
      const m = t.match(SLICE_TAG);
      if (m?.[1]) return m[1];
    }
    const bodySlices = [...new Set(
      [...(r.body?.matchAll(/^Slice:[ \t]+(\S+)[ \t]*$/gm) ?? [])].map((match) => match[1]!),
    )];
    return bodySlices.length === 1 ? bodySlices[0]! : null;
  };

  // ---- Q1: who is on what, where ----
  const lanes: Record<string, unknown>[] = [];
  // Repo context for the ladder's git legs: the first REACHABLE worktree_path
  // carried by ANY row bound to this mission (worktrees share the repo's refs).
  // In-progress lanes are preferred by trying them first below; this fallback
  // scan means one historical EC-3 row is enough to make folded derivable.
  let repoCtx: string | null = null;
  for (const r of rows) {
    const m = r.body?.match(WORKTREE_LINE);
    if (!m?.[1]) continue;
    try {
      exec("git", ["-C", m[1], "rev-parse", "--git-dir"]);
      repoCtx = m[1];
      break;
    } catch {
      /* unreachable candidate — keep scanning */
    }
  }
  for (const r of rows.filter((r) => r.state === "in-progress")) {
    const slice = sliceOfRow(r);
    if (!slice) continue;
    const wtMatch = r.body?.match(WORKTREE_LINE);
    let worktreePath: string | Indeterminate = INDETERMINATE;
    let branch: string | Indeterminate = INDETERMINATE;
    let headSha: string | Indeterminate = INDETERMINATE;
    let fragileJoin = false;
    let joinBasis: string;
    if (wtMatch?.[1]) {
      worktreePath = wtMatch[1];
      joinBasis = "EC-3 worktree_path field on the row body";
      try {
        branch = exec("git", ["-C", worktreePath, "rev-parse", "--abbrev-ref", "HEAD"]);
        headSha = exec("git", ["-C", worktreePath, "rev-parse", "HEAD"]);
        if (!repoCtx) repoCtx = worktreePath;
      } catch {
        branch = INDETERMINATE;
        headSha = INDETERMINATE;
        joinBasis += " (path unreachable at read time)";
      }
    } else {
      fragileJoin = true;
      joinBasis = "row/branch naming only (EC-3 field absent — legacy baton)";
    }
    const arbitrated = deps.seatActivity?.getSeatStateBySession(r.destination_session) ?? null;
    const pickup = derivePickup({
      state: r.state,
      claimedAt: r.claimed_at,
      lastHeartbeat: r.last_heartbeat,
      postClaimMotionCount: Number(r.post_claim_motion ?? 0),
      now: now(),
    });
    lanes.push({
      qitem_id: r.qitem_id,
      slice,
      seat: r.destination_session,
      worktree_path: worktreePath,
      branch,
      head_sha: headSha,
      fragile_join: fragileJoin,
      join_basis: joinBasis,
      activity: arbitrated
        ? {
            activity: arbitrated.activity,
            needs_input: arbitrated.needsInput,
            decided_by: arbitrated.decidedBy,
            changed_at: arbitrated.changedAt,
            source: "SeatActivityService arbitrated seat state (the one oracle; vocabulary passed through untranslated)",
          }
        : {
            activity: INDETERMINATE,
            basis: deps.seatActivity ? "no arbitrated state for this seat" : "seat-activity oracle not wired on this deps set",
            source: "SeatActivityService arbitrated seat state (no answer floors INDETERMINATE, never idle/dead)",
          },
      pickup,
      source: { qitem_id: r.qitem_id },
    });
  }

  // ---- arrangement authority: mission/slice YAML, with legacy EC-2 fallback ----
  const waveMap = mission === INDETERMINATE
    ? { rowId: INDETERMINATE as Indeterminate, waves: [] }
    : readWaveMap(deps.db, missionReferences(missionsRoot, mission));
  const arrangement = missionsRoot && mission !== INDETERMINATE
    ? readArrangement(missionsRoot, mission, slices)
    : null;
  const lifecycleExecutions = mission === INDETERMINATE ? [] : readLifecycleExecutions(deps.db, mission);
  const arrangementSlice = (id: string, dir?: string): ArrangementSlice | null => {
    if (arrangement?.state !== "valid") return null;
    return arrangement.byId.get(id) ?? (dir ? arrangement.byDir.get(dir) : undefined) ?? null;
  };
  const waveOfSlice = (id: string): { wave: string; rank: number; review_model?: string } | null => {
    if (arrangement?.state === "valid") {
      const facts = slices.find((slice) => slice.id === id);
      const item = arrangementSlice(id, facts?.dir);
      if (!item?.wave) return null;
      return {
        wave: item.wave,
        rank: item.order,
        ...(item.reviewModel ? { review_model: item.reviewModel } : {}),
      };
    }
    for (let wi = 0; wi < waveMap.waves.length; wi++) {
      const w = waveMap.waves[wi];
      if (!w) continue;
      const order = w.serialized_order ?? w.slices;
      const si = order.indexOf(id);
      if (si >= 0 || w.slices.includes(id)) {
        return { wave: w.id, rank: wi * 100 + (si >= 0 ? si : 50), review_model: w.review_model };
      }
    }
    return null;
  };

  // ---- Q4 ladder (also feeds Q2's deps-folded) ----
  const rigsRoot = (deps.rigsRoot ?? resolveLegacyTopologyRigsRoot)();
  const commitCache = new Map<string, string | null>();
  const ladderOf = (facts: SliceFacts): Record<string, unknown> => {
    const fm = facts.frontmatter;
    const locked: Rung = typeof fm["approved-spec-at"] === "string"
      ? { value: true, basis: `frontmatter approved-spec-at=${fm["approved-spec-at"]}` }
      : { value: false, basis: "no approved-spec-at in frontmatter" };
    // built: latest candidate:<sha> tag on a row bound to this slice.
    const candRows = rows
      .filter((r) => sliceOfRow(r) === facts.id || sliceOfRow(r) === facts.dir)
      .sort((a, b) => (a.ts_created < b.ts_created ? 1 : -1));
    let candidateSha: string | null = null;
    let candidateRow: string | null = null;
    for (const r of candRows) {
      for (const t of parseTags(r.tags)) {
        const m = t.match(CANDIDATE_TAG);
        if (m?.[1]) {
          candidateSha = m[1];
          candidateRow = r.qitem_id;
          break;
        }
      }
      if (candidateSha) break;
    }
    // Candidate identity is COMMIT-AWARE: the tag token resolves to a full
    // commit id through the repo context; raw prefix string equality is never
    // commit identity.
    const builtToken = extractShaToken(candidateSha);
    const builtResolved = builtToken && repoCtx ? resolveCommit(exec, repoCtx, builtToken, commitCache) : null;
    const built = candidateSha
      ? {
          candidate_sha: builtToken ?? candidateSha,
          resolved_commit: builtResolved ?? INDETERMINATE,
          basis: `candidate:* tag on row ${candidateRow}${builtResolved ? " (resolved to full commit via repo context)" : repoCtx ? " (token did not resolve to a commit)" : " (no repo context to resolve through)"}`,
        }
      : { candidate_sha: INDETERMINATE, basis: "no candidate:* tag on any row bound to this slice (unbuilt and unrecorded are indistinguishable here)" };
    // reviewed: registry artifacts naming this slice, SCOPED TO THE BUILT COMMIT —
    // the contract is {legs+verdicts at sha}. Mixed production forms (abbreviated
    // tags, full shas, annotated fields) join by RESOLVED commit; malformed,
    // ambiguous, or non-resolving inputs are excluded with the reason carried —
    // they neither clear nor poison.
    const artifacts = scanReviewArtifacts(rigsRoot, [facts.dir, ...(typeof facts.id === "string" ? [facts.id] : [])]);
    let reviewed: Record<string, unknown>;
    if (artifacts === INDETERMINATE) {
      reviewed = { value: INDETERMINATE, basis: `review-artifact root unreadable (${rigsRoot})`, legs: [] };
    } else if (!candidateSha || !builtToken) {
      reviewed = { value: INDETERMINATE, basis: "no built candidate token to scope review legs to", legs: [] };
    } else if (!builtResolved) {
      reviewed = {
        value: INDETERMINATE,
        basis: repoCtx
          ? `built token ${builtToken} did not resolve to a commit — identity join impossible`
          : "no repo context to resolve candidate identity through",
        legs: [],
      };
    } else {
      const excluded: { path: string; reason: string }[] = [];
      const atCommit = artifacts.filter((a) => {
        const token = extractShaToken(a.candidateSha);
        if (!token) {
          excluded.push({ path: a.path, reason: "malformed candidate_sha (no sha token)" });
          return false;
        }
        const resolved = resolveCommit(exec, repoCtx!, token, commitCache);
        if (!resolved) {
          excluded.push({ path: a.path, reason: `token ${token} did not resolve to a commit` });
          return false;
        }
        return resolved === builtResolved;
      });
      reviewed = atCommit.length === 0
        ? { value: INDETERMINATE, basis: `no review artifact resolves to the built commit ${builtResolved.slice(0, 9)} on the registry surface checked`, legs: [], excluded }
        : {
            value: atCommit.every((a) => ["CLEAR", "PASS"].includes(a.verdict)),
            basis: `frontmatter verdicts at ${atCommit.length} artifact(s) joined by resolved commit ${builtResolved.slice(0, 9)}`,
            legs: atCommit.map((a) => ({ path: a.path, verdict: a.verdict, candidate_sha: a.candidateSha, artifact_type: a.artifactType })),
            excluded,
          };
    }
    // folded / adopted need a repo context — any reachable EC-3 worktree shares refs.
    let folded: Rung;
    let adopted: Rung;
    if (!candidateSha) {
      folded = { value: INDETERMINATE, basis: "no candidate sha to test" };
      adopted = { value: INDETERMINATE, basis: "no candidate sha to test" };
    } else if (!repoCtx) {
      folded = { value: INDETERMINATE, basis: "no reachable repo context (no EC-3 worktree on the board)" };
      adopted = { value: INDETERMINATE, basis: "no reachable repo context (no EC-3 worktree on the board)" };
    } else {
      folded = gitAncestor(exec, repoCtx, builtResolved ?? candidateSha, "main");
      adopted = buildInfo.commit
        ? gitAncestor(exec, repoCtx, builtResolved ?? candidateSha, buildInfo.commit)
        : { value: INDETERMINATE, basis: "daemon build stamp absent (dev run) — adopted rung underivable" };
    }
    return { slice_id: facts.id, dir: facts.dir, locked, built, reviewed, folded, adopted };
  };

  const ladderCache = new Map<string, Record<string, unknown>>();
  const ladderFor = (facts: SliceFacts): Record<string, unknown> => {
    const key = facts.specPath;
    if (!ladderCache.has(key)) ladderCache.set(key, ladderOf(facts));
    return ladderCache.get(key)!;
  };

  const q4 = slices.map((s) => ladderFor(s));

  // ---- Q2 sequencing ----
  const q2 = slices.map((s) => {
    const fm = s.frontmatter;
    const arranged = typeof s.id === "string" ? arrangementSlice(s.id, s.dir) : null;
    const dependsOn = arranged?.dependsOn ?? parseArrayField(fm["depends_on"]);
    const softMatch = s.body.match(SOFT_AFTER_LINE);
    const softAfter = softMatch?.[1] ? softMatch[1].split(",").map((x) => x.trim()).filter(Boolean) : [];
    // Only LIVE rows can hold work blocked: stale blockedOn on a terminal row is
    // record, not state, and must not govern dispatchability.
    const blockedRows = rows
      .filter((r) => (sliceOfRow(r) === s.id || sliceOfRow(r) === s.dir) && r.blocked_on
        && ["pending", "in-progress", "blocked"].includes(r.state))
      .map((r) => ({ qitem_id: r.qitem_id, blocked_on: r.blocked_on }));
    const claimedLane = lanes.some((l) => l.slice === s.id || l.slice === s.dir);
    let nextUp: boolean | Indeterminate;
    let nextUpBasis: string;
    if (dependsOn === INDETERMINATE) {
      nextUp = INDETERMINATE;
      nextUpBasis = "depends_on absent from frontmatter (EC-1 not applied here)";
    } else if (blockedRows.length > 0) {
      nextUp = false;
      nextUpBasis = `blocked rows present (${blockedRows.map((b) => b.qitem_id).join(", ")})`;
    } else if (claimedLane) {
      nextUp = false;
      nextUpBasis = "already claimed in-progress";
    } else if ((ladderFor(s)["folded"] as Rung).value === true) {
      nextUp = false;
      nextUpBasis = "own candidate already folded to main — nothing left to dispatch";
    } else if ((ladderFor(s)["folded"] as Rung).value === INDETERMINATE) {
      // Unknown own-completion must never read as dispatchable — INDETERMINATE
      // is the honest verdict, not true (the S24/S25 live false-green class).
      nextUp = INDETERMINATE;
      nextUpBasis = `own completion rung INDETERMINATE (${(ladderFor(s)["folded"] as Rung).basis})`;
    } else {
      nextUp = true;
      nextUpBasis = "unblocked, unclaimed";
      for (const dep of dependsOn) {
        const depFacts = resolveDep(dep, slices, missionsRoot, depCache);
        if (!depFacts) {
          nextUp = INDETERMINATE;
          nextUpBasis = `dep ${dep} unresolvable on this missions root`;
          break;
        }
        const depLadder = ladderFor(depFacts);
        const foldedRung = depLadder["folded"] as Rung;
        if (foldedRung.value === INDETERMINATE) {
          nextUp = INDETERMINATE;
          nextUpBasis = `dep ${dep} folded-rung INDETERMINATE (${foldedRung.basis})`;
          break;
        }
        if (foldedRung.value === false) {
          nextUp = false;
          nextUpBasis = `dep ${dep} not folded`;
          break;
        }
      }
    }
    const wave = typeof s.id === "string" ? waveOfSlice(s.id) : null;
    return {
      slice_id: s.id,
      dir: s.dir,
      depends_on: dependsOn,
      soft_after: softAfter,
      blocked_on_rows: blockedRows,
      next_up: nextUp,
      next_up_basis: nextUpBasis,
      next_up_rank: nextUp === true && wave ? wave.rank : null,
      source: {
        spec_path: s.specPath,
        wave_map_row: waveMap.rowId,
        ...(arranged ? { arrangement_path: arranged.path } : {}),
      },
    };
  });

  // ---- Q3 care dial ----
  const q3 = slices.map((s) => {
    const wave = typeof s.id === "string" ? waveOfSlice(s.id) : null;
    const dial = typeof s.frontmatter["approved-spec-dial"] === "string"
      ? (s.frontmatter["approved-spec-dial"] as string)
      : INDETERMINATE;
    return {
      slice_id: s.id,
      build_wave: wave?.wave ?? INDETERMINATE,
      review_model: wave?.review_model ?? INDETERMINATE,
      planning_dial: dial,
      source: {
        wave_map_row: waveMap.rowId,
        ...(typeof s.id === "string" && arrangementSlice(s.id, s.dir)
          ? { arrangement_path: arrangementSlice(s.id, s.dir)!.path }
          : {}),
        dial: dial === INDETERMINATE ? "no approved-spec-dial frontmatter field" : `frontmatter approved-spec-dial at ${s.specPath}`,
      },
    };
  });

  // ---- Q5 park honesty ----
  const q5 = rows
    .filter((r) => r.state === "blocked" || (r.claimed_at && ["in-progress", "pending"].includes(r.state)))
    .map((r) => {
      const pickup = derivePickup({
        state: r.state,
        claimedAt: r.claimed_at,
        lastHeartbeat: r.last_heartbeat,
        postClaimMotionCount: Number(r.post_claim_motion ?? 0),
        now: now(),
      });
      const wake = deps.db
        .prepare(`SELECT wake_ref, phase FROM queue_transition_wakes WHERE qitem_id = ? AND phase = 'armed' LIMIT 1`)
        .get(r.qitem_id) as { wake_ref: string; phase: string } | undefined;
      // park_kind is a CLOSED enum from the DESIGN: deliberate-with-wake |
      // stalled | indeterminate. Nothing else may leak in (the live artifact
      // once emitted 'working' here), and the enum member is lowercase.
      let parkKind: "deliberate-with-wake" | "stalled" | "indeterminate";
      if (pickup.state === "parked" && wake) {
        parkKind = "deliberate-with-wake";
      } else if (pickup.state === "stalled-after-claim") {
        parkKind = "stalled";
      } else {
        parkKind = "indeterminate";
      }
      const ageMinutes = r.claimed_at ? Math.floor((now().getTime() - Date.parse(r.claimed_at)) / 60_000) : null;
      return {
        qitem_id: r.qitem_id,
        pickup_state: pickup.state,
        ...(pickup.evidence ? { pickup_evidence: pickup.evidence } : {}),
        park_kind: parkKind,
        park_kind_basis: wake
          ? `armed wake ${wake.wake_ref} on queue_transition_wakes`
          : "no armed wake row (deliberate-park-without-wake vs strand is underivable here — rig parked owns wake diagnosis)",
        wake_target: wake?.wake_ref ?? null,
        age_minutes: ageMinutes,
        source: { qitem_id: r.qitem_id },
      };
    });

  // ---- Q6 parallelism health ----
  const inProgressSeats = new Set(rows.filter((r) => r.state === "in-progress").map((r) => r.destination_session));
  // Idle capacity: the ROSTER comes from sessions (names only); idleness comes
  // from the ACTIVITY ORACLE — sessions.status is not consulted (it labeled
  // live working lanes `superseded` on the real board).
  let idleSeats: number | Indeterminate = INDETERMINATE;
  let idleBasis = "seat-activity oracle not wired on this deps set";
  if (deps.seatActivity) {
    try {
      const roster = deps.db
        .prepare(`SELECT DISTINCT session_name FROM sessions`)
        .all() as { session_name: string }[];
      idleSeats = roster.filter((s) => {
        if (inProgressSeats.has(s.session_name)) return false;
        const a = deps.seatActivity!.getSeatStateBySession(s.session_name);
        // Capacity = arbitrated idle-at-prompt with NOTHING demanding input —
        // a needs-input seat is waiting on someone, not available.
        return !!a && a.activity === "idle-at-prompt" && a.needsInput.count === 0;
      }).length;
      idleBasis = "arbitrated seat state idle-at-prompt with needsInput.count=0 over the sessions roster (names only), minus seats holding in-progress rows";
    } catch {
      idleSeats = INDETERMINATE;
      idleBasis = "sessions roster unreadable";
    }
  }
  const heavyRow = rows.find((r) => r.state === "in-progress" && parseTags(r.tags).includes("heavy-slot"));
  let dfMargin: Record<string, unknown> = { available_kib: INDETERMINATE, basis: "no readable path for statfs" };
  const dfPath = repoCtx ?? missionsRoot;
  if (dfPath) {
    try {
      const st = fs.statfsSync(dfPath);
      dfMargin = {
        available_kib: Math.floor((st.bavail * st.bsize) / 1024),
        path: dfPath,
        basis: "fs.statfsSync at read time",
      };
    } catch {
      dfMargin = { available_kib: INDETERMINATE, path: dfPath, basis: "statfs failed" };
    }
  }
  const q6 = {
    lanes_live: lanes.length,
    lanes_possible: q2.filter((s) => s.next_up === true).length,
    idle_seats_with_capacity: { value: idleSeats, basis: idleBasis },
    heavy_slot_holder: heavyRow
      ? { value: heavyRow.qitem_id, basis: "in-progress row tagged heavy-slot" }
      : { value: null, basis: "no in-progress row tagged heavy-slot — absence of the tag, not proof of an idle lane" },
    df_margin: dfMargin,
  };

  return {
    view: "execution",
    mission,
    derived_at: derivedAt,
    sources: {
      queue_db: { asof: asof(), basis: "queue_items/queue_transitions/queue_transition_wakes/sessions at read time" },
      slice_frontmatter: { root: missionsRoot ?? INDETERMINATE, asof: asof() },
      wave_map: {
        row: waveMap.rowId,
        asof: asof(),
        ...(arrangement?.state === "valid" ? { superseded_by: `${arrangement.missionPath} + referenced slice.yaml files` } : {}),
      },
      ...(arrangement?.state === "valid"
        ? {
            arrangement: {
              manifest: arrangement.missionPath,
              asof: asof(),
              basis: "mission.yaml composition order + referenced slice.yaml execution fields",
            },
          }
        : arrangement?.state === "malformed"
          ? {
              arrangement: {
                value: INDETERMINATE,
                manifest: arrangement.missionPath,
                asof: asof(),
                basis: `mission.yaml arrangement malformed (${arrangement.warning}); fallback to legacy format:wave-map-v1 and SPEC frontmatter`,
              },
            }
          : {}),
      git: { basis: repoCtx ? `per-lane git -C; repo context ${repoCtx}` : "no reachable repo context", asof: asof() },
      build_info: { commit: buildInfo.commit ?? INDETERMINATE, asof: asof() },
      review_artifacts: { root: rigsRoot, asof: asof() },
      disk: { asof: asof() },
      workflow_lifecycle: {
        asof: asof(),
        basis: "workflow_instances identity joined to packet bindings, failure occurrences, workflow spec, and current queue rows at read time",
      },
    },
    lifecycle_instances: lifecycleExecutions,
    q1_lanes: lanes,
    q2_sequencing: q2,
    q3_care: q3,
    q4_ladder: q4,
    q5_park: q5,
    q6_parallelism: q6,
  };
}
