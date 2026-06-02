// Slice-21 FR-5 — workspace doctor readiness checks for `rig workspace doctor`.
//
// 7 checks (this file ships pure check helpers; daemon route + CLI
// subcommand wiring land in follow-on commits):
//   1. Workspace root reachable (env > file > default precedence)
//   2. Missions folder present
//   3. File allowlist sane (named-pair ConfigStore key, NOT a file)
//   4. Daemon points at this workspace
//   5. Daemon reload needed
//   6. Optional slice docs (warn-only)
//   7. MISSION_NOTES presence
//
// Per-check return shape is `{check, status: "ok"|"warn"|"fail",
// message, fixHint?, evidence?}` per FR-5 IMPL-PRD §76-78. The shape
// diverges intentionally from the install-health `rig doctor`'s
// DoctorCheck shape (pass|warn|fail|skipped, reason/fix) — different
// concerns warrant different schemas (workspace-readiness vs install-
// health); the divergence is orch-marshal-accepted per cont.43-followup.

import * as fs from "node:fs";
import * as path from "node:path";
import { decodeAllowlist } from "../files/path-safety.js";

export type CheckStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
  check: string;
  status: CheckStatus;
  message: string;
  fixHint?: string;
  evidence?: Record<string, unknown>;
}

export type WorkspaceRootSource = "env" | "file" | "default";

export interface CheckWorkspaceRootInput {
  workspaceRoot: string;
  source: WorkspaceRootSource;
}

const ENV_FIX_HINT =
  "unset OPENRIG_WORKSPACE_ROOT or set it to an existing directory; run `rig config init-workspace` to scaffold a fresh one";
const FILE_FIX_HINT =
  "update workspace.root in config.json to an existing directory; run `rig config init-workspace` to scaffold a fresh one";
const DEFAULT_FIX_HINT =
  "run `rig config init-workspace` to scaffold the default workspace at the configured root";

function fixHintForSource(source: WorkspaceRootSource): string {
  switch (source) {
    case "env":
      return ENV_FIX_HINT;
    case "file":
      return FILE_FIX_HINT;
    case "default":
      return DEFAULT_FIX_HINT;
  }
}

/**
 * Check #1 — workspace root reachable.
 *
 * Verifies the resolved workspace root exists as a directory. The
 * `source` (env / file / default) is propagated into the fix-hint so
 * the operator gets the right remediation channel.
 */
export function checkWorkspaceRootReachable(opts: CheckWorkspaceRootInput): DoctorCheck {
  const { workspaceRoot, source } = opts;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(workspaceRoot);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return {
      check: "workspace_root_reachable",
      status: "fail",
      message: code === "ENOENT"
        ? `workspace root '${workspaceRoot}' does not exist (resolved from ${source})`
        : `workspace root '${workspaceRoot}' is not reachable: ${(err as Error).message}`,
      fixHint: fixHintForSource(source),
      evidence: { workspaceRoot, source, errorCode: code ?? "unknown" },
    };
  }
  if (!stat.isDirectory()) {
    return {
      check: "workspace_root_reachable",
      status: "fail",
      message: `workspace root '${workspaceRoot}' exists but is not a directory (resolved from ${source})`,
      fixHint: fixHintForSource(source),
      evidence: { workspaceRoot, source, kind: "not_a_directory" },
    };
  }
  return {
    check: "workspace_root_reachable",
    status: "ok",
    message: `workspace root '${workspaceRoot}' is a reachable directory`,
    evidence: { workspaceRoot, source },
  };
}

export interface CheckMissionsFolderInput {
  workspaceRoot: string;
  /** Resolved `workspace.slicesRoot` per ConfigStore (defaults to
   *  `<workspaceRoot>/missions`). Operators who customized
   *  `workspace.slices_root` (env or config) point this elsewhere; the
   *  check honors the override so a deliberate custom layout doesn't
   *  spuriously fail. */
  slicesRoot: string;
}

/**
 * Check #2 — missions folder present.
 *
 * Verifies the resolved missions folder (per ConfigStore `workspace.
 * slicesRoot` — defaults to `<workspaceRoot>/missions`) exists as a
 * directory. Fail on absence or wrong-shape; this is the load-bearing
 * folder for Project UI projection.
 */
