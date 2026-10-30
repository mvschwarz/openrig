import type { Migration } from "../migrate.js";

/** Placement provenance and effect receipts, never a second work queue or secret store. */
export const environmentBindingsSchema: Migration = {
  name: "144_environment_bindings.sql",
  sql: `
    CREATE TABLE environment_bindings (
      binding_id TEXT PRIMARY KEY,
      version INTEGER NOT NULL CHECK(version = 1),
      node_id TEXT REFERENCES nodes(id),
      seat TEXT NOT NULL,
      ownership TEXT NOT NULL CHECK(ownership IN ('owned', 'attached')),
      config_json TEXT NOT NULL,
      resource_json TEXT,
      projection_json TEXT,
      generation TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX environment_binding_node ON environment_bindings(node_id) WHERE node_id IS NOT NULL;
    CREATE UNIQUE INDEX environment_binding_seat ON environment_bindings(seat);
    CREATE TABLE environment_operations (
      operation_id TEXT PRIMARY KEY,
      binding_id TEXT NOT NULL REFERENCES environment_bindings(binding_id),
      kind TEXT NOT NULL,
      request_json TEXT NOT NULL,
      effect_id TEXT,
      state TEXT NOT NULL CHECK(state IN ('intent', 'requested', 'confirmed', 'refused')),
      receipt_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `,
};
