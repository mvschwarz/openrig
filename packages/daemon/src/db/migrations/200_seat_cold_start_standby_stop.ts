import type { Migration } from "../migrate.js";

export const seatColdStartStandbyStopSchema: Migration = {
  name: "200_seat_cold_start_standby_stop.sql",
  sql: "ALTER TABLE seat_cold_starts ADD COLUMN standby_stop_seq INTEGER;",
};
