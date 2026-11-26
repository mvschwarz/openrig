import type { Migration } from "../migrate.js";

/** A seat's native permission asks (slice 15), by seat and age. Two reads on the main connection want only those rows:
 *  each Claude seat's tool batch settles its asks whose call it names (`settleCompletedCalls`), and the wake ladder asks
 *  whether one holds the seat's prompt alert (`nativeAskHoldsPrompt`). With only the sender's index, each read walked every
 *  row the seat ever sent. Partial: a native ask's tags carry its hook tag verbatim (OpenRig writes it, and JSON leaves its
 *  letters, digits, "-" and ":" unescaped), and the reads repeat this WHERE clause byte for byte (NATIVE_ASK_ROWS in
 *  runner-permissions.ts), which is what lets the planner use it. Index-only: no table, trigger or backfill. */
export const queueItemsNativePermissionIndexSchema: Migration = {
  name: "199_queue_items_native_permission_index.sql",
  sql: `
    CREATE INDEX IF NOT EXISTS idx_queue_items_native_permission ON queue_items(source_session, ts_created)
      WHERE tags LIKE '%"permission-native-hook:%';
  `,
};
