import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import type Database from "better-sqlite3";
import { lstartToMinTs } from "./codex-thread-id.js";

/**
 * OPR.0.7.0.7 — one seat's reasoning effort, from the saved choice to what the native session runs.
 *
 * Four values stay distinct: requested (the last `rig seat set-effort`), saved (this resolution),
 * emitted (the flag the running process was launched with) and observed (what the native session
 * records for a turn it took). Only the last one says which effort the model used.
 */

/** What a seat's managed launch sends: its explicit choice, else the authored/default resolution in
 *  nodes.effort, else no flag at all (the runtime's own default). */
export interface EffortResolution {
  choice: string | null;
  authored: string | null;
  effective: string | null;
  source: "seat_choice" | "authored" | "runtime_default";
}

/** The one resolver every managed continuation (fresh, successor, in-place restart) reads. */
export function resolveSeatEffort(node: { effort?: string | null; effortChoice?: string | null }): EffortResolution {
  const choice = node.effortChoice?.trim() || null;
  const authored = node.effort?.trim() || null;
  const effective = choice ?? authored;
  return { choice, authored, effective, source: choice ? "seat_choice" : authored ? "authored" : "runtime_default" };
}

/** The seat's resolution from its node row. null: no such node. A database older than the
 *  effort_choice column resolves from nodes.effort alone, as launches did before it existed. */
export function readSeatEffort(db: Database.Database, nodeId: string): EffortResolution | null {
  try {
    const row = db.prepare("SELECT effort, effort_choice FROM nodes WHERE id = ?").get(nodeId) as
      | { effort: string | null; effort_choice: string | null } | undefined;
    return row ? resolveSeatEffort({ effort: row.effort, effortChoice: row.effort_choice }) : null;
  } catch {
    try {
      const row = db.prepare("SELECT effort FROM nodes WHERE id = ?").get(nodeId) as { effort: string | null } | undefined;
      return row ? resolveSeatEffort({ effort: row.effort }) : null;
    } catch {
      return null;
    }
  }
}

/**
 * The founder's open precedence decision (OPR.0.7.0.7 "Open, with owner"): what restoring an older
 * snapshot and refreshing the spec do with a seat's saved effort choice. Every such writer asks this
 * one seam, so the decided rule replaces `effortPrecedence` here and nowhere else.
 */
export interface EffortPrecedenceRule {
  /** false until the founder decides. */
  readonly decided: boolean;
  readonly detail: string;
  /** The effort a snapshot restore launches the seat with. `snapshot` is the node as the snapshot
   *  captured it; `live` is the seat's current resolution (null when the node row is gone). */
  restoreLaunchEffort(input: { snapshot: { effort?: string | null; effortChoice?: string | null }; live: EffortResolution | null }):
    { effort: string | null; warning?: string };
  /** Whether a spec refresh keeps or clears the seat's saved choice (it always rewrites the authored value). */
  specRefreshChoice(input: { choice: string | null; authoredBefore: string | null; authoredAfter: string | null }): "keep" | "clear";
}

/** No rule is picked. Each writer keeps what it did before seat choices existed: a restore launches
 *  the snapshot's authored effort and says so when the seat's saved choice differs; a spec refresh
 *  rewrites only the authored value. Neither writes or deletes the saved choice. */
export const UNDECIDED_EFFORT_PRECEDENCE: EffortPrecedenceRule = {
  decided: false,
  detail: "Precedence between a seat's saved effort and an older snapshot or a spec refresh is the founder's open decision; until then each keeps its earlier behaviour and nothing deletes the saved choice.",
  restoreLaunchEffort({ snapshot, live }) {
    const effort = snapshot.effort?.trim() || null;
    if (!live?.choice || live.choice === effort) return { effort };
    return {
      effort,
      warning: `Effort: this restore launched ${effort ?? "with no effort flag"} from the snapshot, not the seat's saved choice ${live.choice}; which wins is an open decision. The saved choice is kept for the next managed continuation.`,
    };
  },
  specRefreshChoice: () => "keep",
};

export const effortPrecedence: EffortPrecedenceRule = UNDECIDED_EFFORT_PRECEDENCE;

export type EffortRuntime = "claude-code" | "codex";

/** The effort a launch command line carries. "none": parsed, and it sends no effort flag. */
export function emittedEffortFromArgv(runtime: EffortRuntime, argv: string[]): { flag: "present"; value: string } | { flag: "none" } {
  let found: string | null = null;
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (runtime === "claude-code") {
      if (arg === "--effort") { found = argv[index + 1] ?? null; index += 1; }
      else if (arg.startsWith("--effort=")) found = arg.slice("--effort=".length);
    } else {
      let config: string | undefined;
      if (arg === "-c" || arg === "--config") { config = argv[index + 1]; index += 1; }
      else if (arg.startsWith("--config=")) config = arg.slice("--config=".length);
      const match = config?.match(/^model_reasoning_effort\s*=\s*(.*)$/);
      if (match) found = match[1]!.trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
    }
  }
  return found ? { flag: "present", value: found } : { flag: "none" };
}

export type NativeEffortObservation =
  | { state: "observed"; value: string; at: string; source: string }
  | { state: "not_verified"; detail: string };

const TAIL_BYTES = 4_000_000;

/**
 * The effort the native session recorded for its latest turn since `processStartedAt` (ps lstart):
 * Claude writes it on each assistant entry of its transcript, Codex on each turn_context line of its
 * rollout. A turn before the process started belongs to an earlier launch of the same conversation,
 * so it is never reported as this launch's effort.
 */
export function readNativeEffort(runtime: EffortRuntime, transcriptPath: string | null, processStartedAt: string | null): NativeEffortObservation {
  if (!transcriptPath) return { state: "not_verified", detail: "The native transcript for this session isn't known to OpenRig." };
  const since = lstartToMinTs(processStartedAt ?? undefined);
  if (since === undefined) return { state: "not_verified", detail: "The running process's start time could not be read, so a turn can't be tied to this launch." };
  let text: string;
  try {
    text = readTail(transcriptPath, TAIL_BYTES);
  } catch (error) {
    return { state: "not_verified", detail: `The native transcript could not be read: ${(error as Error).message}` };
  }
  const lines = text.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!.trim();
    if (!line.includes("ffort")) continue;
    let entry: Record<string, unknown>;
    try { entry = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    const at = typeof entry["timestamp"] === "string" ? entry["timestamp"] : null;
    let value: unknown;
    if (runtime === "claude-code") {
      if (entry["type"] !== "assistant") continue;
      value = entry["effort"];
    } else {
      if (entry["type"] !== "turn_context") continue;
      value = (entry["payload"] as Record<string, unknown> | undefined)?.["effort"];
    }
    if (typeof value !== "string" || !value.trim() || !at) continue;
    const atMs = Date.parse(at);
    // lstart has one-second resolution: a turn in the launch's own second counts.
    if (Number.isNaN(atMs) || Math.floor(atMs / 1000) < since) break;
    return {
      state: "observed", value: value.trim(), at,
      source: runtime === "claude-code" ? "Claude transcript (latest assistant turn)" : "Codex rollout (latest turn_context)",
    };
  }
  return { state: "not_verified", detail: "The session has recorded no turn with an effort since this process started; it shows once the seat takes a turn." };
}

function readTail(filePath: string, maxBytes: number): string {
  const fd = openSync(filePath, "r");
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return buffer.toString("utf-8");
  } finally {
    closeSync(fd);
  }
}
