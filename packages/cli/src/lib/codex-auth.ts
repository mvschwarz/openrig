// OPR.0.4.1.29 — rig auth secret-safe core (CLI-LOCAL / daemon-free).
//
// This module operates directly on the operator's Codex auth files under CODEX_HOME and is invoked
// only from the `rig auth` CLI command — it NEVER touches the daemon, so a token can never enter the
// daemon queue / SSE stream / SQLite / event log (never-queued/never-streamed is true BY CONSTRUCTION).
//
// SECRET INVARIANTS (non-negotiable): no auth/refresh/access token value is ever returned in, or used
// to build, any human-facing string. Functions return STRUCTURED, non-secret result objects
// (presence / mode / parseability / login-state / names / counts); the auth FILE is snapshotted as a
// file (mode-guarded byte copy), never read into a printed value. CODEX_HOME defaults to $HOME/.codex
// and is env-overridable (tests point it at a fixture); no personal/operator path is baked in.
import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

/** Strict profile-name whitelist: alnum-led, then [A-Za-z0-9._-], 1..64 chars. Excludes /, \, ~,
 *  leading dot, whitespace, control, and shell metacharacters. Fail closed. */
const PROFILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function validateProfileName(name: unknown): name is string {
  return typeof name === "string" && name.length > 0 && name.length <= 64 && PROFILE_NAME_RE.test(name);
}

export interface CodexAuthPaths {
  /** Codex state dir — CODEX_HOME or $HOME/.codex. */
  codexHome: string;
  /** Saved-profile dir (0700). */
  profileDir: string;
  /** Active auth file the Codex CLI reads (0600). */
  activeAuth: string;
  /** Product-native seat->profile metadata registry (0600). */
  registryPath: string;
}

/** Resolve the Codex paths from an env map (default process.env). CODEX_HOME wins; else $HOME/.codex. */
export function resolveCodexHome(env: NodeJS.ProcessEnv = process.env): CodexAuthPaths {
  const codexHome =
    typeof env.CODEX_HOME === "string" && env.CODEX_HOME.length > 0
      ? env.CODEX_HOME
      : path.join(env.HOME ?? "", ".codex");
  return {
    codexHome,
    profileDir: path.join(codexHome, "auth-profiles"),
    activeAuth: path.join(codexHome, "auth.json"),
    registryPath: path.join(codexHome, "auth-seat-registry.tsv"),
  };
}

// --- secret-safe fs helpers (no contents ever read into a returned/printed value) ---

