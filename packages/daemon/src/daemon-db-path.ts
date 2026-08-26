import { lstatSync, readlinkSync, realpathSync } from "node:fs";
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
