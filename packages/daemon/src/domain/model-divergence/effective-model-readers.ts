// B8 / slice-07 A3 — per-runtime EFFECTIVE-model reads (the load-bearing signal).
//
// The detector compares effective vs pinned; these readers own "effective". Both specimens proved
// the REQUESTED echo lies (the codex banner kept naming the pinned model while the footer ran a
// fallback), so each read comes from the runtime's own record of what is actually answering:
//   - claude-code: the newest determinate, non-synthetic model-bearing assistant record in the
//     provider transcript — the API response names the model that produced it. Absent until the
//     seat's first such record.
//   - codex: the latest `world_state` event's `collaboration_mode.model` in the rollout.
//   - pi: the newest determinate assistant record's `provider/model` in the session file, when that
//     record is the current occupant's own (not inherited from a fork parent, not a prior runner's).
//
// BOUNDED READS by contract: provider records on live seats reach hundreds of MB (a whole-file
// readFileSync throws ERR_STRING_TOO_LONG past ~0.5GB and stalls the loop long before that — the
// B12 lesson). The claude signal recurs every assistant turn, so a single 512KB tail always holds
// it on a live seat. The codex world_state is SPARSE (r1 measured a 65.9MB rollout whose newest
// record sat 0.80MB from EOF — outside one tail window), so the codex reader scans BACKWARD in
// tail-sized chunks up to MAX_SCAN_BYTES. A signal older than the scan cap reads as null (honest
// UNKNOWN — the detector reports it as observable pending), never a guess.

import { openSync, readSync, closeSync, fstatSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parsePiModelsJson } from "../../adapters/pi-readiness.js";
import { parsePiSessionHeader, piAssistantFields, piEntryOrigin, type PiSessionBoundary } from "../pi-usage-facts.js";

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
export interface NativeModelObservation {
  model: string;
  source: "claude-assistant-response" | "codex-turn-context" | "codex-world-state" | "pi-assistant-response";
  /** Native record time, not file mtime or the time this reader ran. */
  observedAt: string | null;
}

function recordTime(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
}

export function readClaudeEffectiveModel(transcriptPath: string): string | null {
  return readClaudeModelObservation(transcriptPath)?.model ?? null;
}

export function readClaudeModelObservation(transcriptPath: string): NativeModelObservation | null {
  const lines = readTailLines(transcriptPath);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line.includes('"assistant"') || !line.includes('"model"')) continue;
    try {
      const obj = JSON.parse(line) as { type?: unknown; timestamp?: unknown; message?: { role?: unknown; model?: unknown } };
      if (obj.message?.role === "assistant" && typeof obj.message.model === "string" && obj.message.model.length > 0 && obj.message.model !== "<synthetic>") {
        return { model: obj.message.model, source: "claude-assistant-response", observedAt: recordTime(obj.timestamp) };
      }
    } catch {
      /* corrupt line — keep scanning */
    }
  }
  return null;
}

