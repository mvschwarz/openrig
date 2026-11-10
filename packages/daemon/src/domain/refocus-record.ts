import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** What a seat's own OpenRig refocus hook has recorded, read from that hook's state files
 *  (`<home>/refocus/<session>__<conversation>.json`, written by the openrig-core plugin's hooks/scripts/refocus.cjs on
 *  its first prompt or compaction in a conversation, and after). It reports what ran, never readiness from
 *  configuration. */
export interface RefocusRecord {
  /** When the hook last wrote a record for this seat, in any conversation; null when it never has. */
  lastRecordedAt: string | null;
  /** Whether a record exists for the seat's current conversation (its resume token); unknown without a resume token. */
  currentConversation: boolean | "unknown";
  /** The hook ran without a conversation identity, so it couldn't measure; its no-identity marker is active. */
  noIdentity?: true;
  detail: string;
}

// Keep these two identical to refocus.cjs's `sanitize` and `keyFor`, which name the files read here.
const sanitize = (raw: string) => raw.replace(/[^A-Za-z0-9@._-]/g, "_");
const keyFor = (raw: string) => {
  const bounded = sanitize(raw).slice(0, 64);
  return bounded === raw ? bounded : `${bounded}__${createHash("sha256").update(raw).digest("hex").slice(0, 8)}`;
};

export function readRefocusRecord(home: string, sessionName: string, resumeToken: string | null): RefocusRecord {
  const dir = join(home, "refocus");
  const seatKey = sanitize(sessionName);
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { /* no refocus state on this host */ }
  let newest = 0;
  for (const name of names) {
    if (!name.startsWith(`${seatKey}__`) || !name.endsWith(".json")) continue;
    try { newest = Math.max(newest, statSync(join(dir, name)).mtimeMs); } catch { /* removed meanwhile */ }
  }
  let noIdentity = false;
  try { noIdentity = JSON.parse(readFileSync(join(dir, `${seatKey}#no-identity-sentinel.json`), "utf8"))?.activeEpisode === true; } catch { /* none */ }
  const currentConversation = resumeToken ? names.includes(`${seatKey}__${keyFor(resumeToken)}.json`) : "unknown" as const;
  const lastRecordedAt = newest ? new Date(newest).toISOString() : null;
  const detail = noIdentity
    ? "OpenRig's refocus hook runs in this seat but gets no conversation identity, so it can't measure or refocus."
    : currentConversation === true
      ? "OpenRig's refocus hook has recorded this seat's current conversation."
      : lastRecordedAt
        ? `OpenRig's refocus hook last recorded this seat at ${lastRecordedAt}, but ${currentConversation === "unknown"
          ? "the seat has no resume token to tell whether that's its current conversation" : "not in its current conversation yet"}. It records at the first prompt or compaction it sees.`
        : "OpenRig's refocus hook has no record for this seat. It runs only where the seat selected the openrig-core plugin, and for Codex only in a launch that set OPENRIG_SEAT_PROJECT_DIR, so a Codex seat launched before that needs its next launch. Other refocus hooks aren't inspected.";
  return { lastRecordedAt, currentConversation, ...(noIdentity ? { noIdentity: true as const } : {}), detail };
}
