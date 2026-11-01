/** An older daemon can ignore new fields. A read-only plan must acknowledge the exact selection before a mutation. */
export function accountHomePlanMatches(plan: Record<string, unknown>, home: string | null,
  token?: { label: string; tokenFile: string }): boolean {
  if (plan["ok"] !== true || plan["dryRun"] !== true || plan["accountHome"] !== home) return false;
  const selected = plan["accountToken"] as { label?: unknown; tokenFile?: unknown } | null | undefined;
  return token ? selected?.label === token.label && selected?.tokenFile === token.tokenFile : selected == null;
}
