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
async function lsof(args: string[]): Promise<string> {
  try {
    return (await execFileAsync("lsof", args, { timeout: 1000, maxBuffer: 64 * 1024 })).stdout;
  } catch { return ""; }
}

/** Boot-time diagnostics only, never exclusion or permission to share a DB.
 * Missing tools, inaccessible records and races leave ownership unknown. */
export async function daemonDatabaseWarnings(dbPath: string, home: string, selectedBy?: string): Promise<string[]> {
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
  const holders = await lsof(["-t", "--", db]);
  const pids = [...new Set(holders.trim().split(/\s+/).map(Number))]
    .filter(pid => Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid).slice(0, 4);
  const conflicts = await Promise.all(pids.map(async (pid) => {
    const files = await lsof(["-a", "-p", String(pid), "-d", "1,2", "-Fn"]);
    const homes = new Set([dirname(db)]);
    for (const line of files.split("\n")) {
      if (line.startsWith("n") && basename(line.slice(1)) === "daemon.log") homes.add(dirname(line.slice(1)));
    }
    for (const candidate of homes) {
      try {
        const recordPath = join(candidate, "daemon.json");
        const record = JSON.parse(readFileSync(recordPath, "utf8"));
        const modifiedAt = statSync(recordPath).mtime.toISOString();
        if (record.pid !== pid || typeof record.db !== "string" || resolveForContainment(record.db) !== db
          || !Number.isInteger(record.port) || record.port < 1 || record.port > 65535) continue;
        const response = await fetch(`http://127.0.0.1:${record.port}/healthz`, { signal: AbortSignal.timeout(500) });
        if (!response.ok || (await response.json() as { pid?: unknown }).pid !== pid) continue;
        return `At startup: Another live daemon (pid ${pid}) had database ${db} open. Matching record ${recordPath}, modified ${modifiedAt}: recorded home ${resolveForContainment(candidate)} (current home unconfirmed). This daemon's OPENRIG_HOME is ${resolvedHome}. Startup and database writes continue; use separate database paths for independent instances.`;
      } catch { /* A stale/unreadable record or failed probe is not a live-daemon claim. */ }
    }
    return undefined;
  }));
  return [...warnings, ...conflicts.filter((message): message is string => message !== undefined)];
}
