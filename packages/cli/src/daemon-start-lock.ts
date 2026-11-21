import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** #3315 — what the child record carries so a later stop can confirm the reservation still names that process. */
export interface ReservedChildIdentity {
  /** `processStartToken` of the child, read right after the spawn; undefined where the OS gives none. */
  startToken?: string;
  /** The launcher's pid namespace (the reservation's PIDs are numbered in it). */
  pidNamespace?: string;
  /** Where the child was told to listen (the launch's health endpoint). */
  host: string;
  port: number;
}

export interface DaemonStartLock {
  recordChild(pid: number, identity?: ReservedChildIdentity): void;
  release(preserve?: boolean): void;
  /** Where an abandoned reservation (from before this boot, or one whose recorded launcher and child are both
   *  gone) was archived, when this launch did so. */
  archived?: string;
}

export interface StaleLockCheck {
  /** This boot's identity (`currentBootId`), recorded in the reservation; undefined where the OS has none. */
  bootId?: string;
  /** When this machine booted, in ms since the epoch. */
  bootedAtMs: number;
  /** Three-state liveness (`createProcessLiveness`): only "dead" counts as gone. */
  processLiveness: (pid: number) => "alive" | "dead" | "unknown";
  /** This shell's pid namespace ("host" where the OS has none). Without it, no reservation from this boot is archived. */
  pidNamespace?: string;
  /** Test seam: runs after the reservation was inspected and before it is claimed. */
  afterInspect?: () => void;
}

/** One supported local launch owns pre-bind initialization through publication.
 * ponytail: no age-based takeover — a dead launcher can leave a live unbound child.
 * Two exceptions. The first is a reservation from an earlier boot: a reboot ends every process it could name.
 * A reservation that records its boot ID is from an earlier boot when that ID differs from this one's;
 * PIDs don't matter then, since after a reboot they may belong to unrelated processes.
 * One without a boot ID (written by an older CLI) must have been written and last changed before
 * this boot, with every recorded PID positively dead; the PID check covers a clock that jumped after
 * boot, and a PID that can't be inspected keeps the refusal.
 * The second: a reservation from this boot is archived only when it records both a launcher and a child, both are positively
 * dead, and its PIDs are numbered in this shell's pid namespace (one that records none is read as the host's,
 * which only an OS without pid namespaces reports). A live or uninspectable PID, a missing child record (the
 * launcher may have died between the spawn and recording it) or another namespace keeps the refusal. Such a
 * reservation is archived under the name `rig daemon stop` gives a spent one (`archiveSpentReservation`), so a
 * start and a stop that both find it race for one name, and link(2) lets only one of them remove it. */
