import type { Migration } from "../migrate.js";

/** A saved legacy mode and an operating posture (human-led/delegated) can be kept at the same scope and qualifier:
 *  the uniqueness moves from (scope, qualifier) to (scope, qualifier, category). Rows are not touched. */
export const modePostureCoexistSchema: Migration = {
  name: "109_mode_posture_coexist.sql",
  sql: `
    DROP INDEX IF EXISTS idx_operator_context_mode_bindings_scope_qualifier;
    CREATE UNIQUE INDEX idx_operator_context_mode_bindings_scope_qualifier_category
      ON operator_context_mode_bindings(scope, qualifier, (mode IN ('human-led', 'delegated')));
  `,
};
