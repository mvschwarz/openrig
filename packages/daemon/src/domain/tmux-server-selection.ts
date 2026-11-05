import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { execArgvCommand } from "../adapters/tmux-exec.js";
import { tmuxServerArgs } from "../adapters/tmux-server.js";
import { readPlatformEnv } from "./platform-env.js";

export type TmuxServerMode = "inherit" | "isolated";

export interface TmuxServerSelection {
  requestedMode: TmuxServerMode;
  mode: TmuxServerMode;
  socketPath?: string;
  /** Attachment metadata: inherited non-default servers still need their flags. */
  serverArgs: string[];
  /** Native commands inherit normally unless isolation requires a fixed server. */
  executionArgs: string[];
  migrationPending: boolean;
  blockingSessions: string[];
  note?: string;
}

interface ServerRecord {
  version: 1;
  home: string;
  mode: TmuxServerMode;
  pinned: boolean;
  socketPath: string;
  isolatedSocketPath?: string;
}

// Unlike the old "1" marker (also written by inherit), this denotes an active
// explicit selection. The record remains the authority for a completed opt-out.
const PINNED_MARKER = "openrig-tmux-pinned-v1\n";

export type ServerInspection =
  | { state: "available"; sessions: Array<{ name: string; home?: string }> }
  | { state: "absent" }
  | { state: "unavailable" };

interface SelectionOptions {
  home: string;
  mode: TmuxServerMode;
  registeredSessions: readonly string[];
  env?: NodeJS.ProcessEnv;
  /** In-memory compositions do not leave a durable instance record. */
  persist?: boolean;
  platform?: NodeJS.Platform;
  uid?: number;
  inspect?: (socket: string) => Promise<ServerInspection>;
}

function canonical(file: string): string {
  try { return process.platform === "win32" ? fs.realpathSync.native(file) : fs.realpathSync(file); }
  catch (error) {
    const absolute = path.resolve(file), parent = path.dirname(absolute);
    // New homes still inherit the physical spelling of their existing parent;
    // otherwise their socket identity changes after the first mkdir.
    if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "ENOENT" && parent !== absolute) {
      return path.join(canonical(parent), path.basename(absolute));
    }
    return absolute;
  }
}

/** TMUX appends two numeric fields; a socket path itself may contain commas. */
export function inheritedTmuxSocket(env: NodeJS.ProcessEnv, uid: number): string {
  const inherited = env.TMUX?.replace(/,\d+,\d+$/, "");
  if (inherited && path.isAbsolute(inherited)) return inherited;
  return path.join(canonical(env.TMUX_TMPDIR?.trim() || "/tmp"), `tmux-${uid}`, "default");
}

/** psmux accepts both its legacy TMUX path and a native -S path. */
export function inheritedPsmuxSocket(env: NodeJS.ProcessEnv): string {
  const inherited = readPlatformEnv(env, "TMUX", "win32")?.replace(/,\d+,\d+$/, "");
  if (inherited && (path.isAbsolute(inherited) || path.win32.isAbsolute(inherited))) return inherited;
  const root = readPlatformEnv(env, "PSMUX_DATA_DIR", "win32") ?? path.join(readPlatformEnv(env, "USERPROFILE", "win32") || homedir(), ".psmux");
  return path.join(canonical(root || "."), "default");
}

/** Listing the old server is observation only; it never starts or stops a server. */
export async function inspectTmuxServer(socket: string, execute = execArgvCommand): Promise<ServerInspection> {
  try {
    // Outside tmux, a C locale otherwise sanitizes the tab to '_', losing both
    // the names and their ownership. This is a machine-readable protocol.
    // A nonempty suffix preserves an empty owner field in clients that trim lines.
    const suffix = "\topenrig-owner-v1";
    const output = await execute(["tmux", "-u", "-S", socket, "list-sessions", "-F", "#{session_name}\t#{OPENRIG_HOME}" + suffix]);
    const lines = output.split(/\r?\n/).filter(Boolean);
    if (lines.some(line => !line.endsWith(suffix) || !line.slice(0, -suffix.length).includes("\t"))) return { state: "unavailable" };
    return { state: "available", sessions: lines.map(line => {
      const [name, ...home] = line.slice(0, -suffix.length).split("\t");
      const owner = home.join("\t");
      return { name: name!, ...(owner ? { home: owner } : {}) };
    }) };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (!/permission denied|operation not permitted|EACCES|EPERM/i.test(message)
      && (/no server running/i.test(message)
        || (/error connecting to/i.test(message) && /No such file or directory|Connection refused/i.test(message)))) {
      return { state: "absent" };
    }
    return { state: "unavailable" };
  }
}

