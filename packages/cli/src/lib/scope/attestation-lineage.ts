// OPR.0.5.0.18 — the CANONICAL amendment-lineage derivation (ONE source of truth).
//
// The re-stamp verb (`rig scope … approve --re-approve`) writes
// `approved-spec-priors` / `approved-priors` atomically beside the current stamp,
// so a filesystem-local audit can show lineage without DB access. Returns
// undefined for never-amended scopes (first-approve output unchanged).
//
// SHARED ACROSS PACKAGES BY GENERATION: the daemon audit route consumes the
// byte-identical body via packages/daemon/src/domain/scope/
// attestation-lineage.generated.ts, emitted by `node scripts/sync-scope-lineage.mjs`
// (the CLI→daemon import direction is barred, so the repo's mirror/codegen
// convention carries it). EDIT THIS FILE ONLY, then run the sync — the
// scope-lineage-parity pin fails if the two ever diverge.

export interface AttestationLineage {
  spec?: { by: string; at: string; priors: number };
  delivery?: { by: string; at: string; priors: number };
}

export function attestationLineage(frontmatterRaw: string | null): AttestationLineage | undefined {
  if (!frontmatterRaw) return undefined;
  const read = (key: string): string | null => {
    const m = new RegExp(`^${key}\\s*:\\s*(.+)$`, "m").exec(frontmatterRaw);
    return m ? m[1]!.trim().replace(/^["']|["']$/g, "") : null;
  };
  const lineage: AttestationLineage = {};
  for (const [scope, fields] of [
    ["spec", { by: "approved-spec-by", at: "approved-spec-at", priors: "approved-spec-priors" }],
    ["delivery", { by: "approved-by", at: "approved-at", priors: "approved-priors" }],
  ] as const) {
    const priorsRaw = read(fields.priors);
    const priors = priorsRaw !== null ? Number(priorsRaw) : NaN;
    if (Number.isFinite(priors) && priors > 0) {
      lineage[scope] = { by: read(fields.by) ?? "?", at: read(fields.at) ?? "?", priors };
    }
  }
  return Object.keys(lineage).length > 0 ? lineage : undefined;
}
