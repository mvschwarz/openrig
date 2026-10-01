// OPR.0.4.0.22 FR-2 — per-runtime resume-token validation.
// File-shaped Pi and OMP tokens share the same format floor; id-shaped
// Claude/Codex tokens retain their original rules unchanged.
//
// The floor is FORMAT validation: reject malformed input, never fabricate a
// token, and NEVER quote the raw token in an error message (it is
// credential-class — the redaction contract spans CLI output, route
// responses, route errors, logs, and the audit event). A deep "does it
// actually resume" probe is intentionally out of scope (heavy + must not
// mutate live state); format validation is the safe, side-effect-free floor.

export type ResumeType = "claude_id" | "codex_id" | "pi_session_file" | "omp_session_file";

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

// Pi/OMP session files: absolute path, no ".." segment (checked on the raw
// operand before normalization), shell-inert charset, 1024-char cap, and
// a .jsonl suffix. This validates format, never file existence.
//
// "@" is in the set deliberately (a delta from the PRD's literal
// [A-Za-z0-9._/-], caught by the VM hermetic run): the Pi seat state layout
// keys on the CANONICAL session name (pod-member@rig), so every real Pi
// session-file path contains "@". It is shell-inert here — the token is
// always argv/shellQuote-passed, never a remote scp/rsync operand where
// user@host parsing would matter (that ambiguity is why `rig file` excludes
// it; this surface has no such parse).
const SESSION_FILE_CHARSET_RE = /^[A-Za-z0-9._/@-]+$/;
const MAX_SESSION_FILE_LEN = 1024;
const SESSION_FILE_SUFFIX = ".jsonl";

/** Resume-id type for a runtime, or null when the runtime has no resume token
 *  (terminal / unknown). */
export function resumeTypeForRuntime(runtime: string | null): ResumeType | null {
  if (runtime === "claude-code") return "claude_id";
  if (runtime === "codex") return "codex_id";
  if (runtime === "pi") return "pi_session_file";
  if (runtime === "omp") return "omp_session_file";
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

function validateSessionFileToken(resumeType: "pi_session_file" | "omp_session_file", token: string): ResumeTokenValidationOk | ResumeTokenValidationErr {
  const label = resumeType === "pi_session_file" ? "Pi" : "OMP";
  if (token.length > MAX_SESSION_FILE_LEN) {
    return { ok: false, error: `${label} session-file token is too long (max ${MAX_SESSION_FILE_LEN} characters).` };
  }
  if (!token.startsWith("/")) {
    return { ok: false, error: `${label} session-file token must be an absolute path (starting with '/').` };
  }
  if (token.split("/").includes("..")) {
    return { ok: false, error: `${label} session-file token must not contain a '..' path segment.` };
  }
  if (!SESSION_FILE_CHARSET_RE.test(token)) {
    return {
      ok: false,
      error: `${label} session-file token contains disallowed characters (allowed: letters, digits, '.', '_', '/', '@', '-').`,
    };
  }
  if (!token.endsWith(SESSION_FILE_SUFFIX)) {
    return { ok: false, error: `${label} session-file token must end with '${SESSION_FILE_SUFFIX}'.` };
  }
  return { ok: true, resumeType, token };
}

export function validateResumeToken(
  runtime: string | null,
  rawToken: unknown,
): ResumeTokenValidationOk | ResumeTokenValidationErr {
  const resumeType = resumeTypeForRuntime(runtime);
  if (!resumeType) {
    return {
      ok: false,
      error: `set-resume-token is not supported for runtime "${runtime ?? "unknown"}" (only claude-code, codex, pi, and omp have resume tokens).`,
    };
  }
  if (typeof rawToken !== "string") {
    return { ok: false, error: "Resume token is missing or not a string." };
  }
  const token = rawToken.trim();
  if (token.length === 0) {
    return { ok: false, error: "Resume token is empty." };
  }
  if (resumeType === "pi_session_file" || resumeType === "omp_session_file") {
    return validateSessionFileToken(resumeType, token);
  }
  return validateIdShapedToken(resumeType, token);
}
