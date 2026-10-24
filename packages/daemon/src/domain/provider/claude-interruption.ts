/** Claude's typed provider failure, never a tool name, quoted message or human prompt. */
export function isClaudeRateLimitHook(
  runtime: string | null | undefined,
  event: string | null | undefined,
  subtype: string | null | undefined,
): boolean {
  return runtime === "claude-code" && event === "StopFailure" && subtype === "rate_limit";
}
