import type { Migration } from "../migrate.js";

export const rigDeliveryDrainsSchema: Migration = {
  name: "167_rig_delivery_drains.sql",
  sql: `
    CREATE TABLE IF NOT EXISTS rig_delivery_drains (
      id INTEGER PRIMARY KEY,
      rig_id TEXT NOT NULL REFERENCES rigs(id) ON DELETE CASCADE,
      drain_id TEXT NOT NULL,
      owner TEXT NOT NULL,
      started_at TEXT NOT NULL,
      review_at TEXT NOT NULL,
      review_job_id TEXT NOT NULL,
      ended_at TEXT,
      UNIQUE(rig_id, drain_id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_rig_delivery_drains_active
      ON rig_delivery_drains(rig_id) WHERE ended_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_rig_delivery_drains_review
      ON rig_delivery_drains(review_job_id) WHERE ended_at IS NULL;
  `,
};
