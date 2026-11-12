import type { Migration } from "../migrate.js";

export const nodeLaunchWrapperSchema: Migration = {
  name: "150_node_launch_wrapper.sql",
  sql: "ALTER TABLE nodes ADD COLUMN launch_wrapper TEXT;",
};