function lstatSafe(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

function isDir(p: string): boolean {
  const st = lstatSafe(p);
  return st !== null && st.isDirectory();
}

function isFile(p: string): boolean {
  const st = lstatSafe(p);
  return st !== null && st.isFile();
}

/** Octal permission string (e.g. "600") or null when the path is absent/unstatable. */
function fileModeOctal(p: string): string | null {
  const st = lstatSafe(p);
  if (st === null) return null;
  return (st.mode & 0o777).toString(8).padStart(3, "0");
}

/** A profile file is safe iff it exists, is a regular file (not a symlink — which could redirect us
 *  out of the profile dir), has link count 1 (a hardlink shares an inode that may live outside the
 *  profile dir), and lives directly in profileDir. */
function isSafeProfileFile(p: string, profileDir: string): boolean {
  const st = lstatSafe(p);
  if (st === null || st.isSymbolicLink() || !st.isFile() || st.nlink !== 1) return false;
  return path.dirname(p) === profileDir;
}

/** True iff `dir` really resolves INSIDE realpath(codexHome). realpath follows every symlink in the
 *  chain, so a symlinked parent (e.g. an auth-profiles dir pointing outside) resolves out and is
 *  rejected — a lexical startsWith would be fooled. Returns false if either path can't be resolved. */
function realDirContained(dir: string, codexHome: string): boolean {
  try {
    const root = fs.realpathSync(codexHome);
    const resolved = fs.realpathSync(dir);
    return resolved === root || resolved.startsWith(root + path.sep);
  } catch {
    return false;
  }
}

/** A destination we are about to write SECRET bytes onto is safe to replace iff it is absent, or a
 *  regular file (not a symlink) with link count 1. A symlink redirects the write; a hardlink (nlink>1)
 *  shares an inode that may live outside CODEX_HOME — writing through either leaks secret bytes out. */
function destReplaceable(p: string): boolean {
  const st = lstatSafe(p);
  if (st === null) return true;
  return !st.isSymbolicLink() && st.isFile() && st.nlink === 1;
}

/** fd-first copy of `source` onto `dest` (OPR.0.4.3.23 secret-boundary B1 hardening). Closes the
 *  check-then-use gap that a path-based copy leaves open: an earlier lstat guard, then a copy that
 *  re-resolves the SOURCE PATH, can be redirected by an inode swap in the window (a crash, or a
 *  concurrent legitimate rig on the same auth home) — reading the wrong inode, a torn file, or briefly
 *  leaving a wider-than-0600 temp (CERT FIO45-C). Path-based pre-checks cannot close that race, so the
 *  authoritative check moves onto the OPENED fd:
 *   (1) SOURCE: openSync with O_NOFOLLOW (a final-component symlink swap fails closed), then fstat ON
 *       THE FD and validate the opened inode (regular file, nlink === 1 — a hardlink shares an inode
 *       that may live outside the boundary), and — when the caller passes its earlier lstat — confirm
 *       dev/ino still match (the inode was not swapped in the window). Read bytes FROM the fd; the
 *       source path is never re-resolved after the open.
 *   (2) DEST: openSync the temp with O_CREAT|O_EXCL (fresh inode; never a pre-existing hardlink/symlink)
 *       at 0600 AT creation (removes the create-then-chmod window), fchmod on the fd to pin 0600
 *       regardless of umask, write the source bytes, fsync, then renameSync as the SOLE atomic publish
 *       (a crash BEFORE the rename leaves the prior dest byte-intact — a strength we preserve).
 *  The temp stays co-located in dest's dir so the rename never crosses devices. The transient byte
 *  buffer is the only time secret bytes touch JS memory; it is never printed and is scrubbed in
 *  `finally`. Caller must still have verified dest's parent containment and that dest is replaceable
 *  (the lstat pre-checks stay as cheap fail-fast; this fd validation is the authoritative layer).
 *  Exported for the fd-first / crash-safety leak-hunt tests. */
export function copyOntoFresh(
  source: string,
  dest: string,
  expectSrc?: { dev: number; ino: number },
): boolean {
  const tmp = `${dest}.tmp-${process.pid}`;
  // O_NOFOLLOW fails the open closed if a final-component symlink was swapped in. (O_CLOEXEC is omitted:
  // it is undefined on macOS Node and absent from @types/node, and no child process is spawned during
  // this fd's synchronous lifetime, so close-on-exec would be a no-op here.)
  const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
  let srcFd = -1;
  let destFd = -1;
  let data: Buffer | null = null;
  try {
    try {
      fs.rmSync(tmp, { force: true }); // clear any stale temp so the O_EXCL create below succeeds
    } catch {
      /* ignore */
    }
    // (1) fd-first source read: open, then validate ON THE FD — never re-resolve the source path.
    srcFd = fs.openSync(source, fs.constants.O_RDONLY | NOFOLLOW);
    const st = fs.fstatSync(srcFd);
    if (!st.isFile() || st.nlink !== 1) return false; // authoritative: regular file, single link
    if (expectSrc && (st.dev !== expectSrc.dev || st.ino !== expectSrc.ino)) return false; // swapped in the window
    const size = st.size;
    data = Buffer.allocUnsafe(size);
    let read = 0;
    while (read < size) {
      const n = fs.readSync(srcFd, data, read, size - read, read);
      if (n === 0) break;
      read += n;
    }
    if (read !== size) return false; // torn/truncated read (the source changed under us) → fail safe
    // (2) fd-first dest temp: fresh inode (O_EXCL), 0600 AT creation, byte-copy, fsync, atomic rename.
    destFd = fs.openSync(tmp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | NOFOLLOW, 0o600);
    fs.fchmodSync(destFd, 0o600); // pin 0600 on the fd regardless of umask (no path chmod window)
    let written = 0;
    while (written < size) {
      written += fs.writeSync(destFd, data, written, size - written);
    }
    fs.fsyncSync(destFd); // durability before the sole atomic publish
    fs.closeSync(destFd);
    destFd = -1;
    fs.renameSync(tmp, dest); // atomic dir-entry swap; any old dest inode is unlinked, never written
    return true;
  } catch {
    return false;
  } finally {
    if (srcFd >= 0) {
      try {
        fs.closeSync(srcFd);
      } catch {
        /* ignore */
      }
    }
    if (destFd >= 0) {
      try {
        fs.closeSync(destFd);
      } catch {
        /* ignore */
      }
    }
    if (data) data.fill(0); // scrub the secret bytes out of the transient JS buffer
    try {
      fs.rmSync(tmp, { force: true }); // remove any orphan temp (no-op after a successful rename)
    } catch {
      /* ignore */
    }
  }
}

function countProfiles(profileDir: string): number {
  try {
    return fs.readdirSync(profileDir).filter((n) => n.endsWith(".json") && isFile(path.join(profileDir, n))).length;
  } catch {
    return 0;
  }
}

/** True iff the string contains a control character (<=0x1f or 0x7f), incl. tab/newline/CR which would
 *  corrupt a TSV row. Printable chars (spaces, hyphens, '@', '/') are allowed. Regex-free on purpose. */
function hasControlChar(v: string): boolean {
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) return true;
  }
  return false;
}

