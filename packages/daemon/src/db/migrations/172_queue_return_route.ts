import type { Migration } from "../migrate.js";

// A goal row's return route: the conversation a person chose to answer the team from (`rig queue create --return-route`),
// and how it was established. Nullable: a row without one keeps today's delivery. Handoffs copy both to the successor.
// The two partial indexes hold routed rows only: the wake ladder reads them every tick, and escalations read who waits on a row.
export const queueReturnRouteSchema: Migration = {
  name: "172_queue_return_route.sql",
  sql: `
    ALTER TABLE queue_items ADD COLUMN return_route TEXT;
    ALTER TABLE queue_items ADD COLUMN return_route_basis TEXT;
    CREATE INDEX IF NOT EXISTS idx_queue_items_blocked_routed ON queue_items(blocked_on) WHERE state = 'blocked' AND return_route IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_queue_items_open_routed ON queue_items(state) WHERE return_route IS NOT NULL;
  `,
};
