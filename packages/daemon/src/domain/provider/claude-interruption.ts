/** Claude's typed provider failure, never a tool name, quoted message or human prompt. */
export function isClaudeRateLimitHook(
  runtime: string | null | undefined,
  event: string | null | undefined,
  subtype: string | null | undefined,
): boolean {
  return runtime === "claude-code" && event === "StopFailure" && subtype === "rate_limit";
}

/** The documented StopFailure `error` values (Claude Code hooks reference) that report a login or credential the
 *  provider refused. `cloud_credential_error` arrives under that name from Claude Code 2.1.267; an older Claude reports
 *  the same failure as `server_error` or `unknown`, which stay generic. */
const CLAUDE_AUTH_FAILURES: ReadonlySet<string> = new Set(["authentication_failed", "oauth_org_not_allowed", "cloud_credential_error"]);

/** The documented StopFailure `error` values that report the account's billing or standing. */
const CLAUDE_BILLING_FAILURES: ReadonlySet<string> = new Set(["billing_error", "account_on_hold"]);

/** The typed reason a Claude StopFailure other than `rate_limit` carries. Auth and billing need a person; any other
 *  value, documented or not, is a generic provider error that keeps its raw value and never reads as auth or billing. */
export type ClaudeProviderFailureReason = "provider_auth_error" | "provider_billing_error" | "provider_error";

/** The typed reason for Claude's StopFailure `error` (never a tool name, quoted message or human prompt), or null for
 *  another runtime or event, a missing value, and `rate_limit`, which stays the usage limit. */
export function claudeProviderFailureReason(
  runtime: string | null | undefined,
  event: string | null | undefined,
  subtype: string | null | undefined,
): ClaudeProviderFailureReason | null {
  if (runtime !== "claude-code" || event !== "StopFailure" || typeof subtype !== "string" || !subtype || subtype === "rate_limit") {
    return null;
  }
  if (CLAUDE_AUTH_FAILURES.has(subtype)) return "provider_auth_error";
  if (CLAUDE_BILLING_FAILURES.has(subtype)) return "provider_billing_error";
  return "provider_error";
}
