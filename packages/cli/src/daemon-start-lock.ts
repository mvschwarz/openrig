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
 * launcher may have died between the spawn and recording it) or another namespace keeps the refusal, and so does
 * a reservation that `rig daemon stop` retained after a shutdown it couldn't verify (`markReservationRetained`):
 * that state is unknown, not gone. The start notes in the archive that it archived it.
 * Every route that removes another launch's reservation (both of these, and `rig daemon stop`'s release) first takes
 * one claim on its inode (`claimAndArchive`), so two of them that both find it removable can't both remove it; the stop's
 * retention mark takes the same claim, so it lands before a removal's content check or not at all. The
 * owning launcher's own release needs no claim: while it runs, nothing else finds its reservation removable. */
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
 * One launch wins, through `claimAndArchive`. */
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
  let retainedByStop = false;
  let recordedNamespace: string | undefined;
  const validPid = (pid: unknown): pid is number => typeof pid === "number" && Number.isInteger(pid) && pid > 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let record: { launcherPid?: unknown; childPid?: unknown; startedAt?: unknown; bootId?: unknown; pidNamespace?: unknown; retainedBy?: unknown };
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
    if (record.retainedBy !== undefined) retainedByStop = true;
  }
  if (!Number.isFinite(startedAtMs) || pids.length === 0) return undefined;
  const allDead = (): boolean => pids.every((pid) => stale.processLiveness(pid) === "dead");
  const earlierBoot = lockBootId && stale.bootId
    ? lockBootId !== stale.bootId
    : Math.max(startedAtMs, inspected.mtimeMs) < stale.bootedAtMs && allDead();
  if (!earlierBoot) {
    // This boot: only a launch whose launcher and recorded child are both positively gone, numbered in this shell's
    // pid namespace, and that no stop retained. A pending or unknown child keeps today's refusal.
    const sameNamespace = stale.pidNamespace !== undefined && (recordedNamespace ?? "host") === stale.pidNamespace;
    if (retainedByStop || !(hasLauncher && hasChild && sameNamespace && allDead())) return undefined;
  }
  stale.afterInspect?.();
  const stamp = new Date(startedAtMs).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const target = `${file}.abandoned-${stamp}-${inspected.ino}`;
  if (!claimAndArchive(file, inspected, text, target)) return undefined;
  if (!earlierBoot) {
    // Say that a start archived it, and why: the reservation itself only records the launch.
    try {
      fs.appendFileSync(target, JSON.stringify({ archivedBy: "start", reason: "launcher-and-child-gone", launcherPid: process.pid, at: new Date().toISOString() }) + "\n");
    } catch {
      // The archive is already in place; the note is only for whoever inspects it.
    }
  }
  return target;
}

/** #3637 — moves the reservation at `file`, still the `inspected` inode, to `target` and removes `file`, only after
 * taking the one claim on that inode that every remover takes: a hard link named after the inode, made with link(2),
 * which never replaces an existing name. Whoever gets EEXIST, a missing file, another inode under the claim, or
 * content other than the `text` it decided on (a stop may have appended a retention since; the stop takes this same
 * claim to append it, so none lands between this check and the move) keeps the reservation
 * where it is. While the claim exists no other remover can remove `file`, so the winner never removes another
 * launch's lock, whichever archive name each would use. The claim goes once the move is done. A remover that dies
 * holding the claim leaves it, and later removals of that inode refuse until it's cleared by hand. */
function claimAndArchive(file: string, inspected: fs.Stats, text: string, target: string): boolean {
  const claim = `${file}.claim-${inspected.ino}`;
  try {
    fs.linkSync(file, claim);
  } catch {
    return false;
  }
  try {
    const claimed = fs.statSync(claim);
    if (claimed.dev !== inspected.dev || claimed.ino !== inspected.ino) return false;
    if (fs.readFileSync(claim, "utf8") !== text) return false;
    fs.linkSync(file, target);
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  } finally {
    try { fs.unlinkSync(claim); } catch { /* already gone */ }
  }
}

/** #3637 — what `markReservationRetained` did. `written`: the reservation's new text. `changed`: it is gone, is another
 *  file than the one read, or holds other text than `expected`; nothing was written, and the stop must refuse.
 *  `refuse`: nothing was written and the stop must refuse for another reason (why): the reservation couldn't be read
 *  to confirm it is the one read, or no claim could be taken and none is there to keep a start from archiving it.
 *  `unwritten`: it is still the reservation the stop read, but the mark couldn't be written (why); when this call took
 *  the removers' claim on it, it still holds it, so no remover moves the reservation until `release` is called, and
 *  `retry` writes a later record under that same claim (the claim stays held until `release`). */
