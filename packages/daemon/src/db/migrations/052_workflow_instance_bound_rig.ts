import type { Migration } from "../migrate.js";

/**
 * OPR.0.4.6.FAC1 — workflow_instances.bound_rig column.
 *
 * The binding layer's A1 substrate: a workflow instance is pointed at a
 * rig at INSTANTIATION (`--rig` / route `targetRig`, defaulting to the
 * spec's `target.rig`), and the binding persists on the instance so
 * every owner-resolution site (projection, gate compile, entry, resume,
 * exception routing) resolves roles against THAT rig's inventory.
 *
 * Persists the rig NAME, not the id (ARCH Q4): the name is the durable
 * operator-space coordinate — consistent with the seat-name doctrine; a
 * torn-down-and-recreated rig keeps the binding. Name→id is resolved
 * FRESH at each resolution site (an exists-check-class read); a
 * vanished rig fails loud there, never silently.
 *
 * NULLABLE, no default: NULL = unbound = byte-identical pre-FAC-1
 * behavior for every pre-existing row and every instantiate that names
 * no rig. No backfill.
 *
 * NUMBERING (binding, arch supersession 2026-07-07): FAC-1 fixed-claims
 * 052; FS-1 renumbers its in-flight 051/052-adjacent migrations to 053+
 * at its own rebase regardless of merge order.
 */
export const workflowInstanceBoundRigSchema: Migration = {
  name: "052_workflow_instance_bound_rig.sql",
  sql: `
    ALTER TABLE workflow_instances ADD COLUMN bound_rig TEXT;
  `,
};
