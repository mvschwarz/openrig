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
import { SeatDetailViewer } from "./drawer-viewers/SeatDetailViewer.js";
import type { ActivityEvent } from "../hooks/useActivityFeed.js";

// V1 attempt-3 Phase 5 P5-4: legacy 'node' kind retired. The 'seat-detail' kind
// (Phase 4) is now the single canonical seat-detail surface; SeatDetailViewer
// wraps NodeDetailPanel inside the canonical 38rem drawer chrome. Founder noticed
// graph-node clicks rendered NodeDetailPanel "full-width with empty whitespace
// on left" — width-coupling broke when the legacy 'node' branch routed
// NodeDetailPanel directly past the drawer chrome. Migration: every prior
// setSelection({type:'node',...}) callsite now routes through 'seat-detail';
// useNodeSelection alias coerces same. Negative-assertion test enforces removal.
export type DrawerSelection =
  | { type: "system"; tab?: "log" | "status" }
  | { type: "discovery" }
  // Phase 4 viewer kinds
  | { type: "qitem"; data: QueueItemViewerData }
  | { type: "file"; data: FileViewerData }
  | { type: "sub-spec"; data: SubSpecPreviewData }
  | { type: "seat-detail"; rigId: string; logicalId: string }
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
    if (selection.type === "seat-detail") {
      return (
        <SeatDetailViewer
          rigId={selection.rigId}
          logicalId={selection.logicalId}
          onClose={onClose}
        />
      );
    }
    return null;
  })();

  return (
    <VellumSheet
      edge="right"
      width="wide"
      onClose={onClose}
      testId="shared-detail-drawer"
      // top-14 starts below the universal top bar (h-14, fixed at top); bottom-0
      // anchors to viewport bottom so the drawer fills the remaining height.
      // Bounce-fix #3 width-coupling: 38rem (lg:w-[38rem]) per VellumSheet wide preset.
      className="fixed top-14 right-0 bottom-0 z-30"
    >
      {inner}
    </VellumSheet>
  );
}
