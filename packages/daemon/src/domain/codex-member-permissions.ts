import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { CodexPermissionEnvelope } from "./codex-rebuild-permissions.js";
import { codexEnvelopeArgs } from "./codex-rebuild-permissions.js";
import { shellQuote } from "../adapters/shell-quote.js";
import type { AppliedLaunchObservation } from "./permission-drift.js";

/** A Codex seat's own sandbox and approval choice, emitted as explicit flags on its managed launches and resumes.
 *  Full access is not an envelope: it stays the full_bypass mode. Normalized, a workspace-write envelope states every
 *  field the emitter sets, so nothing falls back to a profile's value for them. */
export interface CodexSandboxPermissions {
  sandbox: "workspace-write" | "read-only";
  approval: "never" | "on-request" | "untrusted";
  network_access?: boolean;
  writable_roots?: string[];
  exclude_tmpdir_env_var?: boolean;
  exclude_slash_tmp?: boolean;
}

export type CodexFilesystemAccess = "read" | "write" | "deny";

/** An explicit native filesystem policy, mutually exclusive with the legacy sandbox fields. */
export interface CodexFilesystemPermissions {
  filesystem: Record<string, CodexFilesystemAccess>;
  approval: Exclude<CodexSandboxPermissions["approval"], "untrusted">;
  network_access?: boolean;
  sandbox?: never;
  writable_roots?: never;
  exclude_tmpdir_env_var?: never;
  exclude_slash_tmp?: never;
}

export type CodexMemberPermissions = CodexSandboxPermissions | CodexFilesystemPermissions;

const KEYS = ["sandbox", "approval", "network_access", "writable_roots", "exclude_tmpdir_env_var", "exclude_slash_tmp"];
const WORKSPACE_ONLY = ["network_access", "writable_roots", "exclude_tmpdir_env_var", "exclude_slash_tmp"];
const FILESYSTEM_KEYS = ["filesystem", "approval", "network_access"];
const FILESYSTEM_SPECIAL_PATHS = new Set([":root", ":minimal", ":workspace_roots", ":project_roots", ":tmpdir", ":slash_tmp"]);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function validateCodexMemberPermissions(value: unknown, label = "codex_permissions"): CodexMemberPermissions {
  if (!isRecord(value)) throw new Error(`${label}: expected a mapping with sandbox or filesystem, and approval`);
  const raw = value;
  const keys = "filesystem" in raw ? FILESYSTEM_KEYS : KEYS;
  for (const key of Object.keys(raw)) if (!keys.includes(key)) throw new Error(`${label}.${key}: unsupported key; supported keys are ${keys.join(", ")}`);
  const approval = raw.approval;
  if (approval !== "never" && approval !== "on-request" && approval !== "untrusted") {
    throw new Error(`${label}.approval: expected never, on-request or untrusted`);
  }
  if ("filesystem" in raw) {
    if (approval === "untrusted") {
      throw new Error(`${label}.approval: untrusted is not supported with filesystem; expected never or on-request`);
    }
    if (!isRecord(raw.filesystem) || Object.keys(raw.filesystem).length === 0) {
      throw new Error(`${label}.filesystem: expected a nonempty mapping of paths to read, write or deny`);
    }
    const filesystem: CodexFilesystemPermissions["filesystem"] = {};
    for (const [path, access] of Object.entries(raw.filesystem)) {
      if (/[\0\r\n]/.test(path) || !(isAbsolute(path) || path.startsWith("~/") || FILESYSTEM_SPECIAL_PATHS.has(path))) {
        throw new Error(`${label}.filesystem: expected an absolute path, ~/path or a supported native special path; got ${JSON.stringify(path)}`);
      }
      if (access !== "read" && access !== "write" && access !== "deny") {
        throw new Error(`${label}.filesystem[${JSON.stringify(path)}]: expected read, write or deny`);
      }
      filesystem[path] = access;
    }
    if (raw.network_access !== undefined && typeof raw.network_access !== "boolean") throw new Error(`${label}.network_access: expected true or false`);
    return { approval, filesystem, network_access: raw.network_access === true };
  }
  const sandbox = raw.sandbox;
  if (sandbox === "danger-full-access") throw new Error(`${label}.sandbox: full access is the full_bypass mode, not an envelope; select it with --mode full_bypass`);
  if (sandbox !== "workspace-write" && sandbox !== "read-only") throw new Error(`${label}.sandbox: expected workspace-write or read-only`);
  if (sandbox === "read-only") {
    const extra = WORKSPACE_ONLY.find(key => raw[key] !== undefined);
    if (extra) throw new Error(`${label}.${extra}: only valid with sandbox workspace-write`);
    return { sandbox: "read-only", approval };
  }
  for (const key of ["network_access", "exclude_tmpdir_env_var", "exclude_slash_tmp"]) {
    if (raw[key] !== undefined && typeof raw[key] !== "boolean") throw new Error(`${label}.${key}: expected true or false`);
  }
  const roots = raw.writable_roots ?? [];
  if (!Array.isArray(roots)) throw new Error(`${label}.writable_roots: expected a list of absolute paths`);
  const writableRoots: string[] = [];
  roots.forEach((root: unknown, index) => {
    if (typeof root !== "string" || !root.trim() || !isAbsolute(root) || /[\0\r\n]/.test(root)) {
      throw new Error(`${label}.writable_roots[${index}]: expected an absolute path without newlines`);
    }
    writableRoots.push(root);
  });
  return {
    sandbox: "workspace-write", approval,
    network_access: raw.network_access === true, writable_roots: writableRoots,
    exclude_tmpdir_env_var: raw.exclude_tmpdir_env_var === true, exclude_slash_tmp: raw.exclude_slash_tmp === true,
  };
}

