import os from "node:os";
import nodePath from "node:path";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { runAsyncSite } from "./sync-site-wrap.js";

const execFileAsync = promisify(execFile);

/** F1 (B12's completion): may return a plain value (test stubs stay sync) or a Promise — every
 *  caller awaits it, and the DEFAULT is async so the per-PID `ps eww` spawn no longer blocks the
 *  event loop (measured live: 28.9s/15min of burst blocking inside the 8-attempt capture loops). */
export type ResolveHomeDirByPid = (pid: number) => Promise<string | undefined> | string | undefined;

export async function defaultResolveHomeDirByPid(pid: number): Promise<string | undefined> {
  try {
    // BSD/macOS `ps` supports `eww` to expose the full process environment.
    // If OpenRig grows a Linux daemon target, this likely needs a /proc-based path.
    const output = (await runAsyncSite("codex_thread_id.resolve_home", async () => {
      const { stdout } = await execFileAsync("ps", ["eww", "-p", String(pid), "-o", "command="], { encoding: "utf-8" });
      return stdout;
    })).trim();
    if (!output) return undefined;
    const match = output.match(/(?:^|\s)HOME=([^\s]+)/);
    return match?.[1];
  } catch {
    return undefined;
  }
}

export function readCodexThreadIdFromCandidateHomes(
  pid: number,
  candidateHomes: Array<string | undefined>,
  exists?: (path: string) => boolean
): string | undefined {
  for (const homeDir of uniqueHomes(candidateHomes)) {
    const threadId = readCodexThreadIdFromLogs(pid, homeDir, exists);
    if (threadId) return threadId;
  }
  return undefined;
}

/**
 * OPR.0.5.3.10 (addendum) — thread-id resolution WITHOUT the per-call PID-home
 * subprocess. The measured amplifier: 298 `codex_thread_id.resolve_home` spans
 * in the last 500 slow spans (mean 8.24s, max 36.72s) — a `ps eww` per pid,
 * per attempt, per tick, when nearly every codex seat's logs live under the
 * DEFAULT home.
 *
 * Order of costs:
 *   1. DEFAULT home first — a pure file/sqlite read, ZERO subprocess. Hit = done.
 *   2. Bounded PID-keyed cache of previously RESOLVED non-default homes — a
 *      pid's HOME does not change for the life of the process. Hit = file read.
 *   3. Only then the subprocess resolver — and its SUCCESS is cached (bounded,
 *      FIFO eviction). A FAILED resolution is never cached: the next call may
 *      retry (a dying `ps` under load must not poison the pid).
 */
export class CodexThreadIdResolver {
  /** Bounded pid→home cache of SUCCESSFUL resolutions — INCLUDING the default
   *  home (a stable default-home pid with no thread log must not re-run
   *  `ps eww` every poll). Entries carry a timestamp and EXPIRE after
   *  homeTtlMs (r2-B1 / r1 BLOCKING-1: a pid can be REUSED by a new process
   *  with a different HOME — an unexpiring cache served the retired
   *  occupant's thread id indefinitely, which is exactly a wrong resume
   *  token). Staleness is now bounded by the TTL, not just the entry count. */
  private readonly homeByPid = new Map<number, { home: string; at: number }>();
  /** Per-pid in-flight home resolution — concurrent resolves for the same pid
   *  coalesce onto ONE subprocess; a failure rejects all waiters and caches
   *  nothing. */
  private readonly inFlightByPid = new Map<number, Promise<string | undefined>>();

  constructor(
    private readonly opts: {
      defaultHome?: string;
      resolveHomeDirByPid?: ResolveHomeDirByPid;
      readFromLogs?: (pid: number, homeDir: string) => string | undefined;
      /** Bounded cache size; oldest-inserted evicts first. Default 256. */
      maxCachedPids?: number;
      /** Freshness bound per cache entry — past it the pid re-probes. Default
       *  60s: dedupes the per-poll `ps eww` churn while bounding pid-reuse
       *  staleness to a minute. */
      homeTtlMs?: number;
      /** Injectable clock (tests). */
      now?: () => number;
    } = {},
  ) {}

