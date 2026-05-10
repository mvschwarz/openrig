// V1 polish slice Phase 5.1 P5.1-3: pod name truncation bug fix.
// Pod names were rendering as "covery" / "anning" — first 2-3 chars
// cut. Root cause: displayPodName was calling shortId(podId, 6)
// which returns the LAST 6 chars of any string — fine for 26-char ULIDs
// (random tail more distinguishable than timestamp head) but WRONG for
// human-readable pod namespaces ("discovery" / "planning" / "kernel"
// etc.). Pod IDs in OpenRig are namespace strings, not ULIDs; the
// shortId path should never have applied. Returning the podId verbatim.
//
// shortId is still imported elsewhere for actual ULID display surfaces
// (rig IDs, qitem tails, etc.) — this fix only touches the pod path.

export function inferPodName(logicalId: string | null | undefined): string | null {
  if (!logicalId) return null;
  const parts = logicalId.split(".");
  if (parts.length <= 1) return logicalId;
  return parts[0] ?? logicalId;
}

export function displayPodName(podId: string | null | undefined): string {
  // Pod IDs are human-readable namespace strings, not ULIDs — return
  // verbatim so "discovery" stays "discovery" (NOT "covery").
  return podId && podId.length > 0 ? podId : "ungrouped";
}

export function displayAgentName(logicalId: string | null | undefined): string {
  if (!logicalId) return "unknown";
  const parts = logicalId.split(".");
  if (parts.length <= 1) return logicalId;
  return parts.at(-1) ?? logicalId;
}
