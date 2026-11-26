// Claude model aliases depend on runtime version, provider and user overrides. Recognize the
// settings without inventing a resolved model id. This advisory never makes a spec invalid.

/** Includes Claude's default selector and opusplan mode, which also have no fixed model id. */
export function isClaudeModelAlias(pin: unknown): boolean {
  return typeof pin === "string" && /^(?:opus|sonnet|haiku|fable|best|default|opusplan)(?:\[1m\])?$/i.test(pin.trim());
}

/** Encourage an exact pin without a release-specific alias table. */
export function aliasModelPinAdvisory(pin: unknown, where: string): string | null {
  if (!isClaudeModelAlias(pin)) return null;
  return `${where}: model pin "${pin}" is a Claude alias or selector — use a full model id for exact comparison. ` +
    `Its resolution depends on the runtime, provider and settings; divergence remains unknown until the expected id is resolved.`;
}
