// OPR.0.4.4.18 — `rig file copy` core: path grammar, the FR-4 security wall,
// the closed rsync argv builder, and result classification.
//
// SECURITY CELL (plan §3 + §7a/§7a-2, guard-cleared over three rounds):
// five independent layers, every rejection BEFORE any spawn —
//   1. GRAMMAR (fail-closed): a path is remote iff it carries an explicit
//      `<hostId>:` qualifier; no inference from cwd/env/session (FR-2).
//      Local-prefix escapes (`/ ./ ../ ~`); an id-shaped colon prefix MUST
//      resolve or fail loudly (N18-1); leading-dash operands are refused
//      outright with the ./ escape taught (G18-P1 belt).
//   2. NORMALIZATION: local paths are ~-expanded + path.resolve'd and the
//      RESOLVED form is what is checked and transported; remote paths
//      reject ANY raw '..' SEGMENT BEFORE normalization (G18-C1: normalize
//      COLLAPSES '..' in absolute paths, so a post-normalize check is dead
//      code), then '.'/'//' are collapsed for the shipped form.
//   3. THE REMOTE CHARSET WALL (G18-P3 — supersedes a --protect-args pin:
//      this platform's rsync is OPENRSYNC, which rejects -s; never assume
//      GNU parity on macOS): remote paths must be ABSOLUTE (arch Q5) and
//      match ^[A-Za-z0-9._/-]+$ — every allowed character is POSIX-shell-
//      inert, so the ssh-invoked remote shell has NOTHING to interpret:
//      no word-split (space excluded), no glob (*?[] excluded), no
//      expansion (~ $ excluded), no metacharacters. Rejections TEACH
//      (offending char named + workaround; arch note, N18-2-revisitable).
//   4. THE `--` OPERAND PIN (G18-P1 suspenders): the builder ALWAYS places
//      `--` before the two path operands — a flag-shaped path can never
//      parse as an option even if a future caller bypasses the refusal.
//   5. NO SHELL locally: spawn("rsync", argv) with argv arrays; the -e ssh
//      string is built ONLY from registry fields (user shape-checked).
//   Deletion-class flags are UNREACHABLE (property-tested, incl. the
//   `-s`/--protect-args ABSENCE uniformity pin).
//
// DENY WALL (FR-4, arch-endorsed SHORT CLOSED NAMED list — extension = a
// ruling, never a growing blocklist): local side denies resolved paths under
// ~/.openrig (live rig state — crash-safety class), ~/.ssh, ~/.codex,
// ~/.claude (credential/shared-singleton classes); remote side denies any
// path CONTAINING one of those dot-directory segments (conservative-over-
// broad: /srv/backup/.ssh/x is still a credentials dir; false positives are
// loud + revisitable, false negatives are the corruption class).

import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { spawn as nodeSpawn } from "node:child_process";
import { loadHostRegistry, resolveHost, type SshHostEntry } from "./../host-registry.js";
import { looksLikePermissionGate } from "./../cross-host-executor.js";
import { getDefaultOpenRigPath, getOpenRigHome } from "./../openrig-compat.js";

// ── grammar ────────────────────────────────────────────────────────────────

export type ParsedFileArg =
  | { kind: "local"; path: string }
  | { kind: "remote"; hostId: string; path: string };

export type FileArgParse = { ok: true; arg: ParsedFileArg } | { ok: false; error: string };

const HOST_ID_SHAPE = /^[A-Za-z0-9_-]+$/;
const SSH_USER_SHAPE = /^[A-Za-z0-9._-]+$/;
export const REMOTE_PATH_CHARSET = /^[A-Za-z0-9._/-]+$/;

/** The FR-4 short closed named deny list (dot-directory segments). */
export const DENIED_SEGMENTS = [".openrig", ".ssh", ".codex", ".claude"] as const;

export function parseFilePathArg(raw: string): FileArgParse {
  if (raw === "") return { ok: false, error: "empty path operand" };
  if (raw.startsWith("-")) {
    // G18-P1 belt: a flag-shaped operand is refused outright; the ./ escape
    // is the honest way to address such a file.
    return {
      ok: false,
      error: `path operand '${raw}' begins with '-' and could be mistaken for an option. If this is a real local file, address it with the ./ prefix (./${raw}).`,
    };
  }
  // Local-prefix escapes: these are ALWAYS local, colon or not (N18-1).
  if (raw.startsWith("/") || raw.startsWith("./") || raw.startsWith("../") || raw.startsWith("~")) {
    return { ok: true, arg: { kind: "local", path: raw } };
  }
  const colon = raw.indexOf(":");
  if (colon >= 0) {
    const prefix = raw.slice(0, colon);
    const rest = raw.slice(colon + 1);
    if (HOST_ID_SHAPE.test(prefix)) {
      // Id-shaped prefix: this IS a host qualifier — it must resolve or the
      // command fails loudly (fail-closed; never a silent local fallback).
      if (rest === "") return { ok: false, error: `remote path missing after '${prefix}:' — expected ${prefix}:<absolute-path>` };
      return { ok: true, arg: { kind: "remote", hostId: prefix, path: rest } };
    }
    // Non-id-shaped prefix (contains '/', empty, etc.): scp's lived
    // behavior — the whole operand is a local path.
    return { ok: true, arg: { kind: "local", path: raw } };
  }
  return { ok: true, arg: { kind: "local", path: raw } };
}