function readRecord(file: string, home: string): ServerRecord | null {
  let value: unknown;
  try { value = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`Cannot read the tmux server record ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const record = value as Partial<ServerRecord> | null;
  const pinned = record?.pinned === true || record?.mode === "isolated";
  const matchesHome = typeof record?.home === "string" && path.isAbsolute(record.home)
    && (process.platform === "win32" ? canonical(record.home) === home : record.home === home);
  if (!record || record.version !== 1 || !matchesHome
    || !["inherit", "isolated"].includes(record.mode ?? "")
    || (record.pinned !== undefined && typeof record.pinned !== "boolean")
    || (record.mode === "isolated" && record.pinned === false)
    || typeof record.socketPath !== "string" || !path.isAbsolute(record.socketPath) || record.socketPath.includes("\0")
    || (record.isolatedSocketPath !== undefined
      && (typeof record.isolatedSocketPath !== "string" || !path.isAbsolute(record.isolatedSocketPath) || record.isolatedSocketPath.includes("\0")))) {
    throw Object.assign(new Error(`Invalid tmux server record ${file}; inspect it before changing this instance's server.`), { pinned });
  }
  // Legacy isolated records were pinned; legacy inherit records were advisory.
  return { ...record, pinned } as ServerRecord;
}

function readPinMarker(home: string): { active: boolean; legacy?: boolean; error?: Error } {
  const file = path.join(home, "tmux-server.initialized");
  try {
    const value = fs.readFileSync(file, "utf8").trim();
    return { active: value === PINNED_MARKER.trim(), legacy: value === "1" };
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { active: false };
    return { active: false, error: new Error(`Cannot read the tmux pin marker ${file}: ${error instanceof Error ? error.message : String(error)}`) };
  }
}

function atomicWrite(file: string, content: string): void {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, content, { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
  } catch (error) {
    try { fs.unlinkSync(temporary); }
    catch { /* Best effort: preserve the original persistence error. */ }
    throw error;
  }
}

