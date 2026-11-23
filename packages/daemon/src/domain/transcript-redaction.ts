// transcript-redaction.ts — the one credential-redaction rule for transcript text.
//
// GET /api/transcripts/:session/full applies it before serialization, and the CLI's restore packets
// apply it through the `@openrig/daemon/transcript-redaction` surface, so the two can't drift apart.
//
// It masks explicit credential shapes only. Full commits, 64-hex hashes, paths and ids are identifiers
// a restored seat or a reading agent needs, so no pattern here matches a bare run of hex or a path.
// An earlier rule masked any 40-character base64-shaped run, which erased exactly those.

/** Explicit credential shapes, each a known token or key format rather than a length rule. */
export const TRANSCRIPT_SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g, // OpenAI and Anthropic API keys
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, // GitHub fine-grained tokens
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/g, // bearer tokens
  /\bglpat-[A-Za-z0-9_-]{20,}/g, // GitLab personal access tokens
  /\bnpm_[A-Za-z0-9]{36}\b/g, // npm tokens
  /\bxoxe\.xox[bp]-[A-Za-z0-9-]{10,}/g, // Slack rotation tokens
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, // Slack bot, user and refresh tokens
  /\bxapp-[A-Za-z0-9-]{10,}/g, // Slack app-level tokens
  /\bhttps:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/g, // Slack incoming webhook URLs
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, // AWS access key ids
  /(?<=\baws_secret_access_key["']?\s*[=:]\s*["']?)[A-Za-z0-9/+=]{40}/gi, // AWS secret keys, where named
  /\bAIza[0-9A-Za-z_-]{35}/g, // Google API keys
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JSON Web Tokens
  // Private keys: the whole block, or everything after a BEGIN line whose END was cut off.
  /-----BEGIN [A-Z ]*PRIVATE KEY-----(?:[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----|[A-Za-z0-9+/=\s]*)/g,
  /(?<=\bhttps?:\/\/)[^\s/@:]+:[^\s/@]+(?=@)/g, // a user and password in a URL
];

/**
 * Replace each credential match with the literal `[REDACTED]`, keeping everything around it.
 * Pure function; no side effects.
 */
export function redactTranscriptContent(text: string): string {
  let out = text;
  for (const pattern of TRANSCRIPT_SECRET_PATTERNS) {
    out = out.replace(pattern, "[REDACTED]");
  }
  return out;
}

/** Whether any credential shape occurs in the text. Builds fresh non-global probes, since the global patterns
 *  carry `lastIndex` between calls. */
export function hasTranscriptSecret(text: string): boolean {
  return TRANSCRIPT_SECRET_PATTERNS.some((pattern) => new RegExp(pattern.source, pattern.flags.replace("g", "")).test(text));
}
