import { RigDetailPanel } from "./RigDetailPanel.js";
import { NodeDetailPanel } from "./NodeDetailPanel.js";
import { SystemPanel } from "./SystemPanel.js";
import type { ActivityEvent } from "../hooks/useActivityFeed.js";

export type DrawerSelection =
  | { type: "rig"; rigId: string }
  | { type: "node"; rigId: string; logicalId: string }
  | { type: "system"; tab?: "log" | "status" }
  | null;

interface SharedDetailDrawerProps {
  selection: DrawerSelection;
  onClose: () => void;
  events: ActivityEvent[];
}

export function SharedDetailDrawer({ selection, onClose, events }: SharedDetailDrawerProps) {
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

  return null;
}
