// V1 attempt-3 Phase 2 — SharedDetailDrawer chrome.
//
// Per content-drawer.md L9: "default closed, opens only on named
// triggers, user-closable at any time, wider than the current
// right-sidebar (closer to document-reading width)."
//
// Phase 2 lays the chrome: VellumSheet primitive (Phase 1) wraps each
// panel; default-closed (selection === null returns null); ~608px wide
// on desktop (`lg:w-[38rem]` via VellumSheet width="wide"; calibrated
// 2026-05-06 per content-drawer.md L9); user-closable via VellumSheet's
// onClose [×] button.
//
// Phase 4 wires the new viewer types (QueueItemViewer, FileViewer,
// SubSpecPreview, SeatDetailViewer) and named triggers from feed cards
// + topology table rows + spec sub-references. The current rig / node /
// system / discovery panels are preserved as transitional viewers
// (existing surfaces still set DrawerSelection.type to one of them).
//
// SC-6 (default-closed; opens only on named triggers): selection===null
// → renders null; chrome only mounts when a named selection is present.

import { RigDetailPanel } from "./RigDetailPanel.js";
import { NodeDetailPanel } from "./NodeDetailPanel.js";
import { SystemPanel } from "./SystemPanel.js";
import { DiscoveryPanel, type DiscoveryPlacementTarget } from "./DiscoveryPanel.js";
import { VellumSheet } from "./ui/vellum-sheet.js";
import type { ActivityEvent } from "../hooks/useActivityFeed.js";

// Drawer selection union. The "specs" variant from prior shells was
// removed in Phase 2 (SpecsPanel.tsx deleted; specs detail pages render
// in the CENTER workspace per content-drawer.md decision rule —
// "Full-feature page (spec detail, slice detail, mission detail) — Center").
export type DrawerSelection =
  | { type: "rig"; rigId: string }
  | { type: "node"; rigId: string; logicalId: string }
  | { type: "system"; tab?: "log" | "status" }
  | { type: "discovery" }
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
    if (selection.type === "rig") {
      return <RigDetailPanel rigId={selection.rigId} onClose={onClose} />;
    }
    if (selection.type === "node") {
      return (
        <NodeDetailPanel
          rigId={selection.rigId}
          logicalId={selection.logicalId}
          onClose={onClose}
        />
      );
    }
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
    return null;
  })();

  return (
    <VellumSheet
      edge="right"
      width="wide"
      onClose={onClose}
      testId="shared-detail-drawer"
      // top-14 starts below the universal top bar (h-14, fixed at top); bottom-0
      // anchors to viewport bottom so the drawer fills the remaining height
      // without needing a calc() expression.
      className="fixed top-14 right-0 bottom-0 z-30"
    >
      {inner}
    </VellumSheet>
  );
}
