import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface DaemonStartLock {
  recordChild(pid: number): void;
  release(preserve?: boolean): void;
  /** Where a reservation left from before this boot was archived, when this launch did so. */
  archived?: string;
}

export interface StaleLockCheck {
  /** This boot's identity (`currentBootId`), recorded in the reservation; undefined where the OS has none. */
  bootId?: string;
  /** When this machine booted, in ms since the epoch. */
  bootedAtMs: number;
  /** Three-state liveness (`createProcessLiveness`): only "dead" counts as gone. */
  processLiveness: (pid: number) => "alive" | "dead" | "unknown";
  /** Test seam: runs after the reservation was inspected and before it is claimed. */
  afterInspect?: () => void;
}

/** One supported local launch owns pre-bind initialization through publication.
 * ponytail: no age-based takeover — a dead launcher can leave a live unbound child.
 * The one exception is a reservation from an earlier boot: a reboot ends every process it could name.
 * A reservation that records its boot ID is from an earlier boot when that ID differs from this one's;
 * PIDs don't matter then, since after a reboot they may belong to unrelated processes.
 * One without a boot ID (written by an older CLI) must have been written and last changed before
 * this boot, with every recorded PID positively dead; the PID check covers a clock that jumped after
 * boot, and a PID that can't be inspected keeps the refusal.
 * Otherwise hard-crash recovery inspects the recorded PIDs before archiving this file. */
export function acquireDaemonStartLock(home: string, stale?: StaleLockCheck): DaemonStartLock {
  fs.mkdirSync(home, { recursive: true });
  const file = path.join(home, "daemon-start.lock");
  let fd: number;
  let archived: string | undefined;
  try {
    fd = fs.openSync(file, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    archived = stale ? archiveIfBeforeBoot(file, stale) : undefined;
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
    recordChild: (pid) => { fs.writeSync(fd, JSON.stringify({ childPid: pid }) + "\n"); },
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

/** Archives a reservation from an earlier boot (see `acquireDaemonStartLock`) and returns the archive's path.
 * Anything unreadable or from this boot stays where it is, and so does a legacy one naming a PID that isn't
 * positively dead. One launch wins: the archive is a hard link named after the inspected file's inode, made
 * with link(2), which never replaces an existing name. A launch that lost the race, or whose path now holds a
 * different file, gets EEXIST or a mismatched inode and keeps the refusal. Only the winner removes the old
 * name, and nothing else can replace it while it exists, so the winner never removes another launch's lock.
 * A winner that dies between link and unlink leaves both names; later starts refuse, as before this change. */
function archiveIfBeforeBoot(file: string, stale: StaleLockCheck): string | undefined {
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
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let record: { launcherPid?: unknown; childPid?: unknown; startedAt?: unknown; bootId?: unknown };
    try {
      record = JSON.parse(line);
    } catch {
      return undefined;
    }
    for (const pid of [record.launcherPid, record.childPid]) {
      if (typeof pid === "number" && Number.isInteger(pid) && pid > 0) pids.push(pid);
    }
    if (typeof record.startedAt === "string") startedAtMs = Date.parse(record.startedAt);
    if (typeof record.bootId === "string" && record.bootId) lockBootId = record.bootId;
  }
  if (!Number.isFinite(startedAtMs) || pids.length === 0) return undefined;
  if (lockBootId && stale.bootId) {
    if (lockBootId === stale.bootId) return undefined;
  } else {
    if (Math.max(startedAtMs, inspected.mtimeMs) >= stale.bootedAtMs) return undefined;
    if (!pids.every((pid) => stale.processLiveness(pid) === "dead")) return undefined;
  }
  stale.afterInspect?.();
  const stamp = new Date(startedAtMs).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const target = `${file}.abandoned-${stamp}-${inspected.ino}`;
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
