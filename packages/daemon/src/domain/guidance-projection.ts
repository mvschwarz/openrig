import { readFileSync } from "node:fs";
import type Database from "better-sqlite3";
import { guidanceFileKey } from "./managed-block-records.js";

/** What OpenRig has written into a seat's guidance file, set against when the running agent last loaded that file. A
 *  block written after that moment is projected, not yet in the agent's context: Claude Code reads CLAUDE.md at session
 *  start and again after /compact or /clear, and Codex reads AGENTS.md at session start. Nothing records what an agent
 *  actually read, so this never says a block was used; it says whether the agent could have it. Unknown stays unknown. */
export interface GuidanceProjection {
  file: string;
  /** The moment the running agent loaded its guidance, as OpenRig knows it, or null when it can't tell. */
  loadedAt: { at: string; basis: "startup_completed" | "claimed" } | null;
  /** OpenRig's blocks now in the file, in file order. `loaded`: `before` was in the file when the agent loaded it,
   *  `after` was written since, `unknown` can't be placed (no write record, or no load moment to compare with). */
  blocks: Array<{ id: string; writtenAt: string | null; loaded: "before" | "after" | "unknown" }>;
  detail: string;
}

/** The session the agent runs in: a launched session finishes its startup after the harness loaded its guidance; a
 *  claimed session's process was already running when OpenRig recorded it, so only later writes can be placed. */
export interface GuidanceSession {
  origin: "launched" | "claimed";
  createdAt: string | null;
  startupCompletedAt: string | null;
}

const BLOCK_START = /<!-- BEGIN OpenRig MANAGED BLOCK: (.+?) -->/g;

/** SQLite's `datetime('now')` text is UTC without a zone; ISO text passes through. */
function utcMs(at: string): number {
  return Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(at) ? `${at.replace(" ", "T")}Z` : at);
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
    return { file, loadedAt: null, blocks: [],
      detail: code === "ENOENT" ? `${file} doesn't exist, so it holds no OpenRig guidance.`
        : `${file} couldn't be read (${code}), so what OpenRig wrote there is unknown.` };
  }
  const ids = [...content.matchAll(BLOCK_START)].map((match) => match[1]!);
  if (ids.length === 0) return { file, loadedAt: null, blocks: [], detail: `${file} holds no OpenRig guidance blocks.` };

  let times: Map<string, string> | null = new Map();
  let recordProblem: string | undefined;
  try {
    const rows = input.db.prepare("SELECT block_id, written_at FROM managed_block_writes WHERE path_key = ?")
      .all(guidanceFileKey(file)) as Array<{ block_id: string; written_at: string }>;
    for (const row of rows) times.set(row.block_id, row.written_at);
  } catch (err) {
    times = null;
    recordProblem = (err as Error).message;
  }

  const loadedAt: GuidanceProjection["loadedAt"] = session?.origin === "launched" && session.startupCompletedAt
    ? { at: session.startupCompletedAt, basis: "startup_completed" }
    : session?.origin === "claimed" && session.createdAt ? { at: session.createdAt, basis: "claimed" } : null;
  const blocks = ids.map((id) => {
    const writtenAt = times?.get(id) ?? null;
    if (!writtenAt || !loadedAt) return { id, writtenAt, loaded: "unknown" as const };
    if (utcMs(writtenAt) > utcMs(loadedAt.at)) return { id, writtenAt, loaded: "after" as const };
    // A claimed process started at some unknown moment before OpenRig recorded it, so an earlier write can't be placed.
    return { id, writtenAt, loaded: loadedAt.basis === "claimed" ? "unknown" as const : "before" as const };
  });

  const after = blocks.filter((block) => block.loaded === "after");
  const reread = input.runtime === "claude-code"
    ? "Claude Code reads it at session start and again after /compact or /clear, so the running agent has them only if it has compacted, cleared or restarted since"
    : "Codex reads it at session start, so the running agent has them only if it has restarted since (whether a Codex resume re-reads it isn't established)";
  const since = loadedAt ? (loadedAt.basis === "claimed" ? `OpenRig recorded this session at ${loadedAt.at}` : `this session's startup finished at ${loadedAt.at}`) : "";
  const parts = [
    recordProblem ? `OpenRig's write records couldn't be read (${recordProblem}), so when its ${ids.length} blocks in ${file} were written is unknown.`
      : after.length > 0 ? `${after.length} of the ${ids.length} OpenRig blocks in ${file} were written after ${since} (${after.map((block) => block.id).join(", ")}). ${reread}.`
      : !loadedAt ? `When the running agent loaded ${file} is unknown${session ? ", because this session has no recorded startup finish" : ", because no session is recorded"}, so whether it has OpenRig's ${ids.length} blocks there is unknown.`
      : `None of the ${ids.length} OpenRig blocks in ${file} was written after ${since}.`,
  ];
  const earlier = loadedAt?.basis === "claimed" ? blocks.filter((block) => block.writtenAt && block.loaded === "unknown").length : 0;
  if (earlier > 0) parts.push(`This session's process was already running when OpenRig recorded it, so whether the ${earlier} block${earlier === 1 ? "" : "s"} written before then ${earlier === 1 ? "was" : "were"} there when it started is unknown.`);
  const unrecorded = blocks.filter((block) => !block.writtenAt).length;
  if (!recordProblem && unrecorded > 0) parts.push(`${unrecorded} block${unrecorded === 1 ? " has" : "s have"} no write record, so ${unrecorded === 1 ? "it" : "they"} can't be placed.`);
  parts.push("OpenRig doesn't record what an agent read.");
  return { file, loadedAt, blocks, detail: parts.join(" ") };
}
