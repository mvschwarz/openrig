import { readFileSync } from "node:fs";
import type Database from "better-sqlite3";
import { guidanceFileKey, managedBlockBodyHash } from "./managed-block-records.js";
import { managedBlockBodies, managedBlockOpenings } from "./managed-blocks.js";

/** When OpenRig last wrote each of its blocks in a seat's guidance file, set against a recorded moment of the running
 *  session: when its startup finished (a launched session), or when OpenRig recorded it (a claimed session, whose process
 *  was already running). That's chronology, not loading: the harness reads the file earlier in startup, a readiness
 *  recovery can set the startup mark later, and an agent can read the file, or be sent it, at any time. Nothing records
 *  what an agent read, so this never says a block reached the agent. Unknown stays unknown. */
export interface GuidanceProjection {
  file: string;
  /** The recorded session moment the writes are set against, or null when the session has none to use. */
  mark: { at: string; kind: "startup_finished" | "session_recorded" } | null;
  /** OpenRig's blocks now in the file, in file order: written `before` or `after` the mark, or `unknown` with the reason
   *  (no write record, only part of a block, bytes that differ from OpenRig's last recorded write, a time that can't be
   *  read, no mark, or a write before a claimed session was recorded). `before` is only that: it doesn't mean the agent
   *  had the block. */
  blocks: Array<{ id: string; writtenAt: string | null; written: "before" | "after" | "unknown"; reason?: string }>;
  detail: string;
}

/** The session the agent runs in, as OpenRig recorded it. */
export interface GuidanceSession {
  origin: "launched" | "claimed";
  createdAt: string | null;
  startupCompletedAt: string | null;
}

const BLOCK_START = /<!-- BEGIN OpenRig MANAGED BLOCK: (.+?) -->/g;

/** A recorded time in milliseconds, or null when it can't be read. SQLite's `datetime('now')` text is UTC without a zone. */
function timeMs(at: string | null): number | null {
  if (!at) return null;
  const ms = Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(at) ? `${at.replace(" ", "T")}Z` : at);
  return Number.isFinite(ms) ? ms : null;
}

export function readGuidanceProjection(input: {
  db: Pick<Database.Database, "prepare">;
  file: string;
  runtime: string | null;
  session: GuidanceSession | null;
  readFile?: (path: string) => string;
}): GuidanceProjection {
  const { file, session } = input;
  let content: string;
  try {
    content = (input.readFile ?? ((path) => readFileSync(path, "utf8")))(file);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "unreadable";
    return { file, mark: null, blocks: [],
      detail: code === "ENOENT" ? `${file} doesn't exist, so it holds no OpenRig guidance.`
        : `${file} couldn't be read (${code}), so what OpenRig wrote there is unknown.` };
  }
  const ids = [...new Set([...content.matchAll(BLOCK_START)].map((match) => match[1]!))];
  if (ids.length === 0) return { file, mark: null, blocks: [], detail: `${file} holds no OpenRig guidance blocks.` };

  let records: Map<string, { writtenAt: string; hash: string }> | null = new Map();
  let recordProblem: string | undefined;
  try {
    const rows = input.db.prepare("SELECT block_id, body_sha256, written_at FROM managed_block_writes WHERE path_key = ?")
      .all(guidanceFileKey(file)) as Array<{ block_id: string; body_sha256: string; written_at: string }>;
    for (const row of rows) records.set(row.block_id, { writtenAt: row.written_at, hash: row.body_sha256 });
  } catch (err) {
    records = null;
    recordProblem = (err as Error).message;
  }

  const mark: GuidanceProjection["mark"] = session?.origin === "launched" && session.startupCompletedAt
    ? { at: session.startupCompletedAt, kind: "startup_finished" }
    : session?.origin === "claimed" && session.createdAt ? { at: session.createdAt, kind: "session_recorded" } : null;
  const markMs = timeMs(mark?.at ?? null);
  const unknown = (id: string, reason: string, writtenAt: string | null = null) => ({ id, writtenAt, written: "unknown" as const, reason });
  const blocks: GuidanceProjection["blocks"] = ids.map((id) => {
    if (!records) return unknown(id, "OpenRig's write records couldn't be read");
    const record = records.get(id);
    if (!record) return unknown(id, "no write record");
    // The record's time belongs to the bytes OpenRig wrote: an edit since, or a later write whose record didn't save, isn't them.
    // A copy missing its END has no body to compare, so it gets no time either.
    const bodies = managedBlockBodies(content, id);
    if (bodies.length !== managedBlockOpenings(content, id)) return unknown(id, "holds only part of this block");
    if (!bodies.every((body) => managedBlockBodyHash(body) === record.hash)) {
      return unknown(id, "differs from OpenRig's last recorded write");
    }
    const writtenMs = timeMs(record.writtenAt);
    if (writtenMs === null) return unknown(id, "its write time can't be read", record.writtenAt);
    if (!mark) return unknown(id, session ? "this session has no recorded startup finish" : "no session is recorded", record.writtenAt);
    if (markMs === null) return unknown(id, "the session time can't be read", record.writtenAt);
    if (writtenMs > markMs) return { id, writtenAt: record.writtenAt, written: "after" as const };
    return mark.kind === "session_recorded"
      ? unknown(id, "written before OpenRig recorded this session, whose process was already running", record.writtenAt)
      : { id, writtenAt: record.writtenAt, written: "before" as const };
  });

  const after = blocks.filter((block) => block.written === "after");
  const before = blocks.filter((block) => block.written === "before").length;
  const unplaced = blocks.filter((block) => block.written === "unknown");
  const reasons = [...new Set(unplaced.map((block) => block.reason!))]
    .map((reason) => `${reason}: ${unplaced.filter((block) => block.reason === reason).length}`);
  const moment = mark?.kind === "session_recorded" ? `OpenRig recorded this session at ${mark.at}` : `this session's recorded startup finish at ${mark?.at}`;
  const parts = recordProblem
    ? [`OpenRig's write records couldn't be read (${recordProblem}), so when its ${ids.length} blocks in ${file} were written is unknown.`]
    : [
      `Of the ${ids.length} OpenRig blocks in ${file}, ${after.length} ${after.length === 1 ? "was" : "were"} written after ${mark ? moment : "a recorded moment of this session"}${after.length ? ` (${after.map((block) => block.id).join(", ")})` : ""}, ${before} before it, and ${unplaced.length} can't be placed${reasons.length ? ` (${reasons.join("; ")})` : ""}.`,
      mark?.kind === "startup_finished"
        ? "That's chronology, not loading: the harness reads the file earlier in startup, and a readiness recovery can set the mark later."
        : "That's chronology, not loading.",
    ];
  parts.push(input.runtime === "claude-code"
    ? "Claude Code reloads CLAUDE.md at session start and after /compact or /clear; a running agent can also read the file itself, or be sent it with rig send, rig walk or the refocus hook."
    : "Codex reads AGENTS.md at session start (whether a resume re-reads it isn't established); a running agent can also read the file itself, or be sent it with rig send, rig walk or the refocus hook.");
  parts.push("OpenRig doesn't record what an agent read.");
  return { file, mark, blocks, detail: parts.join(" ") };
}
