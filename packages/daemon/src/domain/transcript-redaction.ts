// transcript-redaction.ts — daemon-side mirror of the v0 redaction policy.
//
// Mirrors packages/cli/src/restore-packet/redaction.ts SECRET_PATTERNS
// (M1 contract § 4 / openrig-v0 policy). Patterns duplicated rather than
// imported because @openrig/cli is not a daemon dependency (and adding
// it would invert the package graph). For M2c-Daemon scope: keep this
// list byte-equivalent to the CLI list. A future slice may factor a
// shared @openrig/redaction package; until then, drift between these
// two arrays is a defect — reviewers should diff them on any change.

/** v0 secret-pattern list. Mirrors packages/cli/src/restore-packet/redaction.ts:31-37. */
export const TRANSCRIPT_SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/g,
  /\b[A-Za-z0-9+/]{40,}={0,2}\b/g,
];

/**
 * Apply the openrig-v0 redaction policy to transcript content. Returns
 * the input with each match of the secret patterns replaced by the
 * literal string `[REDACTED]`. Pure function; no side effects.
 *
 * Used by GET /api/transcripts/:session/full to redact the wire payload
 * BEFORE serialization, so credential patterns never reach the response
 * body even when a transcript file contains them.
 */
export function redactTranscriptContent(text: string): string {
  let out = text;
  for (const pattern of TRANSCRIPT_SECRET_PATTERNS) {
    out = out.replace(pattern, "[REDACTED]");
  }
  return out;
}
