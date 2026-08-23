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
   *  newer occupant's.
   *
   *  SETTLED entries never time-expire (e91d7a94 — the expiry-herd fix): a
   *  probe that STARTED strictly after the identity's lstart second closed
   *  observed the FINAL occupant of this (pid, lstart) key — same-pid
   *  same-second reuse is impossible once the second passes, and a live
   *  process's HOME cannot change — so the answer is valid for the key's
   *  lifetime and is removed only by identity mismatch (a new key) or FIFO
   *  size eviction. Probe START time is the predicate, NOT completion time
   *  (orch-lead 22:39Z): a probe started inside the second can observe the
   *  retired occupant and complete after it. UNSETTLED entries — probe
   *  started inside the ambiguous second, unparseable identity, or
   *  identity-less callers — expire after homeTtlMs (r2-B1/W-5.3-1): the
   *  TTL is their staleness bound and the finite recovery path for the
   *  same-second collision. */
  private readonly homeByKey = new Map<string, { home: string; at: number; settled: boolean }>();
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
      /** Freshness bound for UNSETTLED cache entries — identity-less
       *  callers, unparseable identities, and probes that started inside
       *  the identity's ambiguous lstart second. Past it the pid re-probes;
       *  this is the finite recovery path for the same-second collision
       *  (W-5.3-1). Settled entries never consult it. Default 60s.
       *  (The former identityHomeTtlMs tier is gone — e91d7a94: ANY
       *  periodic expiry of settled entries synchronizes an unnecessary
       *  probe herd, measured live as resolve_home +20 in 1.5s.) */
      homeTtlMs?: number;
      /** Injectable clock (tests). */
      now?: () => number;
    } = {},
  ) {}

  /**
   * Resolve a codex thread id for `pid`. IDENTITY IS REQUIRED (S10 follow-on, r1 owed item 3): the
   * identity's start time gates every log read, so a retired occupant's rows never resolve for a
   * reused pid. The ungated read — the pre-round-4 class S10 eliminated, safe today only by
   * call-graph discipline — is reachable ONLY via resolveUngatedLegacy, so a NEW identity-less
   * call site is a COMPILE error (the review-visible pin; see the codex-thread-id test).
   */
  async resolve(pid: number, identity: string): Promise<string | undefined> {
    return this.resolveInternal(pid, identity);
  }

  /**
   * EXPLICIT ungated escape hatch — reads WITHOUT the identity start-time gate (a reused pid can
   * match a retired occupant's rows). Use ONLY for genuinely identity-less callers (tests, adoption
   * paths that carry no census identity). Every new identity-less read must NAME this method; do
   * not re-open resolve() to an optional identity. By construction its cache entries can never be
   * SETTLED: it delegates with identity=undefined, so minTs is undefined, the settled predicate is
   * false, and every entry it writes stays bounded by homeTtlMs (60s) — see the settled-permanence
   * rule (e91d7a94) on the cache above.
   */
  async resolveUngatedLegacy(pid: number): Promise<string | undefined> {
    return this.resolveInternal(pid, undefined);
  }

  private async resolveInternal(pid: number, identity: string | undefined): Promise<string | undefined> {
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
      if (cached.settled || now() - cached.at <= ttl) {
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
      // Settledness is decided by the probe's START time (orch-lead 22:39Z):
      // only a probe started strictly AFTER the identity's lstart second
      // closed is guaranteed to observe the final occupant of this key. A
      // deferred probe that started inside the second may describe the
      // retired occupant even if it completes later, so its entry keeps the
      // short TTL. Coalesced waiters inherit the ORIGINAL probe's verdict.
      const settled = minTs !== undefined && now() >= (minTs + 1) * 1000;
      const p = Promise.resolve(resolver(pid)).then(
        (home) => {
          this.inFlightByKey.delete(key);
          if (home) this.cacheHome(key, home, settled);
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

  private cacheHome(key: string, home: string, settled: boolean): void {
    const max = this.opts.maxCachedPids ?? 256;
    if (!this.homeByKey.has(key) && this.homeByKey.size >= max) {
      const oldest = this.homeByKey.keys().next().value;
      if (oldest !== undefined) this.homeByKey.delete(oldest);
    }
    this.homeByKey.set(key, { home, at: (this.opts.now ?? Date.now)(), settled });
  }
}

// S10 follow-on item 3 — the REVIEW-VISIBLE pin, placed in src/ so the daemon typecheck gate
// (packages/daemon/tsconfig.json excludes "test") ACTUALLY evaluates it. r1 finding 2026-08-23: the
// earlier @ts-expect-error lived in an untypechecked test file and never fired. resolve()'s identity
// must stay REQUIRED: if anyone re-opens it to an optional identity — reintroducing the pre-round-4
// ungated class — its Parameters gain an optional slot, `ResolveRequiresIdentity` resolves to `never`,
// `true` is no longer assignable, and `tsc --noEmit` on packages/daemon FAILS. resolveUngatedLegacy is
// the ONLY identity-less read path. Acceptance (r1): re-open resolve() to optional identity -> tsc fails.
type ResolveRequiresIdentity =
  Parameters<CodexThreadIdResolver["resolve"]> extends [pid: number, identity: string] ? true : never;
const _resolveRequiresIdentityPin: ResolveRequiresIdentity = true;
void _resolveRequiresIdentityPin;

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
  // seconds), only rows written strictly AFTER its start second are provably that occupant's. Identity-less
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
             AND ts > ?
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
 *  SECONDS. The reader gates STRICTLY (`ts > startTs`, r2 round-6): lstart
 *  carries no subsecond component, so ownership of a row INSIDE the start
 *  second is undecidable — retired A can log at ts == B.startTs in the same
 *  second B reuses the pid. The ambiguous second fails CLOSED (honest
 *  INDETERMINATE; a genuinely-current same-second row resolves one poll
 *  later), rows after it resolve. Unparseable → undefined (the caller falls
 *  back to the ungated read rather than inventing a gate). */
export function lstartToMinTs(identity: string | undefined): number | undefined {
  if (!identity) return undefined;
  const m = identity.match(/^\w{3}\s+(\w{3})\s+(\d+)\s+(\d{2}:\d{2}:\d{2})\s+(\d{4})$/);
  if (!m) return undefined;
  const parsed = Date.parse(`${m[1]} ${m[2]}, ${m[4]} ${m[3]}`);
  if (Number.isNaN(parsed)) return undefined;
  return Math.floor(parsed / 1000);
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
