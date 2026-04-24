import type { Migration } from "../migrate.js";

export const seatHandoverObservabilitySchema: Migration = {
  name: "021_seat_handover_observability.sql",
  sql: `
    ALTER TABLE nodes ADD COLUMN occupant_lifecycle TEXT;
    ALTER TABLE nodes ADD COLUMN continuity_outcome TEXT;
    ALTER TABLE nodes ADD COLUMN handover_result TEXT;
    ALTER TABLE nodes ADD COLUMN previous_occupant TEXT;
    ALTER TABLE nodes ADD COLUMN handover_at TEXT;
  `,
};
