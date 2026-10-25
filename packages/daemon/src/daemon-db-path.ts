import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstatSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Resolve existing path components, including a dangling final symlink, while
 * preserving a not-yet-created tail. SQLite paths commonly do not exist yet at
 * first boot, so realpathSync alone cannot answer the containment question. */
function resolveForContainment(path: string, seen = new Set<string>()): string {
  const absolute = resolve(path);
  if (seen.has(absolute)) throw new Error(`symlink cycle while resolving ${path}`);
  seen.add(absolute);
  try {
    return realpathSync(absolute);
  } catch (realpathError) {
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(absolute);
    } catch (lstatError) {
      if ((realpathError as NodeJS.ErrnoException).code !== "ENOENT" ||
          (lstatError as NodeJS.ErrnoException).code !== "ENOENT") {
        throw realpathError;
      }
      const parent = dirname(absolute);
      return parent === absolute
        ? absolute
        : join(resolveForContainment(parent, seen), basename(absolute));
    }
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(absolute);
      return resolveForContainment(resolve(dirname(absolute), target), seen);
    }
    // The path exists but realpath could not establish its identity (for
    // example EACCES or ENOTDIR). Treating that as an absent tail would turn
    // an unverified path into authority.
    throw realpathError;
  }
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

/**
 * D15 — resolve the daemon's SQLite path. An explicit OPENRIG_DB / RIGGED_DB wins
 * (the operator takes responsibility for that path); otherwise the db is anchored
 * under OPENRIG_HOME, NEVER a bare CWD-relative filename.
 *
 * Incident 2026-08-07: the entrypoint defaulted `dbPath` to a bare "openrig.sqlite"
 * which resolves against the process CWD — so a daemon launched with an isolated
 * OPENRIG_HOME could still open the SHARED fleet db (whatever sat in its CWD).
 * Anchoring the default to OPENRIG_HOME makes an isolated-home daemon isolate its
 * db too, which is the whole point of setting OPENRIG_HOME.
 */
export function resolveDaemonDbPath(explicitDb: string | undefined | null, openrigHome: string): string {
  if (explicitDb && explicitDb.length > 0) {
    return explicitDb;
  }
  const dbPath = join(openrigHome, "openrig.sqlite");
  const resolvedHome = resolveForContainment(openrigHome);
  const resolvedDb = resolveForContainment(dbPath);
  if (!isWithin(resolvedHome, resolvedDb)) {
    throw new Error(
      `Refusing implicit database outside resolved OPENRIG_HOME: ${dbPath} resolves to ${resolvedDb}, ` +
      `outside ${resolvedHome}. Set OPENRIG_DB explicitly to authorize a deliberate split-path configuration.`,
    );
  }
  return dbPath;
}

const execFileAsync = promisify(execFile);
/** lsof's answer, or why there wasn't one. Exit status 1 is an answer: nothing asked about is open. */
async function lsof(args: string[]): Promise<{ stdout: string } | { failure: string }> {
  try {
    return { stdout: (await execFileAsync("lsof", args, { timeout: 1000, maxBuffer: 64 * 1024 })).stdout };
  } catch (error) {
    const err = error as { code?: unknown; killed?: boolean };
    if (err.code === 1) return { stdout: "" };
    return { failure: err.code === "ENOENT" ? "lsof isn't installed" : err.killed && err.code == null ? "lsof timed out" : "lsof failed" };
  }
}

/** Boot-time diagnostics, with an optional stop on confirmed live-daemon conflicts.
 * Missing tools, inaccessible records and races leave ownership unknown. */
