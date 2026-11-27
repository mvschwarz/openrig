import type { Migration } from "../migrate.js";

export const contextConfiguredBudgetSchema: Migration = {
  name: "200_context_configured_budget.sql",
  sql: `ALTER TABLE context_usage ADD COLUMN configured_budget_tokens INTEGER;`,
};