export type ReservationMark =
  | { written: string }
  | { changed: string }
  | { refuse: string }
  | { unwritten: string; release?: () => void; retry?: (reason: string) => ReservationMark };

/** #3637 — `rig daemon stop` keeps a reservation after a shutdown it couldn't verify (the child didn't exit, the
 *  listener isn't confirmed closed, no matching receipt, or an incomplete one), and marks it before its signal
 *  ("stopping") so no start archives it while the shutdown is being verified. It records that here, only while the
 *  file still holds exactly `expected`, so a later start doesn't take that unknown state for an abandoned launch.
 *  It holds the removers' claim on the inode (`claimAndArchive`) across that check and the write, so no remover moves
 *  the reservation between them. A write that fails (an I/O error) or a claim already present (left by an interrupted
 *  operation, or another removal in progress) is `unwritten`, never `changed`, as long as the reservation was read
 *  again and is still the one read: a mark that can't be written doesn't, by itself, make it a different one. */
export function markReservationRetained(file: string, expected: string, reason: string): ReservationMark {
  let inspected: fs.Stats;
  try {
    inspected = fs.statSync(file);
  } catch (error) {
    return code(error) === "ENOENT" ? { changed: "it is gone" } : { refuse: `it couldn't be inspected to confirm it (${describe(error)})` };
  }
  const claim = `${file}.claim-${inspected.ino}`;
  try {
    fs.linkSync(file, claim);
  } catch (error) {
    if (code(error) === "ENOENT") return { changed: "it is gone" };
    // No claim taken: the reservation is checked as it stands, and only a reservation that is still the one read goes on.
    let text: string;
    try {
      const now = fs.statSync(file);
      if (now.dev !== inspected.dev || now.ino !== inspected.ino) return { changed: "it was replaced" };
      text = fs.readFileSync(file, "utf8");
    } catch (reread) {
      return code(reread) === "ENOENT" ? { changed: "it is gone" } : { refuse: `it couldn't be read again to confirm it (${describe(reread)})` };
    }
    if (text !== expected) return { changed: "its content changed" };
    // A claim already there keeps every remover out while it exists; with none there, nothing would keep a start
    // from archiving the reservation while the stop verifies the shutdown.
    if (code(error) !== "EEXIST") return { refuse: `the "stopping" mark was not written and no claim could be taken on it (${describe(error)}), so nothing keeps a start from archiving it while stop verifies` };
    return { unwritten: `the claim file ${claim} is present (left by an interrupted operation, or another removal in progress)` };
  }
  let held = true;
  const release = (): void => {
    if (!held) return;
    held = false;
    try { fs.unlinkSync(claim); } catch { /* already gone */ }
  };
  // One write of a record under the claim this call holds; `retry` writes a later record under that same claim.
  const attempt = (why: string): ReservationMark => {
    const unwritten = (because: string): ReservationMark => ({ unwritten: because, release, retry: attempt });
    let text: string;
    try {
      const claimed = fs.statSync(claim);
      if (claimed.dev !== inspected.dev || claimed.ino !== inspected.ino) { release(); return { changed: "it was replaced" }; }
      text = fs.readFileSync(claim, "utf8");
    } catch (error) {
      release();
      return { refuse: `it couldn't be read under the claim to confirm it (${describe(error)})` };
    }
    if (text !== expected) { release(); return { changed: "its content changed" }; }
    const record = JSON.stringify({ retainedBy: "stop", reason: why, at: new Date().toISOString() }) + "\n";
    let fd: number;
    try {
      fd = fs.openSync(claim, "r+");
    } catch (error) {
      return unwritten(`it couldn't be opened for writing (${describe(error)})`);
    }
    try {
      const length = Buffer.byteLength(record);
      const wrote = fs.writeSync(fd, record, Buffer.byteLength(text));
      if (wrote === length) return { written: text + record };
      // A short write left part of a record: take it back, or the reservation is no longer the one read.
      try { fs.ftruncateSync(fd, Buffer.byteLength(text)); } catch { release(); return { changed: "a partial record was left on it" }; }
      return unwritten(`the write was short (${wrote} of ${length} bytes)`);
    } catch (error) {
      return unwritten(`the write failed (${describe(error)})`);
    } finally {
      try { fs.closeSync(fd); } catch { /* the outcome above stands; the claim is still released by its holder */ }
    }
  };
  const first = attempt(reason);
  if ("written" in first) release();
  return first;
}

function code(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

function describe(error: unknown): string {
  return code(error) ?? (error instanceof Error ? error.message : String(error));
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
  // Left for the operator when the claim or the move fails; the caller warns that the reservation was not released.
  return claimAndArchive(file, inspected, text, target) ? target : undefined;
}
