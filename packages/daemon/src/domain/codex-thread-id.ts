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
  /** Bounded (pid,identity)→home cache of SUCCESSFUL resolutions — INCLUDING
   *  the default home (a stable default-home pid with no thread log must not
   *  re-run `ps eww` every poll). KEYED BY IDENTITY (r2 round-3): a reused
   *  pid carries a different startedAt, so it structurally MISSES the retired
   *  occupant's entry — no read-time mismatch check to get wrong, and a late
   *  stale-probe completion writes only its own key, never clobbering the
   *  newer occupant's. Entries also EXPIRE after homeTtlMs (r2-B1/r1
   *  BLOCKING-1): the TTL is the staleness bound for identity-less callers
   *  and the memory bound for retired keys ahead of size eviction. */
  private readonly homeByKey = new Map<string, { home: string; at: number }>();
  /** In-flight home resolution, keyed by pid+IDENTITY (r2 round-3): a known
   *  identity must never join a probe belonging to a different or
   *  identity-less occupant — under the measured 8-36s probes a pid can be
   *  reused MID-PROBE, and pid-only coalescing handed the new occupant the
   *  retired occupant's answer before the completed-cache check could run.
   *  Same (pid, identity) still coalesces onto ONE subprocess; a failure
   *  rejects all waiters of that key and caches nothing. */
  private readonly inFlightByKey = new Map<string, Promise<string | undefined>>();

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

  async resolve(pid: number, identity?: string): Promise<string | undefined> {
    // r2 round-4: the identity's start time gates EVERY log read — a retired
    // occupant's rows predate the current occupant's start and never match.
    const minTs = lstartToMinTs(identity);
    const readFromLogs = this.opts.readFromLogs
      ?? ((p: number, home: string) => readCodexThreadIdFromLogs(p, home, undefined, minTs));
    const defaultHome = this.opts.defaultHome ?? safeUserHomeDir() ?? os.homedir();
    const now = this.opts.now ?? Date.now;
    const ttl = this.opts.homeTtlMs ?? 60_000;

    // 1. Default home: no subprocess.
    const fromDefault = readFromLogs(pid, defaultHome);
    if (fromDefault) return fromDefault;

    // 2. FRESH cached home for this (pid, identity): no subprocess. A reused
    //    pid carries a new identity and structurally MISSES here (r1's
    //    remedy); identity-less callers get their own TTL-bounded slot. A
    //    cached DEFAULT means the subprocess already answered "default" once
    //    — step 1 covered it.
    const key = `${pid}|${identity ?? ""}`;
    const cached = this.homeByKey.get(key);
    if (cached) {
      if (now() - cached.at <= ttl) {
        return cached.home === defaultHome ? undefined : readFromLogs(pid, cached.home);
      }
      this.homeByKey.delete(key);
    }

    // 3. Subprocess resolution, coalesced by the SAME (pid, identity) key:
    //    only callers holding the same identity share a probe (r2 round-3 —
    //    under the measured 8-36s probes a pid can be reused MID-PROBE, and
    //    pid-only coalescing handed the new occupant the retired occupant's
    //    answer). A completion writes only its own key, so a late stale
    //    probe never clobbers the newer occupant's entry.
    const inFlight = this.inFlightByKey.get(key);
    const homePromise = inFlight ?? (() => {
      const resolver = this.opts.resolveHomeDirByPid ?? defaultResolveHomeDirByPid;
      const p = Promise.resolve(resolver(pid)).then(
        (home) => {
          this.inFlightByKey.delete(key);
          if (home) this.cacheHome(key, home);
          return home;
        },
        (err) => {
          // Honest failure: nothing cached, next call retries.
          this.inFlightByKey.delete(key);
          throw err;
        },
      );
      this.inFlightByKey.set(key, p);
      return p;
    })();
    const home = await homePromise;
    if (!home || home === defaultHome) return undefined;
    return readFromLogs(pid, home);
  }

  private cacheHome(key: string, home: string): void {
    const max = this.opts.maxCachedPids ?? 256;
    if (!this.homeByKey.has(key) && this.homeByKey.size >= max) {
      const oldest = this.homeByKey.keys().next().value;
      if (oldest !== undefined) this.homeByKey.delete(oldest);
    }
    this.homeByKey.set(key, { home, at: (this.opts.now ?? Date.now)() });
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
  exists?: (path: string) => boolean,
  minTs?: number
): string | undefined {
  // OPR.0.5.3.10 r2 round-4 — the logs key is pid:<pid>:<opaque-uuid>, so a
  // pid-only read can return a RETIRED occupant's row to a reused pid. When
  // the caller knows the current occupant's start time (minTs, epoch
  // seconds), only rows written at/after it are that occupant's. Identity-less
  // callers keep the legacy unbounded read.
  for (const dbPath of resolveCodexLogDbPaths(homeDir, exists)) {
    try {
      const db = new Database(dbPath, { readonly: true });
      try {
        const row = db.prepare(
          `SELECT thread_id
           FROM logs
           WHERE process_uuid LIKE ?
             AND thread_id IS NOT NULL
             AND ts >= ?
           ORDER BY ts DESC, ts_nanos DESC, id DESC
           LIMIT 1`
        ).get(`pid:${pid}:%`, minTs ?? 0) as { thread_id?: string } | undefined;
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

/** Parse `ps lstart` ("Sun Aug 23 19:30:00 2026", local time) to epoch
 *  SECONDS, with a 2s slack for same-second writes. Unparseable → undefined
 *  (the caller falls back to the ungated read rather than inventing a gate). */
export function lstartToMinTs(identity: string | undefined): number | undefined {
  if (!identity) return undefined;
  const m = identity.match(/^\w{3}\s+(\w{3})\s+(\d+)\s+(\d{2}:\d{2}:\d{2})\s+(\d{4})$/);
  if (!m) return undefined;
  const parsed = Date.parse(`${m[1]} ${m[2]}, ${m[4]} ${m[3]}`);
  if (Number.isNaN(parsed)) return undefined;
  return Math.floor(parsed / 1000) - 2;
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
