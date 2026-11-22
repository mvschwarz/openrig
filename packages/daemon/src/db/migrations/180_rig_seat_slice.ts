import type { Migration } from "../migrate.js";

/** #80: the rig's seat grouping (spec `seat_slice`). `rig` puts every seat the rig launches in a scope beneath the rig's
 *  own slice under openrigseats.slice; NULL keeps today's launch paths. */
export const rigSeatSliceSchema: Migration = {
  name: "180_rig_seat_slice.sql",
  sql: "ALTER TABLE rigs ADD COLUMN seat_slice TEXT CHECK (seat_slice IS NULL OR seat_slice = 'rig');",
};