export interface CodexAuthDeps {
  /** Resolve the Codex login state using EXIT CODE ONLY — never the external command's stdout/stderr
   *  (any future codex version could print a token there). Default: spawn `codex login status` with
   *  stdio ignored and map the exit code. Injectable for hermetic tests. */
  loginStatus?: (codexHome: string) => "logged_in" | "not_logged_in" | "unavailable";
}

/** Default login-state probe: exit code only, output never captured (stdio: ignore = no leak path). */
function defaultLoginStatus(codexHome: string): "logged_in" | "not_logged_in" | "unavailable" {
  const r = spawnSync("codex", ["login", "status"], {
    stdio: "ignore",
    env: { ...process.env, CODEX_HOME: codexHome },
  });
  if (r.error) return "unavailable";
  return r.status === 0 ? "logged_in" : "not_logged_in";
}

export interface AuthStatusResult {
  codexHome: string;
  codexHomePresent: boolean;
  profileDirPresent: boolean;
  activeAuthPresent: boolean;
  activeAuthMode: string | null;
  activeAuthModeSafe: boolean | "unknown";
  profileCount: number;
  loginStatus: "logged_in" | "not_logged_in" | "unavailable";
}

/** Report auth-file presence/mode/safety + profile count + login-state. NEVER reads token contents. */
export function authStatus(paths: CodexAuthPaths, deps: CodexAuthDeps = {}): AuthStatusResult {
  const activeAuthPresent = isFile(paths.activeAuth);
  const activeAuthMode = activeAuthPresent ? fileModeOctal(paths.activeAuth) : null;
  return {
    codexHome: paths.codexHome,
    codexHomePresent: isDir(paths.codexHome),
    profileDirPresent: isDir(paths.profileDir),
    activeAuthPresent,
    activeAuthMode,
    activeAuthModeSafe: activeAuthMode === null ? "unknown" : activeAuthMode === "600",
    profileCount: countProfiles(paths.profileDir),
    loginStatus: (deps.loginStatus ?? defaultLoginStatus)(paths.codexHome),
  };
}

export type AuthValidateResult =
  | { ok: true; name: string; path: string; mode: string }
  | {
      ok: false;
      reason: "invalid_profile" | "missing_profile" | "unsafe_path" | "unsafe_permissions" | "malformed_json" | "parse_check_unavailable";
    };

/** Validate a saved profile: name whitelist -> safe regular file -> 0600 -> JSON parseable. The
 *  parse is in-memory and the result is discarded; on failure we return a FIXED reason and never the
 *  JSON.parse error (its message can include a snippet of the file = a secret). */
