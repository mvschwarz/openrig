// V1 attempt-3 Phase 4 — SeatDetailViewer per content-drawer.md L137–L139.
//
// V1.5 — Replaces the legacy auto-open right-sidebar pattern (RigDetailPanel
// retired in P4-5) with explicit manual-trigger drawer mount. Same content
// shape as the existing NodeDetailPanel; reuses that component as the
// payload renderer (which is what NodeDetailPanel already does in the
// preserved-canonical components per code-map AFTER tree).

import { NodeDetailPanel } from "../NodeDetailPanel.js";

export interface SeatDetailViewerData {
  rigId: string;
  logicalId: string;
  onClose?: () => void;
}

export function SeatDetailViewer({ rigId, logicalId, onClose }: SeatDetailViewerData) {
  return (
    <div data-testid="seat-detail-viewer" className="flex flex-col h-full">
      <NodeDetailPanel
        rigId={rigId}
        logicalId={logicalId}
        onClose={onClose ?? (() => {})}
      />
    </div>
  );
}
