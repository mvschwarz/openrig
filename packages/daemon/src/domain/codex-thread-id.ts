import os from "node:os";
import nodePath from "node:path";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";

export type ResolveHomeDirByPid = (pid: number) => string | undefined;

export function defaultResolveHomeDirByPid(pid: number): string | undefined {
  try {
    // BSD/macOS `ps` supports `eww` to expose the full process environment.
    // If OpenRig grows a Linux daemon target, this likely needs a /proc-based path.
    const output = execFileSync("ps", ["eww", "-p", String(pid), "-o", "command="], { encoding: "utf-8" }).trim();
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
  const dbPath = nodePath.join(homeDir, ".codex", "logs_1.sqlite");
  if (exists && !exists(dbPath)) return undefined;

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
      return row?.thread_id;
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
}