export function authValidate(paths: CodexAuthPaths, name: string): AuthValidateResult {
  if (!validateProfileName(name)) return { ok: false, reason: "invalid_profile" };
  const target = path.join(paths.profileDir, `${name}.json`);
  if (lstatSafe(target) === null) return { ok: false, reason: "missing_profile" };
  // Safe regular file (no symlink/hardlink) AND a profile dir that really resolves inside CODEX_HOME.
  if (!isSafeProfileFile(target, paths.profileDir) || !realDirContained(paths.profileDir, paths.codexHome)) {
    return { ok: false, reason: "unsafe_path" };
  }
  if (fileModeOctal(target) !== "600") return { ok: false, reason: "unsafe_permissions" };
  let content: string;
  try {
    content = fs.readFileSync(target, "utf8");
  } catch {
    return { ok: false, reason: "parse_check_unavailable" };
  }
  try {
    JSON.parse(content);
  } catch {
    // Intentionally ignore the error object — its message can echo file content (a secret).
    return { ok: false, reason: "malformed_json" };
  }
  return { ok: true, name, path: target, mode: "600" };
}

export type AuthSaveResult =
  | { ok: true; name: string; path: string; mode: string }
  | { ok: false; reason: "invalid_profile" | "not_configured" | "unsafe_path" | "io_error" };

/** Snapshot the active auth file into a named profile (0600 file in the 0700 profile dir). Byte-copy
 *  via copyFileSync — contents never enter JS memory; result reports name/path/mode only. */
export function authSave(paths: CodexAuthPaths, name: string): AuthSaveResult {
  if (!validateProfileName(name)) return { ok: false, reason: "invalid_profile" };
  const srcStat = lstatSafe(paths.activeAuth);
  if (srcStat === null || !srcStat.isFile()) return { ok: false, reason: "not_configured" };
  const target = path.join(paths.profileDir, `${name}.json`);
  // Refuse a symlinked profile-dir BEFORE mkdir/chmod so we never follow it out of CODEX_HOME or
  // mutate the outside target's mode.
  const pdStat = lstatSafe(paths.profileDir);
  if (pdStat !== null && pdStat.isSymbolicLink()) return { ok: false, reason: "unsafe_path" };
  try {
    fs.mkdirSync(paths.profileDir, { recursive: true });
    fs.chmodSync(paths.profileDir, 0o700);
  } catch {
    return { ok: false, reason: "io_error" };
  }
  // Parent must REALLY resolve inside CODEX_HOME (defeats a symlinked auth-profiles parent), and the
  // existing target must not be a symlink/hardlink/non-regular file (defeats writing secret bytes
  // through an inode that lives outside CODEX_HOME).
  if (!realDirContained(paths.profileDir, paths.codexHome)) return { ok: false, reason: "unsafe_path" };
  if (!destReplaceable(target)) return { ok: false, reason: "unsafe_path" };
  // Thread the earlier lstat so copyOntoFresh can confirm the opened fd is still the same inode
  // (dev/ino) it was checked as — a swap of the active auth in the check-then-use window fails safe.
  if (!copyOntoFresh(paths.activeAuth, target, { dev: srcStat.dev, ino: srcStat.ino })) return { ok: false, reason: "io_error" };
  return { ok: true, name, path: target, mode: "600" };
}

export type AuthSwitchResult =
  | { ok: true; name: string; activePath: string; mode: string; note: string }
  | { ok: false; reason: "invalid_profile" | "missing_profile" | "unsafe_path" | "unsafe_permissions" | "io_error" };

/** Activate a saved profile (copy it onto the active auth at 0600). Refuses to widen perms over an
 *  existing unsafe active file. Byte-copy; no content echoed. */
