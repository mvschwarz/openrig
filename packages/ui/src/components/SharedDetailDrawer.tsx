import { RigDetailPanel } from "./RigDetailPanel.js";
import { NodeDetailPanel } from "./NodeDetailPanel.js";
import { SystemPanel } from "./SystemPanel.js";
import { DiscoveryPanel, type DiscoveryPlacementTarget } from "./DiscoveryPanel.js";
import { SpecsPanel } from "./SpecsPanel.js";
import type { ActivityEvent } from "../hooks/useActivityFeed.js";

export type DrawerSelection =
  | { type: "rig"; rigId: string }
  | { type: "node"; rigId: string; logicalId: string }
  | { type: "system"; tab?: "log" | "status" }
  | { type: "discovery" }
  | { type: "specs" }
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
  if (!selection) return null;

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
    return <SystemPanel onClose={onClose} events={events} initialTab={selection.tab ?? "log"} />;
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

  if (selection.type === "specs") {
    return <SpecsPanel onClose={onClose} />;
  }

  return null;
}
