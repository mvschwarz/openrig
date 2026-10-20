import type { Migration } from "../migrate.js";

export const typingGuardModesSchema: Migration = {
  name: "100_typing_guard_modes.sql",
  sql: `
    ALTER TABLE seat_delivery_guards ADD COLUMN desired_config TEXT;
    ALTER TABLE seat_delivery_guards ADD COLUMN effective_config TEXT;
    ALTER TABLE seat_delivery_guard_changes ADD COLUMN desired_config TEXT;
    ALTER TABLE outbox_entries ADD COLUMN guard_delivery TEXT;
  `,
};
