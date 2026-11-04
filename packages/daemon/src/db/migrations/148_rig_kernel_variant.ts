import type { Migration } from "../migrate.js";

/** The filename selected by automatic kernel boot, not a description of its current runtimes.
 *  Older and manually created rigs keep NULL; their original selection cannot be inferred. */
export const rigKernelVariantSchema: Migration = {
  name: "148_rig_kernel_variant.sql",
  sql: `ALTER TABLE rigs ADD COLUMN kernel_variant TEXT;`,
};
