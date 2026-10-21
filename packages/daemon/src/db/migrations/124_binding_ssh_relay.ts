import type { Migration } from "../migrate.js";
export const bindingSshRelaySchema: Migration = {
  name: "124_binding_ssh_relay.sql",
  sql: "ALTER TABLE bindings ADD COLUMN ssh_relay TEXT;",
};
