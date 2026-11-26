export interface ConfiguredContextBudget {
  tokens: number;
  usedPercentage: number | null;
  source: "CLAUDE_CODE_AUTO_COMPACT_WINDOW";
}

export function configuredBudgetLabel(budget: ConfiguredContextBudget | null | undefined): string {
  if (!budget) return "unknown";
  const percent = budget.usedPercentage == null ? "unknown" : `${budget.usedPercentage}%`;
  return `${percent} configured budget (${budget.tokens.toLocaleString()} tokens; ${budget.source})`;
}
