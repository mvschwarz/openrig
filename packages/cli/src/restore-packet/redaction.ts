// redaction.ts — applies the v0 redaction policy.
//
// Per M1 contract § 4: v0 defines two named policies:
// - `velocity-v1`: mirrors the Velocity generator's token patterns at
//   field-notes/2026-04-27-velocity-claude-from-codex-restore/tools/
//   codex-jsonl-to-restore-packet.mjs:34-48 (sk-*, gh[pousr]_*,
//   github_pat_*, Bearer *, base64 ≥40 chars).
// - `openrig-v0`: the productized v0 policy, identical patterns to
//   `velocity-v1` but with the canonical name. v0 generator emits
//   `redaction_policy_id: "openrig-v0"`.
//
// Redaction is applied to:
// - transcript content in transcript-latest.md and transcript.md.
// - body content in restore-instructions.md if it quotes transcript
//   material.
// - top_paths / touched-files entries are NOT redacted (paths are not
//   credential material).
//
// The validator does NOT scan content for residual credential patterns
// (per § 4 + § 8: enforcement is generator-side at write time).

/**
 * v0 secret-pattern list. Mirrors Velocity prior art `:34-48` exactly:
 *
 * 1. /\bsk-[A-Za-z0-9_-]{16,}\b/g — OpenAI-style secret tokens.
 * 2. /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g — GitHub personal/OAuth tokens.
 * 3. /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g — GitHub fine-grained PATs.
 * 4. /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/g — generic Bearer tokens.
 * 5. /\b[A-Za-z0-9+/]{40,}={0,2}\b/g — base64-shaped strings ≥40 chars.
 */
export const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/g,
  /\b[A-Za-z0-9+/]{40,}={0,2}\b/g,
];

/**
 * Apply the openrig-v0 redaction policy to a string. Returns the input
 * with each match of the secret patterns replaced by the literal
 * string `[REDACTED]`. Pure function; no side effects.
 *
 * The redaction is non-destructive at the structural level — only the
 * matched substrings are replaced. Surrounding characters are kept.
 */
export function redact(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, "[REDACTED]");
  }
  return out;
}

/**
 * Returns true if at least one secret pattern matches the input.
 * Used by the omitted-records counter to track how many records had
 * their content redacted (for the `redacted_secrets` omitted-class
 * count in summary).
 *
 * Note: a SINGLE record may match multiple patterns; this returns true
 * after the first match for efficiency.
 */
export function hasSecretPattern(text: string): boolean {
  for (const pattern of SECRET_PATTERNS) {
    // Non-global test: cannot reuse the global `g` regex without resetting
    // lastIndex, so build a fresh non-global RegExp from source.
    const probe = new RegExp(pattern.source);
    if (probe.test(text)) return true;
  }
  return false;
}
