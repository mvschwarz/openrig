/**
 * Ghost-stage (e) contract seam — the INTERFACE authored by the ghost-stage slice (dev50-driver),
 * CALLED by the cutover/seat-handover slice at `SeatHandoverService.commit()`. The cutover owns the
 * single mechanical call; the ghost-stage slice owns the per-store invalidation impls behind this
 * interface. See GHOST-STAGE-e-store-enumeration-and-invalidation-contract.md.
 *
 * Root defect it closes: state keyed by a canonical seat NAME (member@rig / session_name) is inherited
 * by a successor occupant after a handover, because nothing invalidates the retiring occupant's entries
 * (a drained compaction stage, a frozen telemetry sample, a lifecycle message addressed to the retired
 * generation).
 *
 * ⚠ CUTOVER COORDINATION (flagged to the ghost-stage author): under the seat-handover CUTOVER the
 * successor RESUMES INTO THE SAME PANE and REUSES the canonical seat name, so at this call site
 * `retiringSessionName === successorSessionName`. The contract's Class-A "safe because the successor
 * boots under a NEW name" premise does NOT hold for the cutover — the impls must be same-name-safe:
 * Class-A relies on being invoked at commit BEFORE the successor accumulates any name-keyed state;
 * Class-B MUST gen-scope (a shared name cannot discriminate the retiree from the successor, so a
 * name-scoped drop would wrongly neutralize the successor's own legitimate role items).
 *
 * NOTE (cross-slice): this interface shape is byte-fixed by the contract; the ghost-stage slice authors
 * the canonical definition + impls. When the two slices integrate, dedupe to one definition (identical
 * shape → trivial). The cutover slice injects an impl optionally (absent until the ghost-stage slice
 * lands → the commit call is simply skipped, never blocking the handover).
 */
export interface OccupantInvalidator {
  /**
   * Invalidate every seat-name-keyed store's entries for the RETIRING occupant, so the successor never
   * inherits them. Class-A stores (in-mem compaction maps 1a–1f + the name-keyed context sidecar)
   * hard-delete by name; Class-B stores (queue_items / watchdog_jobs, which carry a legitimate seat
   * ROLE) gen-scope — requires the atom-B occupant-generation identity, and no-op LOUD until it lands.
   */
  invalidateRetiringOccupant(args: {
    retiringSessionName: string;
    successorSessionName: string;
    /** atom-B occupant-generation UUID; absent until atom-B lands → Class-B stores no-op loud. */
    retiringGeneration?: string;
  }): void;
}