export function checkMissionsFolder(opts: CheckMissionsFolderInput): DoctorCheck {
  const { workspaceRoot, slicesRoot } = opts;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(slicesRoot);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return {
      check: "missions_folder_present",
      status: "fail",
      message: code === "ENOENT"
        ? `missions folder '${slicesRoot}' does not exist`
        : `missions folder '${slicesRoot}' is not reachable: ${(err as Error).message}`,
      fixHint:
        slicesRoot === path.join(workspaceRoot, "missions")
          ? "run `rig config init-workspace` to scaffold the default missions/ folder"
          : "create the configured missions folder or unset workspace.slices_root to use the default `<workspaceRoot>/missions/`",
      evidence: { slicesRoot, workspaceRoot, errorCode: code ?? "unknown" },
    };
  }
  if (!stat.isDirectory()) {
    return {
      check: "missions_folder_present",
      status: "fail",
      message: `missions folder '${slicesRoot}' exists but is not a directory`,
      fixHint:
        "remove or rename the conflicting file and run `rig config init-workspace` to scaffold the missions folder",
      evidence: { slicesRoot, workspaceRoot, kind: "not_a_directory" },
    };
  }
  return {
    check: "missions_folder_present",
    status: "ok",
    message: `missions folder '${slicesRoot}' is present`,
    evidence: { slicesRoot, workspaceRoot },
  };
}

/**
 * Canonical-decoded allowlist entry as the shipped file API sees it
 * (post `decodeAllowlist`): absolute path, realpath-canonicalized
 * when reachable. Relative paths are silently dropped by the canonical
 * decoder before they reach this shape — see check #3 for the
 * usable-vs-raw entry-count semantics.
 */
export interface AllowlistEntry {
  name: string;
  /** Canonical absolute path (post-decodeAllowlist + realpathSync
   *  fallback). Equivalent to the file API's `AllowlistRoot.canonicalPath`. */
  path: string;
}

export interface CheckFileAllowlistInput {
  workspaceRoot: string;
  /** Raw `files.allowlist` value resolved via ConfigStore
   *  (comma-separated `name:/abs/path` pairs, or empty string). */
  allowlistValue: string;
  allowlistSource: WorkspaceRootSource;
  /** Pre-decoded entries; if omitted the check decodes allowlistValue
   *  via the canonical `decodeAllowlist` from
   *  domain/files/path-safety.ts so the doctor reports exactly what
   *  the shipped file API at /api/files/* accepts. Pre-decoded
   *  entries MUST be in canonical form (absolute path); raw
   *  named-pair strings from SettingsStore should go through
   *  allowlistValue + the in-function decode, not parsedEntries. */
  parsedEntries?: AllowlistEntry[];
}

/**
 * Check #3 — file allowlist sane.
 *
 * IMPL-PRD §43 references `<workspace-root>/.openrig/file-allowlist`
 * as a file — the shipped surface (ConfigStore `files.allowlist` key,
 * env OPENRIG_FILES_ALLOWLIST, default `workspace:${workspaceRoot}`)
 * is a CONFIGSTORE STRING KEY holding comma-separated `name:/abs/path`
 * pairs. There is no per-workspace file. Check #3 verifies the
 * resolved value decodes to at least one USABLE entry (canonical,
 * absolute) covering the workspaceRoot — the same usable-root
 * semantics the shipped file API at /api/files/* enforces via
 * `decodeAllowlist` in domain/files/path-safety.ts:60-80 (silently
 * drops non-absolute paths at line 71).
 *
 * Decoding via the canonical decoder (not a local re-implementation)
 * guarantees the doctor's verdict matches the actual file-API
 * behavior — `workspace:.` or `workspace:relative-root` evaluates
 * to zero usable entries here, mirroring the file API's silent skip.
 */
export function checkFileAllowlist(opts: CheckFileAllowlistInput): DoctorCheck {
  const { workspaceRoot, allowlistValue, allowlistSource } = opts;
  const entries: AllowlistEntry[] = opts.parsedEntries
    ?? decodeAllowlist(allowlistValue).map((r) => ({ name: r.name, path: r.canonicalPath }));
  if (entries.length === 0) {
    return {
      check: "file_allowlist_sane",
      status: "fail",
      message: `files.allowlist resolved to no usable entries (raw='${allowlistValue}', source=${allowlistSource}); non-absolute or malformed pairs are silently dropped to match the shipped file API`,
      fixHint:
        "set OPENRIG_FILES_ALLOWLIST or run `rig config set files.allowlist workspace:<absoluteWorkspaceRoot>` so the file surface has a readable root (absolute paths only)",
      evidence: { allowlistValue, allowlistSource, entryCount: 0 },
    };
  }
  const covers = entries.some((e) => allowlistPathCoversRoot(e.path, workspaceRoot));
  if (!covers) {
    return {
      check: "file_allowlist_sane",
      status: "warn",
      message: `files.allowlist has ${entries.length} usable entr${entries.length === 1 ? "y" : "ies"} but none cover workspace root '${workspaceRoot}'`,
      fixHint:
        "add a `workspace:<absoluteWorkspaceRoot>` entry to files.allowlist (or set OPENRIG_FILES_ALLOWLIST) so workspace files are read-allowed",
      evidence: {
        allowlistValue,
        allowlistSource,
        entryCount: entries.length,
        workspaceRoot,
        entries,
      },
    };
  }
  return {
    check: "file_allowlist_sane",
    status: "ok",
    message: `files.allowlist has ${entries.length} usable entr${entries.length === 1 ? "y" : "ies"} covering workspace root`,
    evidence: { allowlistValue, allowlistSource, entryCount: entries.length, entries },
  };
}

