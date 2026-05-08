// V1 attempt-3 Phase 4 — SharedDetailDrawer chrome + DrawerSelection
// union extended for the 4 new viewer kinds (qitem / file / sub-spec /
// seat-detail) per content-drawer.md.
//
// SC-22 preserved: default-closed (selection===null returns null);
// VellumSheet width="wide" (38rem); user-closable [×]; one-trigger-at-
// a-time (clicking new trigger swaps content via setSelection).
//
// Phase 4 P4-5: 'rig' kind removed from DrawerSelection. RigDetailPanel
// retired (legacy auto-open right-sidebar pattern); rig clicks now
// navigate to /topology/rig/$rigId via URL (no drawer auto-open).

import { SystemPanel } from "./SystemPanel.js";
import { DiscoveryPanel, type DiscoveryPlacementTarget } from "./DiscoveryPanel.js";
import { VellumSheet } from "./ui/vellum-sheet.js";
import { QueueItemViewer, type QueueItemViewerData } from "./drawer-viewers/QueueItemViewer.js";
import { FileViewer, type FileViewerData } from "./drawer-viewers/FileViewer.js";
import { SubSpecPreview, type SubSpecPreviewData } from "./drawer-viewers/SubSpecPreview.js";
import type { ActivityEvent } from "../hooks/useActivityFeed.js";

// V1 polish slice Phase 5.1 P5.1-1 + DRIFT P5.1-D2: 'seat-detail' kind
// RETIRED at V1 polish. Graph node click + tree
// click + table row click all navigate to /topology/seat/$rigId/$logicalId
// center page (canonical agent-detail surface = LiveNodeDetails).
// SeatDetailViewer wrapper component DELETED; SeatDetailTrigger primitive
// DELETED. Drawer remains a content-viewer surface for the other auto-
// open triggers (qitem / file / sub-spec) per content-drawer.md L23-L34.
export type DrawerSelection =
  | { type: "system"; tab?: "log" | "status" }
  | { type: "discovery" }
  // Phase 4 viewer kinds (seat-detail retired Phase 5.1 P5.1-D2)
  | { type: "qitem"; data: QueueItemViewerData }
  | { type: "file"; data: FileViewerData }
  | { type: "sub-spec"; data: SubSpecPreviewData }
  | null;

interface SharedDetailDrawerProps {
  selection: DrawerSelection;
  onClose: () => void;
  events: ActivityEvent[];
  selectedDiscoveredId: string | null;
  onSelectDiscoveredId: (id: string | null) => void;
  placementTarget: DiscoveryPlacementTarget;
  onClearPlacement: () => void;
}

export function SharedDetailDrawer({
  selection,
  onClose,
  events,
  selectedDiscoveredId,
  onSelectDiscoveredId,
  placementTarget,
  onClearPlacement,
}: SharedDetailDrawerProps) {
  // SC-6 — default-closed; chrome only mounts when a named trigger has set selection.
  if (!selection) return null;

  const inner = (() => {
    if (selection.type === "system") {
      return (
        <SystemPanel onClose={onClose} events={events} initialTab={selection.tab ?? "log"} />
      );
    }
    if (selection.type === "discovery") {
      return (
        <DiscoveryPanel
          onClose={onClose}
          selectedDiscoveredId={selectedDiscoveredId}
          onSelectDiscoveredId={onSelectDiscoveredId}
          placementTarget={placementTarget}
          onClearPlacement={onClearPlacement}
        />
      );
    }
    if (selection.type === "qitem") {
      return <QueueItemViewer {...selection.data} />;
    }
    if (selection.type === "file") {
      return <FileViewer {...selection.data} />;
    }
    if (selection.type === "sub-spec") {
      return <SubSpecPreview {...selection.data} />;
    }
    return null;
  })();

  return (
    <div
      data-testid="shared-detail-drawer-layer"
      className="fixed top-14 right-0 bottom-0 left-0 z-30 pointer-events-none"
    >
      <button
        type="button"
        aria-label="Close drawer"
        data-testid="shared-detail-drawer-outside"
        className="absolute inset-0 cursor-default pointer-events-auto"
        onPointerDown={onClose}
      />
      <VellumSheet
        edge="right"
        width="wide"
        onClose={onClose}
        testId="shared-detail-drawer"
        // top-14 starts below the universal top bar (h-14, fixed at top); bottom-0
        // anchors to viewport bottom so the drawer fills the remaining height.
        // Bounce-fix #3 width-coupling: 38rem (lg:w-[38rem]) per VellumSheet wide preset.
        className="absolute top-0 right-0 bottom-0 z-10 pointer-events-auto"
      >
        {inner}
      </VellumSheet>
    </div>
  );
}
