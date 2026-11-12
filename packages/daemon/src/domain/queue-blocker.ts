/** Typed non-queue gates take precedence over custom queue IDs. */
export const TYPED_GATE_BLOCKER_PREFIXES = ["fold:", "auth:", "external:"] as const;

export function typedGateBlockerPrefix(value: string): string | null {
  return TYPED_GATE_BLOCKER_PREFIXES.find((prefix) => value.startsWith(prefix)) ?? null;
}

export function isTypedGateBlocker(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const prefix = typedGateBlockerPrefix(value);
  return prefix != null && value.slice(prefix.length).trim().length > 0;
}
