import type { Migration } from "../migrate.js";

/** #3044 C3: the occupant generation the Claude status-line collector recorded with a context sample, so a reader can
 *  tell the live occupant's own sample from a prior one when the time comparison can't: a recovered successor ran,
 *  and sampled, before the handover commit registered its generation. NULL when the sample recorded none. */
export const contextUsageOccupantGenerationSchema: Migration = {
  name: "168_context_usage_occupant_generation.sql",
  sql: `
    ALTER TABLE context_usage ADD COLUMN occupant_generation TEXT;
  `,
};
