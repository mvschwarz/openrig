import type { Migration } from "../migrate.js";

/** The adopted occupant whose live writer was verified in the switch's bound successor pane. */
export const ompSwitchAdoptionSchema: Migration = {
  name: "196_omp_switch_adoption.sql",
  sql: "ALTER TABLE seat_runtime_switches ADD COLUMN verified_adoption_generation TEXT;",
};