/** The native policy codexEnvelopeArgs emits for this choice. */
export function codexMemberEnvelope(permissions: CodexSandboxPermissions): CodexPermissionEnvelope {
  if (permissions.sandbox === "read-only") return { approvalPolicy: permissions.approval, sandboxPolicy: { type: "read-only" } };
  return { approvalPolicy: permissions.approval, sandboxPolicy: { type: "workspace-write",
    writable_roots: permissions.writable_roots ?? [], network_access: permissions.network_access === true,
    exclude_tmpdir_env_var: permissions.exclude_tmpdir_env_var === true, exclude_slash_tmp: permissions.exclude_slash_tmp === true } };
}

/** Invocation-local profile: never written into the account home or the shared project. */
export const CODEX_SEAT_PERMISSION_PROFILE = "openrig-seat";

export function codexFilesystemOverrides(permissions: CodexFilesystemPermissions): string[] {
  const entries = Object.entries(permissions.filesystem).map(([path, access]) => `${JSON.stringify(path)}=${JSON.stringify(access)}`).join(",");
  return [`default_permissions=${JSON.stringify(CODEX_SEAT_PERMISSION_PROFILE)}`,
    `permissions={${JSON.stringify(CODEX_SEAT_PERMISSION_PROFILE)}={filesystem={${entries}},network={enabled=${permissions.network_access === true}}}}`];
}

/** The same authored choice reaches launch, both resumes and the status plan. This reports argv, not enforcement. */
export function codexMemberLaunch(permissions: CodexMemberPermissions): { args: string; observation: AppliedLaunchObservation; suppressAutoAddDirs: boolean } {
  if ("filesystem" in permissions) {
    return { args: ` -a ${permissions.approval}` + codexFilesystemOverrides(permissions).map(value => ` -c ${shellQuote(value)}`).join(""),
      observation: { runtime: "codex", axis: "sandbox", state: "observed", value: `permissions:${CODEX_SEAT_PERMISSION_PROFILE}`,
        reason: "emitted_launch_arguments", ...(permissions.approval === "never" ? { approvalPolicy: "never" } : {}) }, suppressAutoAddDirs: true };
  }
  const envelope = codexMemberEnvelope(permissions);
  return { args: codexEnvelopeArgs(envelope), observation: observeCodexEnvelope(envelope), suppressAutoAddDirs: permissions.sandbox === "read-only" };
}

/** What an emitted envelope's arguments ask for; the native result still needs its own observation. */
export function observeCodexEnvelope(envelope: CodexPermissionEnvelope): AppliedLaunchObservation {
  return { runtime: "codex", axis: "sandbox", state: "observed", value: envelope.sandboxPolicy.type,
    approvalPolicy: envelope.approvalPolicy, reason: "emitted_launch_arguments" };
}

/** Parse and validate a seat's stored codex_permissions_json column with the canonical seat repair error. */
export function parseStoredCodexMemberPermissions(
  nodeId: string,
  codexPermissionsJson: string | null | undefined,
  logicalId?: string | null,
): CodexMemberPermissions | undefined {
  if (codexPermissionsJson == null) return undefined;
  const seat = logicalId ? `${nodeId} (${logicalId})` : nodeId;
  try {
    return validateCodexMemberPermissions(JSON.parse(codexPermissionsJson));
  } catch (error) {
    throw new Error(`Seat ${seat}: cannot read codex_permissions (${(error as Error).message}). Repair it with rig seat set-permissions <seat> --codex-permissions <file> --reason <reason>, or choose a mode with --mode, before launching.`);
  }
}