function writeRecord(file: string, record: ServerRecord): void {
  const marker = path.join(record.home, "tmux-server.initialized");
  // Establish pin evidence before the record or any session operation. A completed
  // opt-out commits pinned:false first, then removes that evidence. The caller
  // must not start on another server if either part of a pin transition fails.
  if (record.pinned) atomicWrite(marker, PINNED_MARKER);
  atomicWrite(file, JSON.stringify(record, null, 2) + "\n");
  if (!record.pinned) {
    try { fs.unlinkSync(marker); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

/**
 * Choose once, before reconciliation or launch. A different requested server is
 * deferred while registered sessions survive on the previous one, or while that
 * server cannot be inspected. No pane is moved, restarted or killed here.
 */
export async function selectTmuxServer(options: SelectionOptions): Promise<TmuxServerSelection> {
  const env = options.env ?? process.env;
  const windows = (options.platform ?? process.platform) === "win32";
  const uid = options.uid ?? process.getuid?.();
  if (!windows && uid === undefined) {
    return {
      requestedMode: options.mode, mode: "inherit", serverArgs: [], executionArgs: [],
      migrationPending: options.mode === "isolated", blockingSessions: [],
      ...(options.mode === "isolated" ? { note: "Cannot select a dedicated tmux server without a user identity." } : {}),
    };
  }

  // A new home beneath a symlinked parent must exist before hashing its real path.
  // Normal inheritance still has no writable-home prerequisite.
  if (options.mode === "isolated") fs.mkdirSync(options.home, { recursive: true });
  const home = canonical(options.home);
  const stateFile = path.join(home, "tmux-server.json");
  const marker: ReturnType<typeof readPinMarker> = options.persist === false ? { active: false } : readPinMarker(home);
  let previous: ServerRecord | null = null;
  let readableRecord = true;
  if (options.persist !== false) {
    try { previous = readRecord(stateFile, home); }
    catch (error) {
      if (options.mode === "isolated" || marker.active || marker.error || (error as { pinned?: boolean }).pinned) throw error;
      // Default inheritance never depended on this file. Do not turn an old
      // advisory record into a boot refusal, or overwrite it while unreadable.
      readableRecord = false;
    }
    if (!previous && (marker.active || (marker.legacy && options.mode === "isolated"))) {
      throw new Error(`Missing tmux server record ${stateFile} after server selection; restore it before starting this instance.`);
    }
    if (marker.error && (!previous || previous.pinned || options.mode === "isolated")) throw marker.error;
  }
  const inherited = windows ? inheritedPsmuxSocket(env) : inheritedTmuxSocket(env, uid!);
  const namespace = "openrig-" + createHash("sha256").update(windows ? home.toLowerCase() : home).digest("hex").slice(0, 20);
  const isolated = previous?.isolatedSocketPath
    ?? (windows ? path.join(home, namespace)
      : path.join(canonical(env.TMUX_TMPDIR?.trim() || "/tmp"), `tmux-${uid}`, namespace));
  const desired = options.mode === "isolated" ? isolated : inherited;
  const oldSocket = previous?.socketPath ?? inherited;
  let mode = options.mode;
  let socketPath = desired;
  let migrationPending = false;
  let blockingSessions: string[] = [];
  let note: string | undefined;

  const isolation = options.mode === "isolated" || previous?.pinned;
  if (isolation && oldSocket !== desired && options.registeredSessions.length > 0) {
    const observation = await (options.inspect ?? inspectTmuxServer)(oldSocket);
    const registered = new Set(options.registeredSessions);
    if (observation.state === "available") {
      // Legacy sessions without an owner marker remain conservative blockers.
      // An explicit other home can reuse our canonical names without owning our seats.
      blockingSessions = observation.sessions
        .filter(session => registered.has(session.name) && (!session.home || canonical(session.home) === home))
        .map(session => session.name);
    }
    if (observation.state === "unavailable" || blockingSessions.length > 0) {
      socketPath = oldSocket;
      mode = previous?.mode ?? "inherit";
      migrationPending = true;
      note = observation.state === "unavailable"
        ? "The previous tmux server could not be inspected; it remains selected. Retry the daemon restart when it is reachable."
        : "Registered sessions still use the previous tmux server. Stop those sessions deliberately, then restart the daemon to apply the requested server.";
    }
  }

  const executionArgs = mode === "isolated" || migrationPending ? ["-S", socketPath] : [];
  if (executionArgs.length > 0 && !windows) {
    // -S does not create tmux's usual per-user directory. The inherited path
    // keeps tmux's own directory and length handling, as it did before selection.
    const socketLimit = (options.platform ?? process.platform) === "darwin" ? 104 : 108;
    if (Buffer.byteLength(socketPath) >= socketLimit) {
      throw new Error("The selected tmux socket path is too long. Use a shorter TMUX_TMPDIR before first enabling isolation.");
    }
    fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  }
  if (options.persist !== false && readableRecord) {
    const pinned = executionArgs.length > 0;
    const strict = pinned || previous?.pinned || marker.active;
    try {
      fs.mkdirSync(home, { recursive: true });
      writeRecord(stateFile, { version: 1, home, mode, pinned, socketPath,
        ...(mode === "isolated" ? { isolatedSocketPath: socketPath }
          : previous?.isolatedSocketPath ? { isolatedSocketPath: previous.isolatedSocketPath } : {}) });
    } catch (error) {
      if (strict) throw error;
      // Inherited selection is advisory; an unwritable home must not change it.
    }
  }
  return {
    requestedMode: options.mode, mode, socketPath, executionArgs,
    serverArgs: executionArgs.length > 0 ? [...executionArgs] : windows ? ["-S", inherited] : tmuxServerArgs(env, uid),
    migrationPending, blockingSessions, ...(note ? { note } : {}),
  };
}
