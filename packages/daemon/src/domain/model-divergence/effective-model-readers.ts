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
// B12 lesson). Each reader inspects at most the newest TAIL_BYTES of the file. A signal older than
// the tail window reads as null (honest UNKNOWN — the detector stays pending), never a guess.

import { openSync, readSync, closeSync, fstatSync } from "node:fs";

const TAIL_BYTES = 512 * 1024;

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

/** The codex runtime's own current model per its newest world_state record, or null. */
export function readCodexEffectiveModel(rolloutPath: string): string | null {
  const lines = readTailLines(rolloutPath);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line.includes('"world_state"')) continue;
    try {
      const obj = JSON.parse(line) as {
        type?: unknown;
        payload?: { state?: { collaboration_mode?: { model?: unknown } } };
      };
      if (obj.type !== "world_state") continue;
      const model = obj.payload?.state?.collaboration_mode?.model;
      if (typeof model === "string" && model.length > 0) return model;
    } catch {
      /* corrupt line — keep scanning */
    }
  }
  return null;
}
