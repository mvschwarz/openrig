// B8 / slice-07 A3 — per-runtime EFFECTIVE-model reads (the load-bearing signal).
//
// The detector compares effective vs pinned; these readers own "effective". Both specimens proved
// the REQUESTED echo lies (the codex banner kept naming the pinned model while the footer ran a
// fallback), so each read comes from the runtime's own record of what is actually answering:
//   - claude-code: the newest determinate, non-synthetic model-bearing assistant record in the
//     provider transcript — the API response names the model that produced it. Absent until the
//     seat's first such record.
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

/** The model from the seat's newest determinate, non-synthetic model-bearing assistant record, or
 *  null when no such record is in the tail window (a just-launched or synthetic-only seat has none
 *  — the detector treats null as PENDING, not as a match). */
export function readClaudeEffectiveModel(transcriptPath: string): string | null {
  const lines = readTailLines(transcriptPath);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line.includes('"assistant"') || !line.includes('"model"')) continue;
    try {
      const obj = JSON.parse(line) as { type?: unknown; message?: { role?: unknown; model?: unknown } };
      if (obj.message?.role === "assistant" && typeof obj.message.model === "string" && obj.message.model.length > 0 && obj.message.model !== "<synthetic>") {
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
    // PRIMARY: turn_context.payload.model — preferred for DENSITY, not existence. (~~"old July-era
    // records carry NO collaboration_mode"~~ — WRONG, r1 measured 14/72 world_states carrying it in
    // the same July file; the truth is collaboration_mode is SPARSE WITHIN world_state, while
    // turn_context.model recurs every turn — 232 occurrences in that file — so it sits near EOF on
    // any live seat. A reader deciding whether the world_state belt can be dropped: it cannot; both
    // signals are real, turn_context is just denser.)
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
      // The first line may be a record's TAIL cut at the window boundary. Drop it here — and size
      // the next window to END just past that fragment, so the straddling record is re-read WHOLE
      // from its own line start. A fixed small overlap loses any straddler longer than it (r1
      // proved a 20KB record vanishing over a 4KB overlap — and a lost straddler usually means a
      // STALE model read, the exact silence this detector exists to end; real world_state records
      // reach ~22KB). Sizing from the dropped fragment makes the overlap exact by construction.
      let droppedBytes = 0;
      if (start > 0 && lines.length > 0) {
        droppedBytes = Buffer.byteLength(lines[0]!, "utf-8");
        lines.shift();
      }
      const model = newestCodexModel(lines);
      if (model !== null) return model;
      if (start === scanFloor) break;
      // Fragment-sized step-back — UNLESS the fragment fills the whole window (a single line wider
      // than 512KB: real, r1 measured 44 such lines on this box, longest 8.2MB). In that case
      // `start + droppedBytes + 1` would be ≥ end and the old `min(end - 1, …)` guard degraded to
      // ONE-BYTE steps re-reading 512KB each — r1 measured a 6MB file grinding past 30s
      // (extrapolated ~1.4TB of reads) on the exact deep-scan file the cap exists to serve. When
      // fragment sizing yields no progress, step a FULL window instead: the giant line cannot be
      // recovered whole either way (the accepted tradeoff), but the scan terminates.
      const next = start + droppedBytes + 1;
      end = next < end ? next : start;
    }
    return null;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}