function allowlistPathCoversRoot(allowlistPath: string, workspaceRoot: string): boolean {
  // Canonical entry paths from decodeAllowlist are already absolute
  // + realpath-resolved. workspaceRoot we resolve + try-to-realpath
  // here so callers can pass an un-canonical workspace path and
  // coverage still matches when the entry was realpath'd through a
  // symlink (e.g. macOS `/var/folders/...` → `/private/var/...`).
  const normEntry = allowlistPath;
  let normRoot: string;
  try {
    normRoot = fs.realpathSync(workspaceRoot);
  } catch {
    normRoot = path.resolve(workspaceRoot);
  }
  if (normEntry === normRoot) return true;
  const rel = path.relative(normEntry, normRoot);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export interface CheckDaemonWorkspaceInput {
  /** workspace.root the daemon process resolves (server-side). */
  daemonResolvedRoot: string;
  /** workspace.root the doctor caller expects (CLI-side resolved,
   *  passed in the request body or matched against the --workspace
   *  flag). */
  expectedRoot: string;
}

/**
 * Check #4 — daemon points at this workspace.
 *
 * Reports divergence between the workspace.root the daemon resolved at
 * start-time vs the workspace.root the doctor caller expects. The
 * common cause is the daemon being started in a shell with a different
 * OPENRIG_WORKSPACE_ROOT than the operator's current shell.
 */
export function checkDaemonWorkspace(opts: CheckDaemonWorkspaceInput): DoctorCheck {
  const { daemonResolvedRoot, expectedRoot } = opts;
  const normDaemon = path.resolve(daemonResolvedRoot);
  const normExpected = path.resolve(expectedRoot);
  if (normDaemon === normExpected) {
    return {
      check: "daemon_points_at_this_workspace",
      status: "ok",
      message: `daemon and caller agree on workspace root '${normDaemon}'`,
      evidence: { daemonResolvedRoot: normDaemon, expectedRoot: normExpected },
    };
  }
  return {
    check: "daemon_points_at_this_workspace",
    status: "fail",
    message: `daemon resolved workspace root '${normDaemon}' but caller expected '${normExpected}'`,
    fixHint:
      "restart the daemon (`rig daemon restart`) in a shell where OPENRIG_WORKSPACE_ROOT matches the expected workspace, or unset OPENRIG_WORKSPACE_ROOT to fall through to config + default",
    evidence: { daemonResolvedRoot: normDaemon, expectedRoot: normExpected },
  };
}

export interface CheckDaemonReloadInput {
  /** Path to the ConfigStore config file on disk. */
  configFilePath: string;
  /** Daemon process start time as a Date. Callers typically capture
   *  this once at daemon-startup (e.g.
   *  `new Date(Date.now() - process.uptime() * 1000)` at the doctor
   *  route handler) and pass it through. Compared to config-file
   *  mtime; mtime > startTime → stale daemon. */
  daemonStartTime: Date;
}

/**
 * Check #5 — daemon reload needed.
 *
 * Compares config-file mtime to the daemon's start-time. A newer
 * mtime means the operator edited config (via CLI / UI) after the
 * daemon started, and the daemon hasn't picked the change up yet.
 * Missing config file is not a fail — fresh installs without an
 * operator-written config use defaults entirely and never need a
 * reload.
 */
export function checkDaemonReload(opts: CheckDaemonReloadInput): DoctorCheck {
  const { configFilePath, daemonStartTime } = opts;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(configFilePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return {
        check: "daemon_reload_needed",
        status: "ok",
        message: `no config file at '${configFilePath}'; daemon is running on defaults only`,
        evidence: { configFilePath, configFileExists: false },
      };
    }
    return {
      check: "daemon_reload_needed",
      status: "warn",
      message: `cannot stat config file '${configFilePath}': ${(err as Error).message}`,
      fixHint: "verify file permissions on the config file path so the daemon can detect freshness",
      evidence: { configFilePath, errorCode: code ?? "unknown" },
    };
  }
  const mtimeMs = stat.mtime.getTime();
  const startMs = daemonStartTime.getTime();
  if (mtimeMs > startMs) {
    return {
      check: "daemon_reload_needed",
      status: "warn",
      message: `config file mtime ${stat.mtime.toISOString()} is newer than daemon start ${daemonStartTime.toISOString()}`,
      fixHint: "run `rig daemon restart` to pick up the latest config",
      evidence: {
        configFilePath,
        configMtime: stat.mtime.toISOString(),
        daemonStartTime: daemonStartTime.toISOString(),
        staleMs: mtimeMs - startMs,
      },
    };
  }
  return {
    check: "daemon_reload_needed",
    status: "ok",
    message: `config file mtime ${stat.mtime.toISOString()} is older than daemon start ${daemonStartTime.toISOString()}`,
    evidence: {
      configFilePath,
      configMtime: stat.mtime.toISOString(),
      daemonStartTime: daemonStartTime.toISOString(),
    },
  };
}

