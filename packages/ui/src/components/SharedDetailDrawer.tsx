import { RigDetailPanel } from "./RigDetailPanel.js";
import { NodeDetailPanel } from "./NodeDetailPanel.js";

export type DrawerSelection =
  | { type: "rig"; rigId: string }
  | { type: "node"; rigId: string; logicalId: string }
  | null;

interface SharedDetailDrawerProps {
  selection: DrawerSelection;
  onClose: () => void;
}

export function SharedDetailDrawer({ selection, onClose }: SharedDetailDrawerProps) {
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

  return null;
}
