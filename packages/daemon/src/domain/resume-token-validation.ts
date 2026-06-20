// OPR.0.4.0.22 FR-2 — per-runtime resume-token validation.
//
// The floor is FORMAT validation: reject malformed input, never fabricate a
// token, and NEVER quote the raw token in an error message (it is
// credential-class — the redaction contract spans CLI output, route
// responses, route errors, logs, and the audit event). A deep "does it
// actually resume" probe is intentionally out of scope (heavy + must not
// mutate live state); format validation is the safe, side-effect-free floor.

export type ResumeType = "claude_id" | "codex_id";

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

/** Resume-id type for a runtime, or null when the runtime has no resume token
 *  (terminal / unknown). */
export function resumeTypeForRuntime(runtime: string | null): ResumeType | null {
  if (runtime === "claude-code") return "claude_id";
  if (runtime === "codex") return "codex_id";
  return null;
}

export function validateResumeToken(
  runtime: string | null,
  rawToken: unknown,
): ResumeTokenValidationOk | ResumeTokenValidationErr {
  const resumeType = resumeTypeForRuntime(runtime);
  if (!resumeType) {
    return {
      ok: false,
      error: `set-resume-token is not supported for runtime "${runtime ?? "unknown"}" (only claude-code and codex have resume tokens).`,
    };
  }
  if (typeof rawToken !== "string") {
    return { ok: false, error: "Resume token is missing or not a string." };
  }
  const token = rawToken.trim();
  if (token.length === 0) {
    return { ok: false, error: "Resume token is empty." };
  }
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