export interface CheckSliceDocsInput {
  /** Resolved missions folder root. The check walks each
   *  `<missionsRoot>/<mission>/slices/<slice>/` and verifies it has
   *  README.md OR IMPLEMENTATION-PRD.md OR IMPL-PRD.md. */
  missionsRoot: string;
}

const SLICE_DOC_FILES = ["README.md", "IMPLEMENTATION-PRD.md", "IMPL-PRD.md"] as const;

interface BareSlice {
  mission: string;
  slice: string;
  path: string;
}

/**
 * Check #6 — optional slice docs.
 *
 * Walks each mission's slices subdirectory and reports slices that
 * have NEITHER a README.md, IMPLEMENTATION-PRD.md, nor IMPL-PRD.md.
 * Warn-only (empty slices are sometimes intentional staging per
 * IMPL-PRD §57-59). The walk is bounded to one mission + one slice
 * level; we don't recurse into slice subdirs.
 */
export function checkOptionalSliceDocs(opts: CheckSliceDocsInput): DoctorCheck {
  const { missionsRoot } = opts;
  let missions: string[];
  try {
    missions = fs.readdirSync(missionsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return {
      check: "optional_slice_docs",
      status: "warn",
      message: code === "ENOENT"
        ? `missions root '${missionsRoot}' does not exist; no slice docs to check`
        : `cannot read missions root '${missionsRoot}': ${(err as Error).message}`,
      evidence: { missionsRoot, errorCode: code ?? "unknown" },
    };
  }

  const bareSlices: BareSlice[] = [];
  for (const mission of missions) {
    const slicesDir = path.join(missionsRoot, mission, "slices");
    let slices: string[];
    try {
      slices = fs.readdirSync(slicesDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      continue; // no slices subdir is fine — mission may not be slice-organized
    }
    for (const slice of slices) {
      const slicePath = path.join(slicesDir, slice);
      const hasDoc = SLICE_DOC_FILES.some((f) => fs.existsSync(path.join(slicePath, f)));
      if (!hasDoc) {
        bareSlices.push({ mission, slice, path: slicePath });
      }
    }
  }

  if (bareSlices.length === 0) {
    return {
      check: "optional_slice_docs",
      status: "ok",
      message: `every slice under '${missionsRoot}' has a README, IMPLEMENTATION-PRD, or IMPL-PRD`,
      evidence: { missionsRoot, bareSlices: [] },
    };
  }
  return {
    check: "optional_slice_docs",
    status: "warn",
    message: `${bareSlices.length} slice${bareSlices.length === 1 ? " has" : "s have"} no README / IMPLEMENTATION-PRD / IMPL-PRD`,
    fixHint:
      "author a README.md, IMPLEMENTATION-PRD.md, or IMPL-PRD.md in each bare slice directory; warn-only because empty slices are sometimes intentional staging",
    evidence: { missionsRoot, bareSlices },
  };
}

export interface CheckMissionNotesInput {
  missionsRoot: string;
}

interface MissionWithoutNotes {
  mission: string;
  path: string;
}

/**
 * Check #7 — MISSION_NOTES presence.
 *
 * Verifies each mission directory has a `MISSION_NOTES.md` (per the
 * FR-3 convention that just merged at LOCAL main e154a5ce). Warn-
 * only because legacy missions predate the convention; the
 * operator can run `rig scope mission create` (which now auto-
 * scaffolds the file per FR-3) for new missions.
 */
export function checkMissionNotesPresence(opts: CheckMissionNotesInput): DoctorCheck {
  const { missionsRoot } = opts;
  let missions: string[];
  try {
    missions = fs.readdirSync(missionsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return {
      check: "mission_notes_presence",
      status: "warn",
      message: code === "ENOENT"
        ? `missions root '${missionsRoot}' does not exist; no MISSION_NOTES to check`
        : `cannot read missions root '${missionsRoot}': ${(err as Error).message}`,
      evidence: { missionsRoot, errorCode: code ?? "unknown" },
    };
  }

  const missing: MissionWithoutNotes[] = [];
  for (const mission of missions) {
    const missionDir = path.join(missionsRoot, mission);
    const notesPath = path.join(missionDir, "MISSION_NOTES.md");
    if (!fs.existsSync(notesPath)) {
      missing.push({ mission, path: missionDir });
    }
  }

  if (missing.length === 0) {
    return {
      check: "mission_notes_presence",
      status: "ok",
      message: `every mission under '${missionsRoot}' has MISSION_NOTES.md`,
      evidence: { missionsRoot, missing: [] },
    };
  }
  return {
    check: "mission_notes_presence",
    status: "warn",
    message: `${missing.length} mission${missing.length === 1 ? " has" : "s have"} no MISSION_NOTES.md`,
    fixHint:
      "scaffold via `rig scope mission create <id>` (FR-3 auto-scaffold) for new missions, or copy from `<substrate>/openrig-work/conventions/mission-notes/TEMPLATE.md` for existing ones",
    evidence: { missionsRoot, missing },
  };
}

export interface RunDoctorInput {
  /** Workspace root under check (caller's --workspace override or
   *  daemon-resolved default). */
  workspaceRoot: string;
  workspaceRootSource: WorkspaceRootSource;
  /** Resolved missions folder per ConfigStore workspace.slices_root,
   *  or `<workspaceRoot>/missions` when caller overrode --workspace. */
  slicesRoot: string;
  /** Raw files.allowlist value from SettingsStore (will be decoded
   *  via canonical decodeAllowlist). */
  allowlistValue: string;
  allowlistSource: WorkspaceRootSource;
  /** Daemon-resolved workspace.root (for check #4 comparison against
   *  the workspace under check). */
  daemonResolvedWorkspaceRoot: string;
  /** Daemon's ConfigStore configPath on disk (for check #5 staleness
   *  comparison). */
  configFilePath: string;
  /** Daemon process start time (for check #5). */
  daemonStartTime: Date;
}

export interface DoctorReport {
  /** Workspace under check (echoes input.workspaceRoot for clarity). */
  workspaceRoot: string;
  checks: DoctorCheck[];
  summary: { ok: number; warn: number; fail: number };
  /** ISO timestamp of when the daemon ran the report. */
  daemonResolvedAt: string;
}

/**
 * Orchestrator — runs all 7 checks in fixed order and returns a
 * structured DoctorReport with aggregate counts. Pure function;
 * filesystem effects are bounded to the individual check helpers
 * (statSync / readdirSync / existsSync). Used by the daemon route
 * POST /api/workspace/doctor (FR-5c) and by the CLI's --json
 * formatter (FR-5d).
 */
export function runWorkspaceDoctor(input: RunDoctorInput): DoctorReport {
  const checks: DoctorCheck[] = [
    checkWorkspaceRootReachable({
      workspaceRoot: input.workspaceRoot,
      source: input.workspaceRootSource,
    }),
    checkMissionsFolder({
      workspaceRoot: input.workspaceRoot,
      slicesRoot: input.slicesRoot,
    }),
    checkFileAllowlist({
      workspaceRoot: input.workspaceRoot,
      allowlistValue: input.allowlistValue,
      allowlistSource: input.allowlistSource,
    }),
    checkDaemonWorkspace({
      daemonResolvedRoot: input.daemonResolvedWorkspaceRoot,
      expectedRoot: input.workspaceRoot,
    }),
    checkDaemonReload({
      configFilePath: input.configFilePath,
      daemonStartTime: input.daemonStartTime,
    }),
    checkOptionalSliceDocs({
      missionsRoot: input.slicesRoot,
    }),
    checkMissionNotesPresence({
      missionsRoot: input.slicesRoot,
    }),
  ];
  const summary = { ok: 0, warn: 0, fail: 0 };
  for (const c of checks) summary[c.status]++;
  return {
    workspaceRoot: input.workspaceRoot,
    checks,
    summary,
    daemonResolvedAt: new Date().toISOString(),
  };
}
