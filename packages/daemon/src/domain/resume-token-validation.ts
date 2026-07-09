// OPR.0.4.0.22 FR-2 — per-runtime resume-token validation.
// OPR.0.4.6.PI1 FR-6 — validation is PER-RESUME-TYPE: id-shaped tokens
// (claude/codex) keep the original rules unchanged; pi_session_file is a
// PATH-shaped token (an absolute session-file path) with its own floor.
//
// The floor is FORMAT validation: reject malformed input, never fabricate a
// token, and NEVER quote the raw token in an error message (it is
// credential-class — the redaction contract spans CLI output, route
// responses, route errors, logs, and the audit event). A deep "does it
// actually resume" probe is intentionally out of scope (heavy + must not
// mutate live state); format validation is the safe, side-effect-free floor.

export type ResumeType = "claude_id" | "codex_id" | "pi_session_file";

export interface ResumeTokenValidationOk {
  ok: true;
  resumeType: ResumeType;
  /** The trimmed token to persist. Internal value — never logged/echoed. */
  token: string;
}
export interface ResumeTokenValidationErr {
  ok: false;
  /** Describes the FORMAT problem; NEVER contains the token value. */
  error: string;
}

const SAFE_TOKEN_RE = /^[A-Za-z0-9._-]+$/;
const MAX_TOKEN_LEN = 200;

// pi_session_file floor: absolute path, no ".." segment (checked on the raw
// operand — normalization collapses "..", so a post-normalize check would be
// dead code; same posture as the shipped `rig file` traversal guard), the
// shell-inert path charset, a 1024 cap, and the Pi session-file suffix (one
// constant if Pi ever renames its session format).
//
// "@" is in the set deliberately (a delta from the PRD's literal
// [A-Za-z0-9._/-], caught by the VM hermetic run): the Pi seat state layout
// keys on the CANONICAL session name (pod-member@rig), so every real Pi
// session-file path contains "@". It is shell-inert here — the token is
// always argv/shellQuote-passed, never a remote scp/rsync operand where
// user@host parsing would matter (that ambiguity is why `rig file` excludes
// it; this surface has no such parse).
const PI_SESSION_FILE_CHARSET_RE = /^[A-Za-z0-9._/@-]+$/;
const MAX_PI_SESSION_FILE_LEN = 1024;
const PI_SESSION_FILE_SUFFIX = ".jsonl";

/** Resume-id type for a runtime, or null when the runtime has no resume token
 *  (terminal / unknown). */
export function resumeTypeForRuntime(runtime: string | null): ResumeType | null {
  if (runtime === "claude-code") return "claude_id";
  if (runtime === "codex") return "codex_id";
  if (runtime === "pi") return "pi_session_file";
  return null;
}

function validateIdShapedToken(resumeType: ResumeType, token: string): ResumeTokenValidationOk | ResumeTokenValidationErr {
  if (token.length > MAX_TOKEN_LEN) {
    return { ok: false, error: `Resume token is too long (max ${MAX_TOKEN_LEN} characters).` };
  }
  if (!SAFE_TOKEN_RE.test(token)) {
    return {
      ok: false,
      error: "Resume token contains disallowed characters (allowed: letters, digits, '.', '_', '-').",
    };
  }
  return { ok: true, resumeType, token };
}

function validatePiSessionFileToken(token: string): ResumeTokenValidationOk | ResumeTokenValidationErr {
  if (token.length > MAX_PI_SESSION_FILE_LEN) {
    return { ok: false, error: `Pi session-file token is too long (max ${MAX_PI_SESSION_FILE_LEN} characters).` };
  }
  if (!token.startsWith("/")) {
    return { ok: false, error: "Pi session-file token must be an absolute path (starting with '/')." };
  }
  if (token.split("/").includes("..")) {
    return { ok: false, error: "Pi session-file token must not contain a '..' path segment." };
  }
  if (!PI_SESSION_FILE_CHARSET_RE.test(token)) {
    return {
      ok: false,
      error: "Pi session-file token contains disallowed characters (allowed: letters, digits, '.', '_', '/', '@', '-').",
    };
  }
  if (!token.endsWith(PI_SESSION_FILE_SUFFIX)) {
    return { ok: false, error: `Pi session-file token must end with '${PI_SESSION_FILE_SUFFIX}'.` };
  }
  return { ok: true, resumeType: "pi_session_file", token };
}

export function validateResumeToken(
  runtime: string | null,
  rawToken: unknown,
): ResumeTokenValidationOk | ResumeTokenValidationErr {
  const resumeType = resumeTypeForRuntime(runtime);
  if (!resumeType) {
    return {
      ok: false,
      error: `set-resume-token is not supported for runtime "${runtime ?? "unknown"}" (only claude-code, codex, and pi have resume tokens).`,
    };
  }
  if (typeof rawToken !== "string") {
    return { ok: false, error: "Resume token is missing or not a string." };
  }
  const token = rawToken.trim();
  if (token.length === 0) {
    return { ok: false, error: "Resume token is empty." };
  }
  if (resumeType === "pi_session_file") {
    return validatePiSessionFileToken(token);
  }
  return validateIdShapedToken(resumeType, token);
}
