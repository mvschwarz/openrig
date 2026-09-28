import type { Migration } from "../migrate.js";

/** Persist the built-in kernel spec variant selected during automatic boot. */
export const rigKernelVariantSchema: Migration = {
  name: "086_rig_kernel_variant.sql",
  sql: `
    ALTER TABLE rigs ADD COLUMN kernel_variant TEXT
      CHECK (kernel_variant IS NULL OR kernel_variant IN (
        'rig.yaml',
        'rig-claude-only.yaml',
        'rig-codex-only.yaml'
      ));
  `,
};
