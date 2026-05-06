// V1 attempt-3 Phase 4 — QueueItemTrigger.
//
// Wraps clickable elements (qitem rows, feed cards "show context"
// affordances) and opens the drawer on click with the QueueItemViewer
// payload.

import { type ReactNode, type CSSProperties } from "react";
import { useDrawerSelection } from "../AppShell.js";
import type { QueueItemViewerData } from "../drawer-viewers/QueueItemViewer.js";

interface QueueItemTriggerProps {
  data: QueueItemViewerData;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  testId?: string;
}

export function QueueItemTrigger({ data, children, className, style, testId }: QueueItemTriggerProps) {
  const { setSelection } = useDrawerSelection();
  return (
    <button
      type="button"
      data-testid={testId ?? "queue-item-trigger"}
      onClick={() => setSelection({ type: "qitem", data })}
      className={className ?? "text-left"}
      style={style}
    >
      {children}
    </button>
  );
}
