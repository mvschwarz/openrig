// OPR.0.4.3.04 B2 — the PURE, reusable resume-token DERIVE helper.
//
// This is the shared derivation core behind FR-3's adoption-boundary capture
// (ClaimService.captureResumeTokenOnAdoption) AND the seat-handover discovered-
// mode capture. It performs REUSE-ONLY, PURE READ derivation — no pane writes,
// no launch, no persistence, no event emission. The CALLER owns persistence
// (updateResumeToken) and event emission (captured / preserved / skipped), so
// each caller keeps its own provenance + audit semantics.
//
// The derived token is credential-class: it is NEVER logged, echoed, or placed
// in any returned message/error. Only the caller's redacted persistence path
// ever touches it. Honest failure = a structured skip reason (no token), never
// a fabricated value.
//
// FR-3's scope is UNCHANGED: this helper is derive-only and does not alter
// which lifecycle ops adopt. It only removes the duplication between the two
// derive sites the ruling asked us to share.

import { resumeTypeForRuntime, validateResumeToken, type ResumeType } from "./resume-token-validation.js";

export interface ResumeTokenCaptureDeps {
  contextUsageStore?: {
    readSidecar(sessionName: string): { ok: true; data: { session_id?: string } } | { ok: false; reason: string };
  } | null;
  resumeTokenCapturer?: {
    captureCodexThreadId(sessionName: string): Promise<string | undefined>;
  } | null;
}

export type ResumeTokenDeriveResult =
  /** Runtime has no resume token (terminal / unknown) — not a failure, no event. */
  | { outcome: "exempt" }
  /** A required derive dependency is absent (older wiring / test) — silent no-op. */
  | { outcome: "noop" }
  /** A live token was derived + format-validated. The caller persists it. */
  | { outcome: "captured"; resumeType: ResumeType; token: string }
  /** Derivation ran but produced no usable token — the caller emits a skip event. */
  | { outcome: "skipped"; reason: "missing_sidecar" | "parse_error" | "probe_timeout" | "invalid_token" };

/**
 * Derive a runtime's resume token from live, read-only sources:
 *   claude-code → the status-line sidecar's session_id (a file read)
 *   codex       → the thread id derived from live pid-keyed logs
 * Returns a structured outcome; never throws for a missing/invalid token
 * (those are honest skips). ANY unexpected throw from a dependency is the
 * caller's to swallow (capture must never fail or block its lifecycle op).
 */
export async function deriveResumeToken(
  input: { runtime: string | null; sessionName: string },
  deps: ResumeTokenCaptureDeps,
): Promise<ResumeTokenDeriveResult> {
  const resumeType = resumeTypeForRuntime(input.runtime);
  if (!resumeType) return { outcome: "exempt" }; // terminal / unknown — exempt, not a failure

  const runtime = input.runtime as string; // non-null: resumeType is set only for claude-code / codex

  let token: string | undefined;
  if (runtime === "claude-code") {
    if (!deps.contextUsageStore) return { outcome: "noop" }; // dep absent — silent no-op
    const sidecar = deps.contextUsageStore.readSidecar(input.sessionName);
    if (!sidecar.ok) {
      return { outcome: "skipped", reason: sidecar.reason === "parse_error" ? "parse_error" : "missing_sidecar" };
    }
    const sid = sidecar.data.session_id;
    if (typeof sid === "string" && sid.trim().length > 0) token = sid.trim();
    else return { outcome: "skipped", reason: "missing_sidecar" };
  } else if (runtime === "codex") {
    if (!deps.resumeTokenCapturer) return { outcome: "noop" }; // dep absent — silent no-op
    token = await deps.resumeTokenCapturer.captureCodexThreadId(input.sessionName);
    if (!token) return { outcome: "skipped", reason: "probe_timeout" };
  } else {
    return { outcome: "noop" }; // resumeType set but runtime is not one we derive — defensive
  }

  // Defensive format validation before the caller persists — a malformed token
  // is an honest skip, never a bad write (validity-before-rank).
  const validation = validateResumeToken(runtime, token);
  if (!validation.ok) return { outcome: "skipped", reason: "invalid_token" };

  return { outcome: "captured", resumeType: validation.resumeType, token: validation.token };
}
