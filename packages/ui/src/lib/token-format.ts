function cleanTokenCount(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.round(value);
}

function formatScaled(value: number): string {
  const abs = Math.abs(value);
  const rounded = abs < 10 ? Math.round(value * 10) / 10 : Math.round(value);
  return String(rounded).replace(/\.0$/, "");
}

export function sumTokenCounts(
  inputTokens: number | null | undefined,
  outputTokens: number | null | undefined,
): number | null {
  const input = cleanTokenCount(inputTokens);
  const output = cleanTokenCount(outputTokens);
  if (input === null && output === null) return null;
  return (input ?? 0) + (output ?? 0);
}

export function formatCompactTokenCount(value: number | null | undefined): string | null {
  const count = cleanTokenCount(value);
  if (count === null) return null;
  if (count >= 999_500) return `${formatScaled(count / 1_000_000)}m`;
  if (count >= 1_000) return `${formatScaled(count / 1_000)}k`;
  return count.toLocaleString("en-US");
}

export function formatTokenTotalTitle(
  inputTokens: number | null | undefined,
  outputTokens: number | null | undefined,
): string | null {
  const input = cleanTokenCount(inputTokens);
  const output = cleanTokenCount(outputTokens);
  const total = sumTokenCounts(input, output);
  if (total === null) return null;

  const lines = [`Tokens: ${total.toLocaleString("en-US")}`];
  if (input !== null) lines.push(`Input: ${input.toLocaleString("en-US")}`);
  if (output !== null) lines.push(`Output: ${output.toLocaleString("en-US")}`);
  return lines.join("\n");
}
