// OPR.0.5.6.10 — the ONE taxonomy definition site, exported as a surface so the
// CLI's install validator teaches the same refusal the daemon parser enforces
// (desk ruling). Re-export only: a second
// value list anywhere is the defect this surface exists to prevent.
export { ATOM_TAXONOMIES, TAXONOMY_TEACHING } from "./domain/context-packs/context-pack-types.js";
// Install and serving must also share the same portable file-path contract.
export { validateSafePath } from "./domain/path-safety.js";