export async function daemonDatabaseWarnings(dbPath: string, home: string, selectedBy?: string,
  opts?: { conflictPolicy: string; allowConflict: boolean }): Promise<string[]> {
  if (dbPath === ":memory:") return [];
  const warnings: string[] = [];
  let db: string;
  let resolvedHome: string;
  try {
    db = resolveForContainment(dbPath);
    resolvedHome = resolveForContainment(home);
  } catch { return warnings; }
  if (selectedBy && !isWithin(resolvedHome, db)) {
    warnings.push(`${selectedBy} selects database ${db} outside OPENRIG_HOME ${resolvedHome}. This explicit path is honoured. The effective daemon environment can come from --db, db.path, OPENRIG_DB or RIGGED_DB. Remove or correct the selecting override to use this home's database.`);
  }
  // The OS supplies actual open-file holders; daemon.json and the listener must
  // independently agree on the PID before a holder is described as a daemon.
  // A check that couldn't run leaves ownership unknown, which is said, never read as no conflict.
  const unverified: string[] = [];
  const holders = await lsof(["-t", "--", db]);
  if ("failure" in holders) unverified.push(holders.failure);
  const pids = "stdout" in holders ? [...new Set(holders.stdout.trim().split(/\s+/).map(Number))]
    .filter(pid => Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid).slice(0, 4) : [];
  const conflicts = await Promise.all(pids.map(async (pid): Promise<{ confirmed: string } | { unknown: string } | undefined> => {
    const files = await lsof(["-a", "-p", String(pid), "-d", "1,2", "-Fn"]);
    let unknown = "failure" in files ? `${files.failure} for pid ${pid}` : undefined;
    const homes = new Set([dirname(db)]);
    for (const line of "stdout" in files ? files.stdout.split("\n") : []) {
      if (line.startsWith("n") && basename(line.slice(1)) === "daemon.log") homes.add(dirname(line.slice(1)));
    }
    for (const candidate of homes) {
      try {
        const recordPath = join(candidate, "daemon.json");
        const record = JSON.parse(readFileSync(recordPath, "utf8"));
        const modifiedAt = statSync(recordPath).mtime.toISOString();
        if (record.pid !== pid || typeof record.db !== "string" || resolveForContainment(record.db) !== db
          || !Number.isInteger(record.port) || record.port < 1 || record.port > 65535) continue;
        // A matching record whose listener gives no answer, or an answer that can't be read, is unknown, not a
        // stale record. Only an answer that parses and names another pid is a definite non-match.
        const listener = `the listener recorded for pid ${pid} on port ${record.port}`;
        let response: Response;
        try {
          response = await fetch(`http://127.0.0.1:${record.port}/healthz`, { signal: AbortSignal.timeout(500) });
        } catch (error) {
          unknown = `${listener} ${(error as { name?: unknown }).name === "TimeoutError" ? "didn't answer within 500 ms" : "didn't answer"}`;
          continue;
        }
        if (!response.ok) continue;
        let health: { pid?: unknown };
        try {
          health = await response.json() as { pid?: unknown };
        } catch (error) {
          unknown = `${listener} ${(error as { name?: unknown }).name === "TimeoutError" ? "didn't finish answering within 500 ms" : "gave an answer that couldn't be read"}`;
          continue;
        }
        if (health?.pid !== pid) continue;
        return { confirmed: `At startup: Another live daemon (pid ${pid}) had database ${db} open. Matching record ${recordPath}, modified ${modifiedAt}: recorded home ${resolveForContainment(candidate)} (current home unconfirmed). This daemon's OPENRIG_HOME is ${resolvedHome}.` };
      } catch { /* A stale or unreadable record is not a live-daemon claim. */ }
    }
    return unknown === undefined ? undefined : { unknown };
  }));
  const confirmed = conflicts.flatMap(result => result && "confirmed" in result ? [result.confirmed] : []);
  if (confirmed.length && opts?.conflictPolicy === "stop" && !opts.allowConflict) {
    throw new Error(`OPENRIG_DB_CONFLICT: ${confirmed.join(" ")} Daemon startup stopped before opening the database (daemon.db_conflict=stop). Use separate database paths for independent instances. To proceed once deliberately, run rig daemon start --allow-db-conflict with the same options.`);
  }
  unverified.push(...conflicts.flatMap(result => result && "unknown" in result ? [result.unknown] : []));
  if (unverified.length) {
    warnings.push(`At startup: Couldn't verify whether another daemon has database ${db} open (${unverified.join("; ")}): ownership is unknown, not confirmed clear. Startup and database writes continue${opts?.conflictPolicy === "stop" ? "; daemon.db_conflict=stop stops only on a confirmed conflict" : ""}.`);
  }
  return [...warnings, ...confirmed.map(message => `${message} Startup and database writes continue; use separate database paths for independent instances.`)];
}