export function authSwitch(paths: CodexAuthPaths, name: string): AuthSwitchResult {
  if (!validateProfileName(name)) return { ok: false, reason: "invalid_profile" };
  const source = path.join(paths.profileDir, `${name}.json`);
  const srcStat = lstatSafe(source);
  if (srcStat === null) return { ok: false, reason: "missing_profile" };
  if (!isSafeProfileFile(source, paths.profileDir)) return { ok: false, reason: "unsafe_path" };
  // Destination guard: a symlink/non-regular OR hardlinked (nlink>1) active auth would let the copy
  // write the selected profile's SECRET bytes THROUGH an inode living outside CODEX_HOME. Refuse it
  // (isFile() is false for a symlink, so the old isFile-gated check silently missed both cases).
  if (!destReplaceable(paths.activeAuth)) return { ok: false, reason: "unsafe_path" };
  if (isFile(paths.activeAuth)) {
    const m = fileModeOctal(paths.activeAuth);
    if (m !== null && m !== "600") return { ok: false, reason: "unsafe_permissions" };
  }
  try {
    fs.mkdirSync(paths.codexHome, { recursive: true });
  } catch {
    return { ok: false, reason: "io_error" };
  }
  if (!realDirContained(paths.codexHome, paths.codexHome)) return { ok: false, reason: "unsafe_path" };
  // dev/ino continuity: the opened profile fd must still be the inode we checked (swap in the window fails safe).
  if (!copyOntoFresh(source, paths.activeAuth, { dev: srcStat.dev, ino: srcStat.ino })) return { ok: false, reason: "io_error" };
  return {
    ok: true,
    name,
    activePath: paths.activeAuth,
    mode: "600",
    note: "live Codex sessions do not switch accounts in place; restart the affected seats to pick up the new profile.",
  };
}

/** List saved profile names (safe regular *.json files in the profile dir), sorted. No contents read.
 *  Refuses to list through a symlinked / out-of-tree profile dir (returns []), so a redirected parent
 *  never exposes file names from outside CODEX_HOME. */
export function authList(paths: CodexAuthPaths): string[] {
  if (!realDirContained(paths.profileDir, paths.codexHome)) return [];
  try {
    return fs
      .readdirSync(paths.profileDir)
      .filter((n) => n.endsWith(".json") && isSafeProfileFile(path.join(paths.profileDir, n), paths.profileDir))
      .map((n) => n.slice(0, -".json".length))
      .sort();
  } catch {
    return [];
  }
}

// --- Auth-B: seat -> profile METADATA registry (product-native; NO resume_token per orch D2) ---

/** Stated in command output + docs: a seat label is metadata, never proof of a live account. */
export const SEAT_REGISTRY_DISCLAIMER =
  "Seat labels are metadata only; they do NOT prove a running session is actually using that account/profile.";

// 6 columns; NO resume_token (a print surface is the worst place to hold a secret-class token).
const SEAT_COLUMNS = ["seat", "rig", "runtime", "cwd", "auth_profile", "updated_ts"] as const;
const SEAT_HEADER = SEAT_COLUMNS.join("\t");
const SEAT_TAB_COUNT = SEAT_COLUMNS.length - 1;

export interface SeatRow {
  seat: string;
  rig: string;
  runtime: string;
  cwd: string;
  authProfile: string;
  updatedTs: string;
}

export interface SeatSetFields {
  seat: string;
  rig: string;
  runtime: string;
  cwd?: string;
  authProfile?: string;
}

function isSafeRegistryFile(p: string): boolean {
  const st = lstatSafe(p);
  return st !== null && !st.isSymbolicLink() && st.isFile();
}

/** Reject empty + any control character (covers tab/newline/CR, which would corrupt the TSV). */
function validRegistryField(v: string): boolean {
  return v.length > 0 && !hasControlChar(v);
}

function rawRegistryLines(registryPath: string): string[] {
  let text: string;
  try {
    text = fs.readFileSync(registryPath, "utf8");
  } catch {
    return [];
  }
  const out: string[] = [];
  let first = true;
  for (const line of text.split("\n")) {
    if (line === "" || line.startsWith("#")) continue;
    if (first) {
      first = false; // skip header
      continue;
    }
    out.push(line);
  }
  return out;
}

function rowMalformed(line: string): boolean {
  const tabs = (line.match(/\t/g) ?? []).length;
  if (tabs !== SEAT_TAB_COUNT) return true;
  return line.split("\t")[0] === "";
}

function parseRow(line: string): SeatRow {
  // Callers pre-filter via rowMalformed (guaranteed 6 fields); ?? "" satisfies strict indexing.
  const f = line.split("\t");
  return {
    seat: f[0] ?? "",
    rig: f[1] ?? "",
    runtime: f[2] ?? "",
    cwd: f[3] ?? "",
    authProfile: f[4] ?? "",
    updatedTs: f[5] ?? "",
  };
}

