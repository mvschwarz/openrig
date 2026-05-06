// MissionControlSurface — Phase 2 SHELL-AND-STUB (V1 attempt-3 DRIFT P2-C
// resolution). The /mission-control route is deleted in Phase 2 per
// SC-18, so this placeholder is unreachable. Phase 3 will refactor
// the body in place to render the For You feed shape (5 card types
// per for-you-feed.md).
//
// View sub-files (ActiveWorkView, FleetView, GenericListView,
// HumanGateView, MyQueueView, RecentObservationsView, RecentShipsView,
// RecentlyActiveView) deleted in Phase 2; AuditHistoryView preserved
// for Phase 3 /search mount.

import { EmptyState } from "../ui/empty-state";

export function MissionControlSurface() {
  return (
    <div
      data-testid="mc-surface"
      className="flex h-full flex-col items-center justify-center"
    >
      <EmptyState
        label="MISSION CONTROL"
        description="For You feed under construction (Phase 3). The /mission-control route is no longer reachable; this surface is preserved for in-place refactor."
        variant="card"
        testId="mc-surface-stub"
      />
    </div>
  );
}
