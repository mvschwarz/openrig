// transcript-redaction.ts — the one credential-redaction rule for transcript text.
//
// GET /api/transcripts/:session/full applies it before serialization, and the CLI's restore packets
// apply it through the `@openrig/daemon/transcript-redaction` surface, so the two can't drift apart.
//
// It masks explicit credential shapes only. Full commits, 64-hex hashes, paths and ids are identifiers
// a restored seat or a reading agent needs, so no pattern here matches a bare run of hex or a path.
// An earlier rule masked any 40-character base64-shaped run, which erased exactly those.

/** Explicit credential shapes, each a known token or key format rather than a length rule. A pattern's first
 *  capture group, when it has one, is the visible context kept in front of `[REDACTED]`. Every pattern runs in
 *  linear time on transcript-sized text: classes that meet at a repeat don't overlap, the one lazy repeat (a JWT's
 *  label) is tried once per run of token characters, a JWT's run-start lookbehind checks a single character, its
 *  joined-header lookbehinds read back over one run, and its check past a joined signature reads at most three fields. */
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
  /(\b(?:aws_secret_access_key|SecretAccessKey)["']?\s*[=:]\s*["']?)[A-Za-z0-9/+=]{40}/gi, // AWS secret keys, where named (config, env, CLI JSON)
  /(\b(?:aws_session_token|SessionToken)["']?\s*[=:]\s*["']?)[A-Za-z0-9/+=]{16,}/gi, // AWS session tokens, where named
  /(\b(?:AccountKey|SharedAccessKey)\s*=\s*)[A-Za-z0-9+/=]{20,}/gi, // Azure connection-string keys
  /(\bAuthorization["']?\s*[=:]\s*["']?Basic\s+)[A-Za-z0-9+/=]{8,}/gi, // HTTP Basic credentials
  /\bAIza[0-9A-Za-z_-]{35}/g, // Google API keys
  // JSON Web Tokens, also right after a "-" or "_" (a label or a leading minus), which stays in front of `[REDACTED]`.
  // A header ends where its run of token characters ends, so every start inside one run has the same end. The match
  // starts only at a run's start and checks that end once; starting after each "-" would rescan the run from each one,
  // which is quadratic on a long run with no dot. JWTs joined by "-" or "_" go as one: a signature runs to its run's
  // end, taking the next header with it, and when that run ends in a joined header its payload and signature follow.
  // Unless the next three fields are a whole JWT of their own, whose second field joins nothing further: then this
  // signature only ends like a header, and the match stops so that JWT is matched next, signature and all.
  /(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})((?:[A-Za-z0-9]*[-_])*?)eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:(?<=[-_]eyJ[A-Za-z0-9_-]{8,})(?!\.eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}(?<![-_]eyJ[A-Za-z0-9_-]{8,})\.[A-Za-z0-9_-]{8,})\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})*/g,
  // Private keys: the BEGIN line, the body and the END line when it's there (a body cut off before its END line still
  // goes). The body is runs of base64, or an encrypted key's Proc-Type and DEK-Info lines, each after whitespace or an
  // escaped line break, so a key inside a JSON string goes too. No run can match the characters that end it, which
  // keeps the scan linear, and a base64 run can't match "-", so a match stops at the END line or another key.
  // A compact traditional key keeps its two named encryption headers; its IV scan is bounded.
  /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----(?:Proc-Type:[ \t]*4,ENCRYPTED|DEK-Info:[ \t]*[A-Za-z0-9-]+,[A-Fa-f0-9]{1,32}|[A-Za-z0-9+/=]|\\\/)*(?:(?:\s|\\[rn])+(?:(?:Proc-Type|DEK-Info):[ \t]*[^\s\\]+|(?:[A-Za-z0-9+/=]|\\\/)+))*(?:(?:\s|\\[rn])*-----END [A-Z ]{0,40}PRIVATE KEY-----)?/g,
  /(\bhttps?:\/\/)[^\s/?#@:]*:[^\s/?#@]+(?=@)/g, // a password in a URL, with or without a user
];

/**
 * Replace each credential match with the literal `[REDACTED]`, keeping everything around it, and the pattern's
 * first capture group when it has one. Pure function; no side effects.
 */
export function redactTranscriptContent(text: string): string {
  let out = text;
  for (const pattern of TRANSCRIPT_SECRET_PATTERNS) {
    out = out.replace(pattern, (_match, kept: unknown) => `${typeof kept === "string" ? kept : ""}[REDACTED]`);
  }
  return out;
}

/** Whether any credential shape occurs in the text. Builds fresh non-global probes, since the global patterns
 *  carry `lastIndex` between calls. */
export function hasTranscriptSecret(text: string): boolean {
  return TRANSCRIPT_SECRET_PATTERNS.some((pattern) => new RegExp(pattern.source, pattern.flags.replace("g", "")).test(text));
}
