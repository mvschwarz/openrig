import type { Migration } from "../migrate.js";

/**
 * OPR.0.4.8.3 Seam B (R2 — dev-guard restart-provenance ruling): additive restart-stable
 * provenance columns for a node's RESOLVED permission-policy attachment. The raw ref
 * (migration 055) alone is NOT restart-complete — a restore must be able to re-derive
 * surface + launch posture without the original in-memory RigSpec:
 *   - policy_origin           'builtin' | 'custom' (origin honesty, never reclassified)
 *   - policy_resolved_target  custom: the absolute resolved policy path.
 *                             builtin: the canonical shipped package-copy path ONCE the
 *                             packaging leg rules it (PM lane c76c7153) — NULL until then;
 *                             never a `builtin:<name>` echo of the raw ref.
 *   - policy_declaring_dir    custom: the canonical declaring RigSpec directory.
 *   - policy_launch_posture   'floor' | 'full_bypass' — the resolved posture at materialize;
 *                             restore re-resolves and reconciles (a custom flag policy must
 *                             restore to full_bypass — the ruling's crux).
 * Additive only: no rework of 055/056. NULLs = no policy attached (honest absence).
 */
export const nodePolicyProvenanceSchema: Migration = {
  name: "057_node_policy_provenance.sql",
  sql: `
    ALTER TABLE nodes ADD COLUMN policy_origin TEXT;
    ALTER TABLE nodes ADD COLUMN policy_resolved_target TEXT;
    ALTER TABLE nodes ADD COLUMN policy_declaring_dir TEXT;
    ALTER TABLE nodes ADD COLUMN policy_launch_posture TEXT;
  `,
};