/** Read the current seat, not its original spec or a snapshot. Minimal old fixtures have no column. */
export function readCodexMemberPermissions(db: Database.Database, nodeId: string): CodexMemberPermissions | undefined {
  let row: { logical_id?: string | null; codex_permissions_json?: string | null } | undefined;
  try {
    row = db.prepare("SELECT * FROM nodes WHERE id = ?").get(nodeId) as typeof row;
  } catch (error) {
    throw new Error(`Seat ${nodeId}: cannot read codex_permissions (${(error as Error).message}). Repair it with rig seat set-permissions <seat> --codex-permissions <file> --reason <reason>, or choose a mode with --mode, before launching.`);
  }
  return parseStoredCodexMemberPermissions(nodeId, row?.codex_permissions_json, row?.logical_id);
}

/** Clear a seat's envelope inside the caller's transaction, when an explicit mode replaces it; returns what it held, or
 *  undefined when it held none. Unreadable bytes are returned as such, so the audit shows what was replaced. */
export function clearCodexMemberPermissions(db: Database.Database, nodeId: string): unknown {
  let row: { codex_permissions_json: string | null } | undefined;
  try { row = db.prepare("SELECT codex_permissions_json FROM nodes WHERE id = ?").get(nodeId) as typeof row; }
  catch (error) {
    // Only a schema without the column (a minimal fixture) has no envelope. Any other read failure propagates, so the
    // caller's transaction rolls back rather than record a mode beside an envelope it never cleared.
    if ((error as { code?: string }).code === "SQLITE_ERROR" && /no such column: codex_permissions_json\b/.test((error as Error).message)) return undefined;
    throw error;
  }
  if (row?.codex_permissions_json == null) return undefined;
  let held: unknown;
  try { held = readCodexMemberPermissions(db, nodeId); }
  catch { held = { state: "invalid", stored: row.codex_permissions_json }; }
  db.prepare("UPDATE nodes SET codex_permissions_json = NULL WHERE id = ?").run(nodeId);
  return held;
}

/** The setter's check of a named profile, from the config home this seat's launches use. */
export interface CodexProfileObservation {
  /** configured_codex_home: the daemon's explicit CODEX_HOME, which managed Codex launches reassert. unestablished: the
   *  daemon sets none, so a pane keeps its own and this check can't speak for it. */
  vantage: "configured_codex_home" | "unestablished";
  home: string | null;
  file: "present" | "absent" | "unreadable" | "unverified";
  /** The file's bytes when read: observation for a later "changed" report, never a launch pin. */
  sha256?: string;
  load: "ok" | "failed" | "not_run";
  detail: string;
  observedAt: string;
}

export interface CodexProfileObserver {
  observeProfile(profile: string, cwd: string, nodeId: string): Promise<CodexProfileObservation>;
}

export type ProfileFingerprint = { state: "present"; sha256: string } | { state: "absent" } | { state: "unreadable"; reason: string };

/** The largest profile the setter hashes; a profile is a small TOML file. */
export const PROFILE_FINGERPRINT_MAX_BYTES = 1024 * 1024;

/** The profile file's bytes, for the "changed since recorded" observation only. Asynchronous and bounded: it opens
 *  without blocking (a FIFO can't hold the open), hashes only a regular file of bounded size, and turns every other
 *  outcome into a reason instead of an error. The native loader check, not this, decides whether the profile loads. */
export async function readProfileFingerprint(path: string, maxBytes = PROFILE_FINGERPRINT_MAX_BYTES): Promise<ProfileFingerprint> {
  let handle: Awaited<ReturnType<typeof open>>;
  try { handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" ? { state: "absent" } : { state: "unreadable", reason: code ?? (error as Error).message };
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return { state: "unreadable", reason: "not a regular file" };
    if (stat.size > maxBytes) return { state: "unreadable", reason: `larger than ${maxBytes} bytes` };
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
      if (length > maxBytes) return { state: "unreadable", reason: `larger than ${maxBytes} bytes` };
    }
    return { state: "present", sha256: createHash("sha256").update(buffer.subarray(0, length)).digest("hex") };
  } catch (error) {
    return { state: "unreadable", reason: (error as NodeJS.ErrnoException).code ?? (error as Error).message };
  } finally {
    await handle.close().catch(() => {});
  }
}