export function acquireDaemonStartLock(home: string, stale?: StaleLockCheck): DaemonStartLock {
  fs.mkdirSync(home, { recursive: true });
  const file = path.join(home, "daemon-start.lock");
  let fd: number;
  let archived: string | undefined;
  try {
    fd = fs.openSync(file, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    archived = stale ? archiveIfAbandoned(file, stale) : undefined;
    if (!archived) throw reserved(file);
    try {
      fd = fs.openSync(file, "wx", 0o600);
    } catch (retry) {
      // Another launch took the path after this one archived the old reservation: it owns startup.
      if ((retry as NodeJS.ErrnoException).code === "EEXIST") throw reserved(file);
      throw retry;
    }
  }
  const identity = fs.fstatSync(fd);
  const release = (preserve = false): void => {
    try {
      if (!preserve) {
        const current = fs.statSync(file);
        if (current.dev === identity.dev && current.ino === identity.ino) fs.unlinkSync(file);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    } finally {
      fs.closeSync(fd);
    }
  };
  try {
    const bootId = stale?.bootId ? { bootId: stale.bootId } : {};
    fs.writeSync(fd, JSON.stringify({ launcherPid: process.pid, startedAt: new Date().toISOString(), ...bootId }) + "\n");
  } catch (error) {
    release();
    throw error;
  }
  return {
    recordChild: (pid, identity) => { fs.writeSync(fd, JSON.stringify({ childPid: pid, ...identity }) + "\n"); },
    release,
    ...(archived ? { archived } : {}),
  };
}

function reserved(file: string): Error {
  return new Error(`Daemon startup is already reserved: ${file}. Inspect its launcher/child PIDs, daemon.json and daemon.log. If the launch was abandoned, prove both processes are absent before archiving the reservation and retrying; no child spawned.`);
}

/** This machine's boot time, in ms since the epoch. */
export function bootedAtMs(): number {
  return Date.now() - os.uptime() * 1000;
}

/** An ID that changes on every boot: Linux's boot_id, macOS's kern.bootsessionuuid; else undefined. */
export function currentBootId(): string | undefined {
  try {
    const id = process.platform === "linux"
      ? fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8")
      : process.platform === "darwin"
        ? execFileSync("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], { encoding: "utf8", timeout: 2_000 })
        : "";
    return id.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Archives an abandoned reservation (see `acquireDaemonStartLock`) and returns the archive's path: one from an
 * earlier boot, or one from this boot whose recorded launcher and child are both positively dead in this shell's
 * pid namespace. Anything unreadable stays where it is, and so does one naming a PID that isn't positively dead.
 * One launch wins: the archive is a hard link named after the inspected file's inode, made
 * with link(2), which never replaces an existing name. A launch that lost the race, or whose path now holds a
 * different file, gets EEXIST or a mismatched inode and keeps the refusal. Only the winner removes the old
 * name, and nothing else can replace it while it exists, so the winner never removes another launch's lock.
 * A winner that dies between link and unlink leaves both names; later starts refuse, as before this change. */
function archiveIfAbandoned(file: string, stale: StaleLockCheck): string | undefined {
  let text: string;
  let inspected: fs.Stats;
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return undefined;
  }
  try {
    inspected = fs.fstatSync(fd);
    text = fs.readFileSync(fd, "utf8");
  } catch {
    return undefined;
  } finally {
    fs.closeSync(fd);
  }
  const pids: number[] = [];
  let startedAtMs = Number.NaN;
  let lockBootId: string | undefined;
  let hasLauncher = false;
  let hasChild = false;
  let recordedNamespace: string | undefined;
  const validPid = (pid: unknown): pid is number => typeof pid === "number" && Number.isInteger(pid) && pid > 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let record: { launcherPid?: unknown; childPid?: unknown; startedAt?: unknown; bootId?: unknown; pidNamespace?: unknown };
    try {
      record = JSON.parse(line);
    } catch {
      return undefined;
    }
    if (validPid(record.launcherPid)) { pids.push(record.launcherPid); hasLauncher = true; }
    if (validPid(record.childPid)) { pids.push(record.childPid); hasChild = true; }
    if (typeof record.startedAt === "string") startedAtMs = Date.parse(record.startedAt);
    if (typeof record.bootId === "string" && record.bootId) lockBootId = record.bootId;
    if (typeof record.pidNamespace === "string" && record.pidNamespace) recordedNamespace = record.pidNamespace;
  }
  if (!Number.isFinite(startedAtMs) || pids.length === 0) return undefined;
  const allDead = (): boolean => pids.every((pid) => stale.processLiveness(pid) === "dead");
  const earlierBoot = lockBootId && stale.bootId
    ? lockBootId !== stale.bootId
    : Math.max(startedAtMs, inspected.mtimeMs) < stale.bootedAtMs && allDead();
  if (!earlierBoot) {
    // This boot: only a launch whose launcher and recorded child are both positively gone, numbered in this shell's
    // pid namespace. A pending or unknown child keeps today's refusal.
    const sameNamespace = stale.pidNamespace !== undefined && (recordedNamespace ?? "host") === stale.pidNamespace;
    if (!(hasLauncher && hasChild && sameNamespace && allDead())) return undefined;
  }
  stale.afterInspect?.();
  const stamp = new Date(startedAtMs).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  // From this boot, `rig daemon stop` may release the same spent reservation: share its name.
  const target = earlierBoot ? `${file}.abandoned-${stamp}-${inspected.ino}` : `${file}.stopped-${inspected.ino}`;
  try {
    fs.linkSync(file, target);
  } catch {
    return undefined;
  }
  const linked = fs.statSync(target);
  if (linked.dev !== inspected.dev || linked.ino !== inspected.ino) {
    fs.unlinkSync(target);
    return undefined;
  }
  fs.unlinkSync(file);
  return target;
}

/** #3315 — a token that names one process for as long as it lives: on Linux its start time in clock ticks since boot
 *  (/proc/<pid>/stat field 22, which no wall-clock step moves); elsewhere the `ps lstart` string (LC_ALL=C, to the
 *  second). A later process with the same PID gets a different token unless it started within that resolution (one
 *  clock tick, or the same second), and a userspace read is not atomic with a later kill(2). Undefined when it can't be
 *  read. Compare tokens only for equality, within one boot. */
export function processStartToken(pid: number): string | undefined {
  try {
    if (process.platform === "linux") {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      // The command name (field 2) may hold spaces and parentheses: the fields after it follow the last ')'.
      const ticks = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
      return ticks && /^\d+$/.test(ticks) ? `linux:${ticks}` : undefined;
    }
    if (process.platform === "win32") return undefined;
    const start = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 2_000, env: { ...process.env, LC_ALL: "C" } })
      .trim().replace(/\s+/g, " ");
    return start ? `lstart:${start}` : undefined;
  } catch {
    return undefined;
  }
}

/** #3315 — releases a reservation that `rig daemon stop` found spent (its launcher and child gone after a clean
 *  shutdown): only while it still holds exactly `expected`, it is archived under its inode by link(2), which never
 *  replaces an existing name, and only the winner removes the old name, so a concurrent stop or a reservation that
 *  changed meanwhile is left alone. Returns the archive's path, or undefined when nothing was released. */
export function archiveSpentReservation(file: string, expected: string): string | undefined {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return undefined;
  }
  let inspected: fs.Stats;
  let text: string;
  try {
    inspected = fs.fstatSync(fd);
    text = fs.readFileSync(fd, "utf8");
  } catch {
    return undefined;
  } finally {
    fs.closeSync(fd);
  }
  if (text !== expected) return undefined;
  const target = `${file}.stopped-${inspected.ino}`;
  try {
    fs.linkSync(file, target);
  } catch {
    return undefined;
  }
  try {
    const linked = fs.statSync(target);
    if (linked.dev !== inspected.dev || linked.ino !== inspected.ino) {
      fs.unlinkSync(target);
      return undefined;
    }
    fs.unlinkSync(file);
  } catch {
    // Left for the operator; the caller warns that the reservation was not released.
    return undefined;
  }
  return target;
}