  async resolve(pid: number): Promise<string | undefined> {
    const readFromLogs = this.opts.readFromLogs ?? ((p: number, home: string) => readCodexThreadIdFromLogs(p, home));
    const defaultHome = this.opts.defaultHome ?? safeUserHomeDir() ?? os.homedir();
    const now = this.opts.now ?? Date.now;
    const ttl = this.opts.homeTtlMs ?? 60_000;

    // 1. Default home: no subprocess.
    const fromDefault = readFromLogs(pid, defaultHome);
    if (fromDefault) return fromDefault;

    // 2. FRESH cached home for this pid: no subprocess. A cached DEFAULT means
    //    the subprocess already answered "default" once — step 1 covered it.
    //    An EXPIRED entry is dropped and the pid re-probes (r2-B1).
    const cached = this.homeByPid.get(pid);
    if (cached) {
      if (now() - cached.at <= ttl) {
        return cached.home === defaultHome ? undefined : readFromLogs(pid, cached.home);
      }
      this.homeByPid.delete(pid);
    }

    // 3. Subprocess resolution, pid-coalesced: concurrent callers share one probe.
    const inFlight = this.inFlightByPid.get(pid);
    const homePromise = inFlight ?? (() => {
      const resolver = this.opts.resolveHomeDirByPid ?? defaultResolveHomeDirByPid;
      const p = Promise.resolve(resolver(pid)).then(
        (home) => {
          this.inFlightByPid.delete(pid);
          if (home) this.cacheHome(pid, home);
          return home;
        },
        (err) => {
          // Honest failure: nothing cached, next call retries.
          this.inFlightByPid.delete(pid);
          throw err;
        },
      );
      this.inFlightByPid.set(pid, p);
      return p;
    })();
    const home = await homePromise;
    if (!home || home === defaultHome) return undefined;
    return readFromLogs(pid, home);
  }

  private cacheHome(pid: number, home: string): void {
    const max = this.opts.maxCachedPids ?? 256;
    if (!this.homeByPid.has(pid) && this.homeByPid.size >= max) {
      const oldest = this.homeByPid.keys().next().value;
      if (oldest !== undefined) this.homeByPid.delete(oldest);
    }
    this.homeByPid.set(pid, { home, at: (this.opts.now ?? Date.now)() });
  }
}

function uniqueHomes(candidateHomes: Array<string | undefined>): string[] {
  const homes = candidateHomes.filter((home): home is string => Boolean(home));
  const userHome = safeUserHomeDir();
  if (userHome) homes.push(userHome);
  return [...new Set(homes)];
}

function safeUserHomeDir(): string | undefined {
  try {
    return os.userInfo().homedir;
  } catch {
    return undefined;
  }
}

function readCodexThreadIdFromLogs(
  pid: number,
  homeDir: string,
  exists?: (path: string) => boolean
): string | undefined {
  for (const dbPath of resolveCodexLogDbPaths(homeDir, exists)) {
    try {
      const db = new Database(dbPath, { readonly: true });
      try {
        const row = db.prepare(
          `SELECT thread_id
           FROM logs
           WHERE process_uuid LIKE ?
             AND thread_id IS NOT NULL
           ORDER BY ts DESC, ts_nanos DESC, id DESC
           LIMIT 1`
        ).get(`pid:${pid}:%`) as { thread_id?: string } | undefined;
        if (row?.thread_id) {
          return row.thread_id;
        }
      } finally {
        db.close();
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

function resolveCodexLogDbPaths(homeDir: string, exists?: (path: string) => boolean): string[] {
  const codexDir = nodePath.join(homeDir, ".codex");
  const discovered: Array<{ version: number; path: string }> = [];

  try {
    for (const entry of fs.readdirSync(codexDir)) {
      const match = entry.match(/^logs_(\d+)\.sqlite$/);
      if (!match) continue;
      discovered.push({
        version: Number(match[1]),
        path: nodePath.join(codexDir, entry),
      });
    }
  } catch {
    // Best effort only; fall back to the historical filename below.
  }

  if (discovered.length === 0) {
    discovered.push({ version: 1, path: nodePath.join(codexDir, "logs_1.sqlite") });
  }

  return discovered
    .sort((a, b) => b.version - a.version)
    .map((entry) => entry.path)
    .filter((path, index, paths) => paths.indexOf(path) === index)
    .filter((path) => !exists || exists(path));
}
