import { createHash } from "node:crypto";

const normalize = (text: string): string => text.replace(/\s+/g, "");
// Claude 2.1.289 briefly replaces its mode bar after a bracketed paste.
// Only the bare hint and medium-effort suffix are established by retained captures.
const isComposerFooter = (line: string): boolean => /(?:shift\+tab to cycle|\? for shortcuts)/i.test(line)
  || /^paste again to expand(?:\s{2,}◐ medium · \/effort)?$/.test(line);
// This placeholder occupies an empty composer while submitted text is queued.
const QUEUED_PLACEHOLDER = normalize("Press up to edit queued messages");

/** The same composer region used by the startup Enter guard. No transcript fallback. */
function composerRegion(pane: string | null) {
  const lines = (pane ?? "").split("\n");
  let inputAt = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.trimStart().startsWith("❯")) { inputAt = i; break; }
  }
  let end = -1;
  if (inputAt >= 0) {
    // Prompt text can itself contain rules (the startup challenge does).
    for (let i = lines.length - 1; i > inputAt; i--) {
      if (/^[─═-]{10,}$/.test(lines[i]!.trim())
        && isComposerFooter((lines.slice(i + 1).find((next) => next.trim()) ?? "").trim())) {
        end = i;
        break;
      }
    }
  }
  const body = inputAt < 0 || end < 0 || /^❯\s*\d+\./.test(lines[inputAt]!.trimStart())
    ? null : normalize(lines.slice(inputAt, end).join("\n").trimStart().slice(1));
  return { body, markerLine: inputAt < 0 ? null : inputAt + 1,
    closingRuleLine: end < 0 ? null : end + 1, capturedLines: pane === null ? 0 : lines.length };
}

/** An echoed turn or a partial/opaque composer stays unverified. */
export function inspectStartupStagedText(pane: string | null, expected: string): "staged" | "clear" | "unverified" {
  const { body } = composerRegion(pane);
  if (body === null) return "unverified";
  if (!body) return "clear";
  if (body === normalize(expected)) return "staged";
  return body === QUEUED_PLACEHOLDER ? "clear" : "unverified";
}

/** Whether the current composer region is recognized at all, whatever it holds. */
export function startupComposerRecognized(pane: string | null): boolean {
  return composerRegion(pane).body !== null;
}

export interface StartupSubmissionEvidence {
  normalization: "whitespace-stripped-utf8";
  expected: { bytes: number; sha256: string };
  observed: { bytes: number; sha256: string } | null;
  /** One-based positions in this capture, not absolute terminal rows. */
  markerLine: number | null;
  closingRuleLine: number | null;
  capturedLines: number;
  captureScrollbackLines: number;
  /** Zero-based UTF-8 byte offset; null when equal or no valid region exists. */
  firstDifferenceByte: number | null;
  /** Diagnostic only; absent for unavailable captures or an excluded selector. */
  reason?: "unrecognized_composer_boundary" | "extracted_text_mismatch";
  windowsOmitted: "unclassified-startup-text";
}

export interface StartupSubmissionDiagnostic {
  startupAttemptId: string;
  /** One-based order among this orchestrator's interactive sends. */
  sendOrder: number;
  source: "initial_identity" | "restore_preload" | "post_launch_file" | "challenge" | "startup_proof_instruction" | "after_files" | "after_ready";
  /** Zero-based index in the authored action list, when applicable. */
  actionIndex?: number;
  observations: Array<StartupSubmissionEvidence & { phase: "initial" | "guarded_retry" | "after_retry" }>;
  /** Transport result only; ok does not assert model consumption. */
  retry: "not_run" | "ok" | "refused_or_failed" | "threw";
}

/** No excerpts: every startup source accepts arbitrary, potentially credential-bearing text.
 * Fixed-size metadata per capture (at most three per send), never a pane/prompt dump.
 * Diagnostics must not turn a delivery decision into a failure. */
export function startupSubmissionEvidence(pane: string | null, expected: string, captureScrollbackLines: number): StartupSubmissionEvidence | undefined {
  try {
    const { body, ...positions } = composerRegion(pane);
    const expectedBytes = Buffer.from(normalize(expected));
    const observedBytes = body === null ? null : Buffer.from(body);
    const digest = (bytes: Buffer) => ({ bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
    let firstDifferenceByte: number | null = null;
    if (observedBytes !== null) {
      let i = 0;
      while (i < expectedBytes.length && i < observedBytes.length && expectedBytes[i] === observedBytes[i]) i++;
      if (i !== expectedBytes.length || i !== observedBytes.length) firstDifferenceByte = i;
    }
    const reason = !pane?.trim() ? undefined
      : positions.markerLine === null || positions.closingRuleLine === null ? "unrecognized_composer_boundary"
      : observedBytes !== null && firstDifferenceByte !== null ? "extracted_text_mismatch" : undefined;
    return { normalization: "whitespace-stripped-utf8", expected: digest(expectedBytes),
      observed: observedBytes === null ? null : digest(observedBytes), ...positions,
      ...(reason ? { reason } : {}),
      captureScrollbackLines, firstDifferenceByte, windowsOmitted: "unclassified-startup-text" };
  } catch {
    return undefined;
  }
}
