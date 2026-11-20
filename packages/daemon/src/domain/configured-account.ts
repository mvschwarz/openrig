import { parseClaudeSeatTokenRef } from "./claude-seat-token.js";

/** A configured label, never a claim about the running session's login. */
export function configuredAccount(runtime: string | null, hasTokenColumn: boolean, tokenRef: string | null, accountHome: string | null): string | null {
  if (runtime !== "claude-code" || !hasTokenColumn) return null;
  if (tokenRef === null) return accountHome ? null : "login";
  return parseClaudeSeatTokenRef(tokenRef)?.label ?? null;
}
