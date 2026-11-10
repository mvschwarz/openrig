import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** What a seat's own OpenRig refocus hook has recorded, read from that hook's state files
 *  (`<home>/refocus/<session>__<conversation>.json`, written by the openrig-core plugin's hooks/scripts/refocus.cjs on
 *  its first prompt or compaction in a conversation, and after). It reports the hook's record: not that a refocus
 *  succeeded, that the hook loads now, or that the agent used the context. Unknown is reported as unknown. */
export interface RefocusRecord {
  /** When the hook last wrote a valid record for this seat, in any conversation; null when it never has, and "unknown"
   *  when the state can't be read or a record under this seat's name might belong to another seat. */
  lastRecordedAt: string | null | "unknown";
  /** Whether a valid record exists for the seat's current conversation (its resume token); unknown without a resume
   *  token, or when that record or the state folder can't be read. */
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

/** A state file the hook wrote whole: an object with its baseline or byte count. A truncated or empty file isn't. */
function validRecord(file: string): { ok: true; mtimeMs: number } | { ok: false; reason: string } {
  try {
    const state: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!state || typeof state !== "object" || (typeof (state as Record<string, unknown>).baselineAt !== "string"
      && typeof (state as Record<string, unknown>).lastBytes !== "number")) return { ok: false, reason: "not a refocus record" };
    return { ok: true, mtimeMs: statSync(file).mtimeMs };
  } catch (err) {
    return { ok: false, reason: (err as NodeJS.ErrnoException).code ?? "unreadable" };
  }
}

export function readRefocusRecord(home: string, sessionName: string, resumeToken: string | null): RefocusRecord {
  const dir = join(home, "refocus");
  const seatKey = sanitize(sessionName);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "unreadable";
    if (code !== "ENOENT") {
      return { lastRecordedAt: "unknown", currentConversation: "unknown", detail: `OpenRig's refocus state at ${dir} couldn't be read (${code}), so whether this seat's refocus hook has run is unknown.` };
    }
    names = [];
  }
  let noIdentity = false;
  try { noIdentity = JSON.parse(readFileSync(join(dir, `${seatKey}#no-identity-sentinel.json`), "utf8"))?.activeEpisode === true; } catch { /* none */ }

  // The current conversation's file is named exactly, so it can't be another seat's; its content still has to be whole.
  let currentConversation: boolean | "unknown" = "unknown";
  let currentProblem: string | undefined;
  if (resumeToken) {
    const name = `${seatKey}__${keyFor(resumeToken)}.json`;
    if (!names.includes(name)) currentConversation = false;
    else {
      const record = validRecord(join(dir, name));
      if (record.ok) currentConversation = true;
      else currentProblem = record.reason;
    }
  }

  // History: another seat whose name extends this one (sample@rig__other beside sample@rig) writes
  // `sample@rig__other__<conversation>.json`, so after this seat's prefix its files always carry another "__". A file
  // without one is this seat's; a file with one may not be, and then the history is unknown rather than borrowed.
  let newest = 0;
  let ambiguous = false;
  let historyProblem: string | undefined;
  for (const name of names) {
    if (!name.startsWith(`${seatKey}__`) || !name.endsWith(".json")) continue;
    if (name.slice(seatKey.length + 2, -".json".length).includes("__")) { ambiguous = true; continue; }
    // A record that can't be read or isn't whole might be the newest, so the history is unknown, never older or absent.
    const record = validRecord(join(dir, name));
    if (record.ok) newest = Math.max(newest, record.mtimeMs);
    else historyProblem ??= record.reason;
  }
  const lastRecordedAt = ambiguous || historyProblem ? "unknown" : newest ? new Date(newest).toISOString() : null;

  const detail = noIdentity
    ? "OpenRig's refocus hook runs in this seat but gets no conversation identity, so it can't measure or refocus."
    : currentConversation === true
      ? "OpenRig's refocus hook has a record for this seat's current conversation."
      : currentProblem
        ? `This seat's refocus record for its current conversation can't be read (${currentProblem}), so whether the hook ran in it is unknown.`
        : historyProblem
          ? `One of this seat's earlier refocus records can't be read (${historyProblem}), so when the hook last recorded this seat is unknown${currentConversation === false ? "; it has no record for the current conversation" : ""}.`
        : lastRecordedAt === "unknown"
          ? `A refocus record under this seat's name may belong to another seat whose name begins with it, so when the hook last recorded this seat is unknown${currentConversation === false ? "; it has no record for the current conversation" : ""}.`
          : lastRecordedAt
            ? `OpenRig's refocus hook last recorded this seat at ${lastRecordedAt}, but ${currentConversation === "unknown"
              ? "the seat has no resume token to tell whether that's its current conversation" : "not in its current conversation yet"}. It records at the first prompt or compaction it sees.`
            : "OpenRig's refocus hook has no record for this seat. It runs only where the seat selected the openrig-core plugin, and for Codex only in a launch that set OPENRIG_SEAT_PROJECT_DIR, so a Codex seat launched before that needs its next launch. Other refocus hooks aren't inspected.";
  return { lastRecordedAt, currentConversation, ...(noIdentity ? { noIdentity: true as const } : {}), detail };
}