export type SeatSetResult =
  | { ok: true; seat: string; registryPath: string; mode: string; disclaimer: string }
  | { ok: false; reason: "invalid_seat" | "invalid_rig" | "invalid_runtime" | "invalid_cwd" | "invalid_profile" | "unsafe_path" | "io_error" };

/** Atomic upsert of a seat metadata row (tmp + rename). Drops pre-existing malformed rows rather than
 *  re-emitting fabricated metadata. `now` is injectable for deterministic tests. */
export function authSeatSet(
  paths: CodexAuthPaths,
  fields: SeatSetFields,
  now: () => string = () => new Date().toISOString(),
): SeatSetResult {
  if (!validRegistryField(fields.seat)) return { ok: false, reason: "invalid_seat" };
  if (!validRegistryField(fields.rig)) return { ok: false, reason: "invalid_rig" };
  if (fields.runtime !== "codex") return { ok: false, reason: "invalid_runtime" }; // v0 whitelist
  const cwd = fields.cwd && fields.cwd.length > 0 ? fields.cwd : "unknown";
  if (!validRegistryField(cwd)) return { ok: false, reason: "invalid_cwd" };
  const profile = fields.authProfile && fields.authProfile.length > 0 ? fields.authProfile : "unknown";
  if (profile !== "unknown" && !validateProfileName(profile)) return { ok: false, reason: "invalid_profile" };

  if (lstatSafe(paths.registryPath) !== null && !isSafeRegistryFile(paths.registryPath)) {
    return { ok: false, reason: "unsafe_path" };
  }
  const kept = rawRegistryLines(paths.registryPath)
    .filter((l) => !rowMalformed(l))
    .filter((l) => l.split("\t")[0] !== fields.seat);
  const newRow = [fields.seat, fields.rig, "codex", cwd, profile, now()].join("\t");
  const body = [SEAT_HEADER, ...kept, newRow].join("\n") + "\n";

  const tmp = `${paths.registryPath}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(paths.registryPath), { recursive: true });
    fs.writeFileSync(tmp, body, { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, paths.registryPath);
    fs.chmodSync(paths.registryPath, 0o600);
  } catch {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    return { ok: false, reason: "io_error" };
  }
  return { ok: true, seat: fields.seat, registryPath: paths.registryPath, mode: "600", disclaimer: SEAT_REGISTRY_DISCLAIMER };
}

/** List well-formed seat rows (malformed rows skipped). */
export function authSeatsList(paths: CodexAuthPaths): SeatRow[] {
  return rawRegistryLines(paths.registryPath)
    .filter((l) => !rowMalformed(l))
    .map(parseRow);
}

export type SeatShowResult = { ok: true; row: SeatRow } | { ok: false; reason: "invalid_seat" | "missing_seat" | "unsafe_path" };

export function authSeatShow(paths: CodexAuthPaths, seat: string): SeatShowResult {
  if (!validRegistryField(seat)) return { ok: false, reason: "invalid_seat" };
  if (lstatSafe(paths.registryPath) !== null && !isSafeRegistryFile(paths.registryPath)) {
    return { ok: false, reason: "unsafe_path" };
  }
  const row = authSeatsList(paths).find((r) => r.seat === seat);
  return row ? { ok: true, row } : { ok: false, reason: "missing_seat" };
}

export interface SeatsReport {
  registryPresent: boolean;
  registryMode: string | null;
  registryModeSafe: boolean | "unknown";
  total: number;
  known: number;
  unknown: number;
  malformed: number;
}

export function authSeatsReport(paths: CodexAuthPaths): SeatsReport {
  const present = isFile(paths.registryPath);
  const mode = present ? fileModeOctal(paths.registryPath) : null;
  let total = 0;
  let known = 0;
  let unknown = 0;
  let malformed = 0;
  for (const line of rawRegistryLines(paths.registryPath)) {
    if (rowMalformed(line)) {
      malformed += 1;
      continue;
    }
    total += 1;
    const profile = line.split("\t")[4];
    if (!profile || profile === "unknown") unknown += 1;
    else known += 1;
  }
  return {
    registryPresent: present,
    registryMode: mode,
    registryModeSafe: mode === null ? "unknown" : mode === "600",
    total,
    known,
    unknown,
    malformed,
  };
}
