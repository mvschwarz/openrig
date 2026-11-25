// redaction.ts — the restore packet's redaction, which is the daemon's transcript rule.
//
// Applied to transcript content in transcript-latest.md and transcript.md, and to restore-instructions.md
// body text that quotes transcript material. top_paths / touched-files entries are not redacted (paths are
// not credential material). The validator doesn't scan content for residual credentials; enforcement is
// generator-side at write time (M1 contract § 4, § 8).
//
// The patterns live in one place, `@openrig/daemon/transcript-redaction`, which GET
// /api/transcripts/:session/full uses too: two copies of the list drifted before. They mask explicit
// credential shapes and keep full commits, hashes, paths and ids.
//
// Packets still record `redaction_policy_id: "openrig-v0"`. The id names the policy family the schema
// accepts (`velocity-v1`, `openrig-v0`); nothing reads behaviour from it, and a new id would fail an older
// CLI's validator.

import { TRANSCRIPT_SECRET_PATTERNS, hasTranscriptSecret, redactTranscriptContent } from "@openrig/daemon/transcript-redaction";

/** The shared credential patterns (see `@openrig/daemon/transcript-redaction`). */
export const SECRET_PATTERNS: readonly RegExp[] = TRANSCRIPT_SECRET_PATTERNS;

/** Replace each credential match with `[REDACTED]`, keeping the surrounding text. Pure function. */
export function redact(text: string): string {
  return redactTranscriptContent(text);
}

/** Whether a record's text holds any credential shape; the omitted-records counter uses it for the
 *  `redacted_secrets` class. */
export function hasSecretPattern(text: string): boolean {
  return hasTranscriptSecret(text);
}
