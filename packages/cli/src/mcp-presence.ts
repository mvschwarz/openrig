// A hosted member's last call: `rig mcp serve --http` records when each token-file grant's seat last called, and rig_team
// reads it. It's presence, a fact about the member, never pickup (a claim on a row) and never "idle".
import fs from "node:fs";
import nodePath from "node:path";
import { getOpenRigHome } from "./openrig-compat.js";

/** The file, beside the token file and never in it (that stays auth config, as rig mcp token writes it). */
export const MCP_PRESENCE_FILE = "mcp-http-presence.json";

export function mcpPresenceFilePath(home: string = getOpenRigHome()): string {
  return nodePath.join(home, MCP_PRESENCE_FILE);
}

/** A seat's last authenticated call to this host's MCP server, and the grant that made it. */
export type McpCallPresence = { grant: string; lastCallAt: string };

/** Each seat's last recorded call. None recorded, or a file that can't be read, is an empty map: unknown, never idle. */
export function readPresence(file: string): Record<string, McpCallPresence> {
  try {
    const seats = (JSON.parse(fs.readFileSync(file, "utf8")) as { seats?: unknown } | null)?.seats;
    if (!seats || typeof seats !== "object" || Array.isArray(seats)) return {};
    const out: Record<string, McpCallPresence> = {};
    for (const [seat, value] of Object.entries(seats as Record<string, unknown>)) {
      const entry = (value ?? {}) as Record<string, unknown>;
      if (typeof entry.grant === "string" && typeof entry.lastCallAt === "string") out[seat] = { grant: entry.grant, lastCallAt: entry.lastCallAt };
    }
    return out;
  } catch {
    return {};
  }
}

/** Records a seat's call at most once per interval for this server, by atomic rename (several servers: the last writer
 *  wins). Presence is a convenience: a write that fails is logged here and never refuses the caller. */
export function presenceRecorder(file: string, intervalMs = 60_000, now: () => number = Date.now): (seat: string, grant: string) => void {
  const lastWrite = new Map<string, number>();
  return (seat, grant) => {
    const at = now();
    if (at - (lastWrite.get(seat) ?? Number.NEGATIVE_INFINITY) < intervalMs) return;
    lastWrite.set(seat, at);
    try {
      const seats = readPresence(file);
      seats[seat] = { grant, lastCallAt: new Date(at).toISOString() };
      const temp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(temp, `${JSON.stringify({ version: 1, seats }, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(temp, file);
    } catch (err) {
      console.error(`rig mcp serve --http: couldn't record ${seat}'s call: ${(err as Error).message}`);
    }
  };
}
