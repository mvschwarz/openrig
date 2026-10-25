import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { parseStoredSeatEnv, type SeatEnv } from "./seat-env.js";

/** The native variable that selects each runtime's home, and with it the account that home is logged in to. */
export const RUNTIME_HOME_VAR = { "claude-code": "CLAUDE_CONFIG_DIR", codex: "CODEX_HOME" } as const;
export type HomeRuntime = keyof typeof RUNTIME_HOME_VAR;

export interface SeatRuntimeHome {
  /** The seat's own home: an absolute path its member, else its rig, declares in `env:`. */
  home?: string;
  source?: "member" | "rig";
  /** A declared value that isn't an absolute path. It isn't used as the seat's home, and nothing is refused for it: the
   *  seat resolves as it did before, and status reports the value. */
  ignored?: { source: "member" | "rig"; value: string };
}

/** A seat's own runtime home, read from its stored `env:` (member, then rig, as the launch merges them). It covers only
 *  the declaration: the daemon's explicit value and the native default stay with each caller, so a seat that declares
 *  nothing resolves exactly as before. A configured home names where the seat's runtime looks; it isn't proof of which
 *  login a running process uses. */
export function seatRuntimeHome(db: Database.Database, nodeId: string | null | undefined, runtime: HomeRuntime): SeatRuntimeHome {
  if (!nodeId) return {};
  let row: { member: string | null; rig: string | null } | undefined;
  try {
    row = db.prepare(`SELECT n.env_json AS member, r.env_json AS rig FROM nodes n JOIN rigs r ON r.id = n.rig_id WHERE n.id = ?`)
      .get(nodeId) as typeof row;
  } catch { return {}; } // A database from before seat env has no columns to read.
  const name = RUNTIME_HOME_VAR[runtime];
  for (const [source, json] of [["member", row?.member], ["rig", row?.rig]] as const) {
    const value = parseStoredSeatEnv(json)?.[name];
    if (value === undefined) continue;
    // The member's value shadows the rig's in the seat's environment, so the first declaration decides.
    return path.isAbsolute(value) ? { home: path.normalize(value), source } : { ignored: { source, value } };
  }
  return {};
}

/** The home a seat's launches and OpenRig's readers use: its own, else the daemon's explicit value. Undefined means the
 *  runtime's native default. */
export function effectiveRuntimeHome(db: Database.Database, nodeId: string | null | undefined, runtime: HomeRuntime,
  daemonHome: string | undefined): string | undefined {
  return seatRuntimeHome(db, nodeId, runtime).home ?? daemonHome;
}

/** Every distinct home seats declare for a runtime (absolute values only), for readers that find a record by an id that is
 *  unique across homes, such as a Codex thread, without knowing which seat owns it. */
export function declaredRuntimeHomes(db: Database.Database, runtime: HomeRuntime): string[] {
  const name = RUNTIME_HOME_VAR[runtime];
  const homes = new Set<string>();
  try {
    const rows = db.prepare(`SELECT env_json FROM nodes WHERE env_json IS NOT NULL UNION ALL SELECT env_json FROM rigs WHERE env_json IS NOT NULL`)
      .all() as Array<{ env_json: string }>;
    for (const { env_json } of rows) {
      const value = parseStoredSeatEnv(env_json)?.[name];
      if (value && path.isAbsolute(value)) homes.add(path.normalize(value));
    }
  } catch { /* A database from before seat env has no columns to read. */ }
  return [...homes];
}

/** A seat's env without a runtime-home variable whose value isn't an absolute path. OpenRig reports such a value as
 *  ignored, so the launch leaves it out too and the runtime resolves as if the seat declared none. */
export function withoutIgnoredRuntimeHomes(env: SeatEnv): SeatEnv {
  const out = { ...env };
  for (const name of Object.values(RUNTIME_HOME_VAR)) {
    const value = out[name];
    if (value !== undefined && !path.isAbsolute(value)) delete out[name];
  }
  return out;
}

/** The own home of the seat whose current session has this name (its newest session row), or undefined. */
export function seatRuntimeHomeBySession(db: Database.Database, sessionName: string, runtime: HomeRuntime): string | undefined {
  let row: { node_id: string } | undefined;
  try {
    row = db.prepare("SELECT node_id FROM sessions WHERE session_name = ? ORDER BY created_at DESC, id DESC LIMIT 1")
      .get(sessionName) as typeof row;
  } catch { return undefined; }
  return row ? seatRuntimeHome(db, row.node_id, runtime).home : undefined;
}

/** A one-off launch env without the runtime-home variables. A seat's home comes only from its stored `env:`, which restore,
 *  handover and status all read, so a one-off value would put the seat on a home nothing else reports or keeps. */
export function withoutRuntimeHomes(env: SeatEnv): SeatEnv {
  const out = { ...env };
  for (const name of Object.values(RUNTIME_HOME_VAR)) delete out[name];
  return out;
}

/** The Claude config root OpenRig reads for a seat: its own home when it declares one, else the daemon's selection, else
 *  `~/.claude`. */
export function claudeConfigRootFor(db: Database.Database, nodeId: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env, homeDir = os.homedir()): string {
  return seatRuntimeHome(db, nodeId, "claude-code").home ?? env.CLAUDE_CONFIG_DIR ?? path.join(homeDir, ".claude");
}
