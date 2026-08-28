import type { Migration } from "../migrate.js";

/**
 * S14 — structured owner-notification metadata on the durable queue transition.
 * Nullable is deliberate: historical and unclassified transitions remain RECORD;
 * no existing audit row is rewritten or inferred from prose.
 */
export const ownerNotificationLevelsSchema: Migration = {
  name: "076_owner_notification_levels.sql",
  sql: `
    ALTER TABLE queue_transitions ADD COLUMN owner_notification_kind TEXT;
    ALTER TABLE queue_transitions ADD COLUMN owner_notification_level TEXT;
    ALTER TABLE queue_transitions_archive ADD COLUMN owner_notification_kind TEXT;
    ALTER TABLE queue_transitions_archive ADD COLUMN owner_notification_level TEXT;
  `,
};
