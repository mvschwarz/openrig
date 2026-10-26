import type { Migration } from "../migrate.js";

/**
 * Preserve the validated source needed to perform a fresh launch after a
 * daemon restart. Startup context is runtime state and is legitimately null
 * for a seat that has never launched; the launch recipe is the durable
 * topology/configuration source for rebuilding that seat.
 */
export const nodeLaunchRecipeSchema: Migration = {
  name: "136_node_launch_recipe.sql",
  sql: `ALTER TABLE nodes ADD COLUMN launch_recipe_json TEXT;`,
};
