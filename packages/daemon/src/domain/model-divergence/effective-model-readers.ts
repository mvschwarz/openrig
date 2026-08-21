// B8 / slice-07 A3 — per-runtime EFFECTIVE-model reads (the load-bearing signal).
//
// The detector compares effective vs pinned; these readers own "effective". Both specimens proved
// the REQUESTED echo lies (the codex banner kept naming the pinned model while the footer ran a
// fallback), so each read comes from the runtime's own record of what is actually answering:
//   - claude-code: the last assistant message's `message.model` in the provider transcript — the
//     API response names the model that produced it. Absent until the seat's first assistant turn.
//   - codex: the latest `world_state` event's `collaboration_mode.model` in the rollout.
//
// BOUNDED READS by contract: provider records on live seats reach hundreds of MB (a whole-file
// readFileSync throws ERR_STRING_TOO_LONG past ~0.5GB and stalls the loop long before that — the
// B12 lesson). The claude signal recurs every assistant turn, so a single 512KB tail always holds
// it on a live seat. The codex world_state is SPARSE (r1 measured a 65.9MB rollout whose newest
// record sat 0.80MB from EOF — outside one tail window), so the codex reader scans BACKWARD in
// tail-sized chunks up to MAX_SCAN_BYTES. A signal older than the scan cap reads as null (honest
// UNKNOWN — the detector reports it as observable pending), never a guess.

import { openSync, readSync, closeSync, fstatSync } from "node:fs";

const TAIL_BYTES = 512 * 1024;
const MAX_SCAN_BYTES = 8 * 1024 * 1024;

/** Read at most the last TAIL_BYTES of a file as utf-8, split into whole lines (the first,
 *  possibly-truncated line is dropped). Missing/unreadable → []. */
export function readTailLines(path: string, tailBytes = TAIL_BYTES): string[] {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return [];
  }
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - tailBytes);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString("utf-8").split("\n");
    if (start > 0) lines.shift(); // first line may be cut mid-record
    return lines;
  } catch {
    return [];
  } finally {
    closeSync(fd);
  }
}

/** The model that produced the seat's newest assistant turn, or null when no turn is in the tail
 *  window (a just-launched seat has none — the detector treats null as PENDING, not as a match). */
export function readClaudeEffectiveModel(transcriptPath: string): string | null {
  const lines = readTailLines(transcriptPath);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line.includes('"assistant"') || !line.includes('"model"')) continue;
    try {
      const obj = JSON.parse(line) as { type?: unknown; message?: { role?: unknown; model?: unknown } };
      if (obj.message?.role === "assistant" && typeof obj.message.model === "string" && obj.message.model.length > 0) {
        return obj.message.model;
      }
    } catch {
      /* corrupt line — keep scanning */
    }
  }
  return null;
}

function newestCodexModel(lines: string[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    // PRIMARY: turn_context.payload.model — present in BOTH rollout formats observed live (old
    // July-era records carry NO collaboration_mode in world_state; turn_context.model exists in
    // both and recurs every turn, so it sits near EOF on a live seat).
    if (line.includes('"turn_context"')) {
      try {
        const obj = JSON.parse(line) as { type?: unknown; payload?: { model?: unknown } };
        if (obj.type === "turn_context") {
          const model = obj.payload?.model;
          if (typeof model === "string" && model.length > 0) return model;
        }
      } catch {
        /* corrupt line — keep scanning */
      }
    }
    // BELT: world_state.collaboration_mode.model (the new-format state snapshot).
    if (line.includes('"world_state"')) {
      try {
        const obj = JSON.parse(line) as {
          type?: unknown;
          payload?: { state?: { collaboration_mode?: { model?: unknown } } };
        };
        if (obj.type === "world_state") {
          const model = obj.payload?.state?.collaboration_mode?.model;
          if (typeof model === "string" && model.length > 0) return model;
        }
      } catch {
        /* corrupt line — keep scanning */
      }
    }
  }
  return null;
}

/** The codex runtime's own current model per its NEWEST turn_context (primary; both rollout
 *  formats) or world_state collaboration_mode (belt). Scans backward from EOF in tail-sized
 *  windows up to MAX_SCAN_BYTES: the signal is sparse relative to bulk event lines (r1's live
 *  census put records 0.4-0.8MB from EOF on the big rollouts), so one tail window is not always
 *  enough, but 8MB bounds the read far under the loop-stall class. */
export function readCodexEffectiveModel(rolloutPath: string, maxScanBytes = MAX_SCAN_BYTES): string | null {
  let fd: number;
  try {
    fd = openSync(rolloutPath, "r");
  } catch {
    return null;
  }
  try {
    const size = fstatSync(fd).size;
    const scanFloor = Math.max(0, size - maxScanBytes);
    let end = size;
    while (end > scanFloor) {
      const start = Math.max(scanFloor, end - TAIL_BYTES);
      const buf = Buffer.alloc(end - start);
      readSync(fd, buf, 0, buf.length, start);
      const lines = buf.toString("utf-8").split("\n");
      if (start > 0) lines.shift(); // possibly cut mid-record; that record is covered by the next window
      const model = newestCodexModel(lines);
      if (model !== null) return model;
      // Overlap one line-length margin is unnecessary: the shifted first line's record straddles the
      // boundary and is re-read whole in the next (earlier) window because windows share the boundary.
      end = start + Math.min(4 * 1024, TAIL_BYTES); // step back with a 4KB overlap for the straddler
      end = start === scanFloor ? scanFloor : end;
    }
    return null;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}