function newestCodexModel(lines: string[]): NativeModelObservation | null {
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
        const obj = JSON.parse(line) as { type?: unknown; timestamp?: unknown; payload?: { model?: unknown } };
        if (obj.type === "turn_context") {
          const model = obj.payload?.model;
          if (typeof model === "string" && model.length > 0) return { model, source: "codex-turn-context", observedAt: recordTime(obj.timestamp) };
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
          timestamp?: unknown;
          payload?: { state?: { collaboration_mode?: { model?: unknown } } };
        };
        if (obj.type === "world_state") {
          const model = obj.payload?.state?.collaboration_mode?.model;
          if (typeof model === "string" && model.length > 0) return { model, source: "codex-world-state", observedAt: recordTime(obj.timestamp) };
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
  return readCodexModelObservation(rolloutPath, maxScanBytes)?.model ?? null;
}

export function readCodexModelObservation(rolloutPath: string, maxScanBytes = MAX_SCAN_BYTES): NativeModelObservation | null {
  return scanBackward(rolloutPath, newestCodexModel, maxScanBytes);
}

/** The ONE bounded backward scan: tail-sized windows from EOF down to `maxScanBytes`, each handed
 *  to `pick` as whole lines (oldest first). The first non-null pick ends the scan; null = keep
 *  scanning older windows. Missing/unreadable file, or nothing picked within the cap → null. */
function scanBackward<T>(path: string, pick: (lines: string[]) => T | null, maxScanBytes: number): T | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
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
      const picked = pick(lines);
      if (picked !== null) return picked;
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

/** The occupant whose Pi session-file records may answer: records stamped at or before
 *  `notBeforeMs` belong to an earlier runner or occupant of the same file (a resume keeps it). */
export interface PiOccupantScope {
  notBeforeMs: number;
}

/** Pi's thinking levels for `--thinking` and the `--model` suffix (`pi --help`; the same at the
 *  tested 0.87.1 baseline and 1.3.0). */
const PI_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/** The model ids a Pi pin can resolve to, in Pi's own order (`parseModelPattern`): the whole pin
 *  first, then with each trailing `:<thinking level>` removed in turn. Pi records the model without
 *  the level, so `openrouter/x-ai/grok-4:high` matches a `grok-4` record, and a model id that
 *  really ends in `:high` still matches as itself. Any other `:` suffix, such as OpenRouter's
 *  `:free`, stays part of the id, and the provider is never touched. */
export function piPinReadings(pinned: string): string[] {
  const readings = [pinned.trim()];
  for (;;) {
    const last = readings[readings.length - 1]!;
    const colon = last.lastIndexOf(":");
    if (colon === -1 || !PI_THINKING_LEVELS.has(last.slice(colon + 1))) return readings;
    readings.push(last.slice(0, colon));
  }
}

/** The readings a Pi seat's record may match. Pi tries the exact pin first and stops there, so
 *  when the seat's own `models.json` defines a model whose `provider/id` is the pin, or the pin
 *  with only some levels removed, that reading is the only one: `lab/y:high` stays `lab/y:high`
 *  when `lab` defines `y:high`. Otherwise every reading, since Pi's built-in models and extension
 *  models are not read here. Only a pin with a level suffix reads the file. A missing file defines
 *  no model; one that can't be read or doesn't have Pi's shape is unknown (the seat stays pending).
 *  Ids compare case-insensitively, as in Pi's exact match. */
export function piSeatPinReadings(pinned: string, agentDir: string): { ok: true; readings: string[] } | { ok: false; reason: string } {
  const readings = piPinReadings(pinned);
  if (readings.length === 1) return { ok: true, readings };
  const file = join(agentDir, "models.json");
  const unknown = { ok: false as const, reason: `the seat's models.json (${file}) could not be read as Pi's model config` };
  let config: unknown;
  try {
    if (statSync(file).size > 1024 * 1024) return unknown;
    config = parsePiModelsJson(readFileSync(file, "utf8"));
  } catch (error) {
    // Never report the error itself: models.json can hold keys.
    return (error as NodeJS.ErrnoException)?.code === "ENOENT" ? { ok: true, readings } : unknown;
  }
  const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
  if (!object(config)) return unknown;
  if (config.providers === undefined) return { ok: true, readings };
  if (!object(config.providers)) return unknown;
  const defined = new Set<string>();
  for (const [provider, entry] of Object.entries(config.providers)) {
    if (!object(entry)) return unknown;
    if (entry.models === undefined) continue;
    if (!Array.isArray(entry.models)) return unknown;
    for (const model of entry.models) {
      if (!object(model) || typeof model.id !== "string") return unknown;
      defined.add(`${provider}/${model.id}`.toLowerCase());
    }
  }
  const literal = readings.slice(0, -1).find((reading) => defined.has(reading.toLowerCase()));
  return { ok: true, readings: literal ? [literal] : readings };
}

/** The Pi runtime's effective model, `provider/model`, from the NEWEST determinate assistant
 *  record in the session file — provided that record is this occupant's own. Pi's `model` is the
 *  runtime's own record of what answered; `responseModel` (a routed/dated API variant) is not
 *  compared, since modelsMatch canonicalizes only the pin.
 *
 *  The newest determinate record DECIDES: when it is inherited from a fork parent, of unknown
 *  origin, stamped no later than `scope.notBeforeMs`, or carries no provider, the answer is a
 *  named no-answer (pending) and the scan does NOT reach for an older record — an older one is
 *  at least as stale. Error and aborted turns are skipped (they name the requested model, not one
 *  that answered). The session header decides origin; an unreadable header is a no-answer. */
export function readPiEffectiveModel(
  sessionFile: string,
  scope: PiOccupantScope,
  maxScanBytes = MAX_SCAN_BYTES,
): { ok: true; model: string } | { ok: false; reason: string } {
  const result = readPiModelObservation(sessionFile, scope, maxScanBytes);
  return result.ok ? { ok: true, model: result.model } : result;
}

export function readPiModelObservation(
  sessionFile: string,
  scope: PiOccupantScope,
  maxScanBytes = MAX_SCAN_BYTES,
): ({ ok: true } & NativeModelObservation) | { ok: false; reason: string } {
  const header = readFirstLine(sessionFile);
  if (header === null) return { ok: false, reason: `Pi session file ${sessionFile} is unreadable` };
  const boundary = parsePiSessionHeader(header);
  if (!boundary) return { ok: false, reason: `Pi session file ${sessionFile} has no readable session header` };
  const picked = scanBackward(sessionFile, (lines) => newestPiModel(lines, boundary, scope), maxScanBytes);
  return picked ?? { ok: false, reason: `no determinate assistant record from the current occupant in the bounded read of ${sessionFile}` };
}

function newestPiModel(
  lines: string[],
  boundary: PiSessionBoundary,
  scope: PiOccupantScope,
): ({ ok: true } & NativeModelObservation) | { ok: false; reason: string } | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line.includes('"assistant"')) continue;
    let entry: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      entry = parsed as Record<string, unknown>;
    } catch {
      continue; // corrupt line — keep scanning
    }
    const fields = piAssistantFields(entry);
    if (!fields) continue;
    if (fields.stopReason === "error" || fields.stopReason === "aborted") continue;
    const id = typeof entry["id"] === "string" ? entry["id"] : "";
    const timestamp = typeof entry["timestamp"] === "string" ? entry["timestamp"] : "";
    const at = Date.parse(timestamp);
    if (!id || !Number.isFinite(at)) return { ok: false, reason: `newest Pi assistant record carries no entry id or timestamp` };
    const origin = piEntryOrigin(id, timestamp, boundary);
    if (origin !== "own") return { ok: false, reason: `newest Pi assistant record ${id} is ${origin === "inherited" ? "inherited from the fork parent" : "of undecidable fork origin"}` };
    if (at <= scope.notBeforeMs) return { ok: false, reason: `newest Pi assistant record ${id} predates the current runner` };
    if (!fields.provider || !fields.model) return { ok: false, reason: `newest Pi assistant record ${id} names no provider and model` };
    return { ok: true, model: `${fields.provider}/${fields.model}`, source: "pi-assistant-response", observedAt: recordTime(timestamp) };
  }
  return null;
}

/** The first line of a file, read bounded (a Pi session header is small). null when unreadable. */
function readFirstLine(path: string, maxBytes = 64 * 1024): string | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(maxBytes);
    const read = readSync(fd, buf, 0, maxBytes, 0);
    const text = buf.subarray(0, read).toString("utf-8");
    const newline = text.indexOf("\n");
    return newline >= 0 ? text.slice(0, newline) : text;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}
