/** Reporting only: never retain composer text, suggestions, frames, hints or exception messages. */
export interface InputReadDiagnostic {
  check: "composer" | "draft-aware";
  status: "empty" | "text" | "typed" | "likely-suggestion" | "typed-with-suggestion" | "unknown" | "no-input-box";
  confidence: "high" | "medium" | "low" | "unknown" | null;
  reason: string;
  cursor: { present: boolean; valid: boolean | null; atEnd: boolean | null };
  /** null means this reader does not report whether a timeout occurred. */
  timedOut: boolean | null;
}

const reasons = new Set(["capture_unavailable", "pane_in_mode", "invalid_cursor", "incomplete_frame",
  "ambiguous_composer", "unrecognized_composer", "read_timeout", "read_budget_spent", "cursor_moved",
  "cursor_unavailable", "cursor_outside", "unrecognized_input_box", "input_not_clear",
  "paste_controls", "paste_long", "paste_viewport"]);

/** Copy only fixed vocabulary and cursor flags. Unknown reader reasons remain content-free. */
export function inputReadDiagnostic(check: InputReadDiagnostic["check"], reading: {
  state?: string; status?: string; confidence?: string; unknownReason?: string;
  cursor?: { x: number; y: number; width: number; height: number } | null;
  cursorAtEnd?: boolean; evidence?: string[];
} | null, reason?: string): InputReadDiagnostic {
  const evidence = reading?.evidence ?? [];
  const timeout = evidence.includes("input box reads timed out");
  const derived = reason ?? reading?.unknownReason ?? (timeout ? "read_timeout"
    : evidence.includes("input box budget spent") ? "read_budget_spent"
    : evidence.includes("cursor moved during the capture") ? "cursor_moved"
    : evidence.includes("cursor unavailable") ? "cursor_unavailable"
    : evidence.some(e => e === "cursor outside the input box" || e === "cursor seen once outside the input box") ? "cursor_outside"
    : reading?.status === "no-input-box" ? "unrecognized_input_box"
    : reading?.status === "unknown" || !reading ? "capture_unavailable" : "input_not_clear");
  const status = reading?.status ?? reading?.state;
  const confidence = reading?.confidence;
  const cursor = reading?.cursor;
  return {
    check,
    status: ["empty", "text", "typed", "likely-suggestion", "typed-with-suggestion", "unknown", "no-input-box"].includes(status ?? "")
      ? status as InputReadDiagnostic["status"] : "unknown",
    confidence: ["high", "medium", "low", "unknown"].includes(confidence ?? "")
      ? confidence as InputReadDiagnostic["confidence"] : null,
    reason: reasons.has(derived) ? derived : "capture_unavailable",
    cursor: { present: !!cursor, valid: cursor ? [cursor.x, cursor.y, cursor.width, cursor.height].every(Number.isInteger)
      && cursor.x >= 0 && cursor.y >= 0 && cursor.width > cursor.x && cursor.height > cursor.y : null,
      atEnd: typeof reading?.cursorAtEnd === "boolean" ? reading.cursorAtEnd : null },
    timedOut: timeout ? true : null,
  };
}