// ── the deny wall + normalization ──────────────────────────────────────────

function expandLocalTilde(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

export type PathCheck = { ok: true; normalizedPath: string } | { ok: false; error: string };

/** Local side: ~-expand, resolve (traversal collapses here), then deny-check
 *  the RESOLVED form. The resolved form is what rsync receives. */
export function checkLocalPath(raw: string): PathCheck {
  const resolved = path.resolve(expandLocalTilde(raw));
  const home = os.homedir();
  const activeOpenRigHome = path.resolve(getOpenRigHome());
  const activeHostsRegistry = path.resolve(getDefaultOpenRigPath("hosts.yaml"));
  if (resolved === activeHostsRegistry) {
    return {
      ok: false,
      error: `refused: '${raw}' resolves to the active hosts registry (${activeHostsRegistry}) — the registry itself is not a copy source/target in v0. This is the FR-4 default-deny wall (live OpenRig state; extension requires a ruling).`,
    };
  }
  for (const segment of DENIED_SEGMENTS) {
    const deniedRoot = path.join(home, segment);
    if (resolved === deniedRoot || resolved.startsWith(deniedRoot + path.sep)) {
      return {
        ok: false,
        error: `refused: '${raw}' resolves into ${deniedRoot} — ${segment === ".openrig" ? "live OpenRig state (incl. the hosts registry) is not a copy source/target in v0 (crash-safety)" : "credential/agent-home directories are not copy sources/targets"}. This is the FR-4 default-deny wall (a short closed list; extension requires a ruling).`,
      };
    }
  }
  if (
    activeOpenRigHome !== path.join(home, ".openrig") &&
    (resolved === activeOpenRigHome || resolved.startsWith(activeOpenRigHome + path.sep))
  ) {
    return {
      ok: false,
      error: `refused: '${raw}' resolves into the active OPENRIG_HOME (${activeOpenRigHome}) — live OpenRig state is not a copy source/target in v0 (crash-safety). This is the FR-4 default-deny wall (a short closed list; extension requires a ruling).`,
    };
  }
  // rsync distinguishes a directory from its contents by the source's trailing separator.
  const normalizedPath = raw.endsWith(path.sep) && !resolved.endsWith(path.sep)
    ? resolved + path.sep : resolved;
  return { ok: true, normalizedPath };
}

/** Remote side: posix-normalize, then the wall — absolute-only (arch Q5),
 *  no surviving traversal, the shell-inert charset (G18-P3), and the
 *  denied-segment list. Errors TEACH (offending char + workaround). */
export function checkRemotePath(raw: string, hostId: string): PathCheck {
  const charsetViolation = [...raw].find((ch) => !REMOTE_PATH_CHARSET.test(ch));
  if (charsetViolation !== undefined) {
    const shown = charsetViolation === " " ? "a space" : `'${charsetViolation}'`;
    return {
      ok: false,
      error: `refused: remote path for '${hostId}' contains ${shown}, which is outside the v0 remote-path character set [A-Za-z0-9._/-]. v0 keeps remote paths shell-inert by construction${charsetViolation === " " ? " — use a space-free staging path and rename on the far side" : ""}. (v0-conservative; widening is a ruling.)`,
    };
  }
  if (!raw.startsWith("/")) {
    return { ok: false, error: `refused: remote paths are ABSOLUTE-only in v0 (got '${raw}' for host '${hostId}') — remote ~/relative resolution would smuggle in remote-side semantics. Use the full path.` };
  }
  // G18-C1 (guard code-review): the RAW path is checked for '..' BEFORE
  // normalization — posix.normalize fully COLLAPSES '..' in absolute paths
  // (/srv/../../etc/passwd → /etc/passwd), so a post-normalize "surviving
  // .." check is dead code and the climb escapes silently. In an
  // absolute-only grammar a '..' segment is never necessary; ANY '..'
  // rejects outright (no benign/escaping distinction — remote symlinks
  // make that unreasonable to judge from here).
  if (raw.split("/").includes("..")) {
    return { ok: false, error: `refused: remote path '${raw}' contains a '..' traversal segment (FR-4). Remote paths are absolute-only — write the final path without '..'.` };
  }
  const normalized = path.posix.normalize(raw);
  for (const part of normalized.split("/")) {
    if ((DENIED_SEGMENTS as readonly string[]).includes(part)) {
      return {
        ok: false,
        error: `refused: remote path '${raw}' contains the denied directory segment '${part}' (credential/rig-state class; conservative-over-broad by design — FR-4's short closed list).`,
      };
    }
  }
  return { ok: true, normalizedPath: normalized };
}

// ── planning ────────────────────────────────────────────────────────────────

export interface CopySide {
  kind: "local" | "remote";
  /** Normalized path (resolved local / posix-normalized remote). */
  path: string;
  /** Present on remote sides. */
  host?: SshHostEntry;
}

export interface CopyPlan {
  src: CopySide;
  dst: CopySide;
  dryRun: boolean;
}

export type PlanResult = { ok: true; plan: CopyPlan } | { ok: false; error: string; code: string };

export interface PlanDeps {
  registryLoader?: typeof loadHostRegistry;
}

function resolveRemoteSide(hostId: string, rawPath: string, deps: PlanDeps): { ok: true; side: CopySide } | { ok: false; error: string; code: string } {
  const loader = deps.registryLoader ?? loadHostRegistry;
  const reg = loader();
  if (!reg.ok) return { ok: false, error: reg.error, code: "registry_error" };
  const resolved = resolveHost(reg.registry, hostId);
  if (!resolved.ok) return { ok: false, error: resolved.error, code: "unknown_host" };
  if (resolved.host.transport !== "ssh") {
    return {
      ok: false,
      error: `host '${hostId}' uses transport '${resolved.host.transport}' — v0 file movement is ssh/rsync only. Register an ssh entry for this host or move the file another way.`,
      code: "unsupported_transport",
    };
  }
  if (resolved.host.user !== undefined && !SSH_USER_SHAPE.test(resolved.host.user)) {
    return { ok: false, error: `registry entry '${hostId}' has a user field outside [A-Za-z0-9._-] — refusing to place it on an ssh command line`, code: "invalid_registry_user" };
  }
  const pathCheck = checkRemotePath(rawPath, hostId);
  if (!pathCheck.ok) return { ok: false, error: pathCheck.error, code: "denied_path" };
  return { ok: true, side: { kind: "remote", path: pathCheck.normalizedPath, host: resolved.host } };
}

/** Validate the whole invocation — EVERY rejection here happens before any
 *  spawn (the fail-closed set; spawn-spy-asserted in tests). */
export function planFileCopy(rawSrc: string, rawDst: string, opts: { dryRun?: boolean } & PlanDeps = {}): PlanResult {
  const srcParse = parseFilePathArg(rawSrc);
  if (!srcParse.ok) return { ok: false, error: srcParse.error, code: "bad_operand" };
  const dstParse = parseFilePathArg(rawDst);
  if (!dstParse.ok) return { ok: false, error: dstParse.error, code: "bad_operand" };

  if (srcParse.arg.kind === "remote" && dstParse.arg.kind === "remote") {
    return { ok: false, error: "remote-to-remote is not in v0; pull then push (two explicit transfers — never a silent relay through this host)", code: "remote_to_remote" };
  }

  const sides: CopySide[] = [];
  for (const parsed of [srcParse.arg, dstParse.arg]) {
    if (parsed.kind === "remote") {
      const side = resolveRemoteSide(parsed.hostId, parsed.path, opts);
      if (!side.ok) return { ok: false, error: side.error, code: side.code };
      sides.push(side.side);
    } else {
      const check = checkLocalPath(parsed.path);
      if (!check.ok) return { ok: false, error: check.error, code: "denied_path" };
      sides.push({ kind: "local", path: check.normalizedPath });
    }
  }
  return { ok: true, plan: { src: sides[0]!, dst: sides[1]!, dryRun: opts.dryRun === true } };
}

// ── the CLOSED argv builder ─────────────────────────────────────────────────

function sideOperand(side: CopySide): string {
  if (side.kind === "local") return side.path;
  return `${side.host!.target}:${side.path}`;
}

/** The ONLY place rsync arguments are assembled. Properties (test-asserted):
 *  no deletion-class flag ever present; NO -s/--protect-args (uniform argv
 *  across GNU rsync and openrsync — the G18-P3 absence pin); `--` ALWAYS
 *  precedes the two path operands; option positions are fixed. */
export function buildRsyncArgv(plan: CopyPlan): string[] {
  const argv = ["--archive", "--itemize-changes", "--stats"];
  if (plan.dryRun) argv.push("--dry-run");
  const remote = plan.src.kind === "remote" ? plan.src : plan.dst.kind === "remote" ? plan.dst : null;
  if (remote) {
    const sshParts = ["ssh", "-o", "ConnectTimeout=10"];
    if (remote.host!.user) sshParts.push("-l", remote.host!.user);
    argv.push("-e", sshParts.join(" "));
  }
  argv.push("--", sideOperand(plan.src), sideOperand(plan.dst));
  return argv;
}

// ── execution + classification ──────────────────────────────────────────────

export type FileCopyFailedStep = "none" | "rsync-missing" | "permission-gate" | "ssh-unreachable" | "remote-command-failed";

export interface FileCopyResult {
  ok: boolean;
  failedStep: FileCopyFailedStep;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** Parsed from rsync --stats when available. */
  bytesTransferred?: number;
  filesTransferred?: number;
  hint?: string;
}

type SpawnFn = typeof nodeSpawn;

const CONNECTION_FAILURE_PATTERNS = [
  /connection refused/i,
  /connection timed out/i,
  /connection unexpectedly closed/i,
  /could not resolve hostname/i,
  /no route to host/i,
  /operation timed out/i,
];

function parseStats(stdout: string): { bytesTransferred?: number; filesTransferred?: number } {
  const bytes = stdout.match(/Total transferred file size:\s*([\d,.]+)\s*bytes/i);
  const files = stdout.match(/Number of (?:regular )?files transferred:\s*([\d,.]+)/i);
  const num = (m: RegExpMatchArray | null) => (m ? Number(m[1]!.replace(/[,.](?=\d{3})/g, "").replace(/,/g, "")) : undefined);
  return { bytesTransferred: num(bytes), filesTransferred: num(files) };
}

/** rsync's classes are the executor taxonomy MINUS remote-daemon-unreachable
 *  (rsync needs no daemon — arch ruling 2). */
export function classifyRsyncResult(exitCode: number | null, stdout: string, stderr: string): FileCopyResult {
  if (exitCode === 0) {
    return { ok: true, failedStep: "none", exitCode, stdout, stderr, ...parseStats(stdout) };
  }
  if (looksLikePermissionGate(stderr)) {
    return {
      ok: false,
      failedStep: "permission-gate",
      exitCode,
      stdout,
      stderr,
      hint: "Check the registered host/user and the SSH error. For authentication errors, inspect availability of the intended key, agent or Keychain in this process. For host-key or signature-algorithm errors, confirm the expected fingerprint or supported key type with the host owner; keep host verification enabled.",
    };
  }
  if (exitCode === 255 || CONNECTION_FAILURE_PATTERNS.some((re) => re.test(stderr))) {
    return { ok: false, failedStep: "ssh-unreachable", exitCode, stdout, stderr };
  }
  return { ok: false, failedStep: "remote-command-failed", exitCode, stdout, stderr };
}

export async function runFileCopy(plan: CopyPlan, deps: { spawn?: SpawnFn } = {}): Promise<FileCopyResult> {
  const argv = buildRsyncArgv(plan);
  const spawn = deps.spawn ?? nodeSpawn;
  const child = spawn("rsync", argv, { stdio: ["ignore", "pipe", "pipe"] });

  let stdout = "";
  let stderr = "";
  const stdoutDecoder = new StringDecoder("utf8");
  const stderrDecoder = new StringDecoder("utf8");
  let spawnFailed: NodeJS.ErrnoException | null = null;
  child.stdout?.on("data", (chunk: Buffer | string) => {
    stdout += typeof chunk === "string" ? chunk : stdoutDecoder.write(chunk);
  });
  child.stderr?.on("data", (chunk: Buffer | string) => {
    stderr += typeof chunk === "string" ? chunk : stderrDecoder.write(chunk);
  });

  const exitCode: number | null = await new Promise((resolve) => {
    child.on("error", (err: NodeJS.ErrnoException) => {
      spawnFailed = err;
      resolve(null);
    });
    child.on("close", (code: number | null) => resolve(code));
  });

  stdout += stdoutDecoder.end();
  stderr += stderrDecoder.end();
  if (spawnFailed !== null && (spawnFailed as NodeJS.ErrnoException).code === "ENOENT") {
    return {
      ok: false,
      failedStep: "rsync-missing",
      exitCode: null,
      stdout,
      stderr,
      hint: "rsync is not installed locally. macOS: `brew install rsync` (or use the system openrsync ≥ the one shipped with your OS); Linux: install the rsync package.",
    };
  }
  return classifyRsyncResult(exitCode, stdout, stderr);
}
