// V1 attempt-3 Phase 4 — SeatDetailTrigger.
//
// Replaces the legacy auto-open RigDetailPanel pattern. Wraps a
// clickable element (e.g., a "details" icon next to a topology seat
// row) and opens the SeatDetailViewer in the drawer on click. Per
// content-drawer.md L37–L42 manual-open contract.

import { type ReactNode, type CSSProperties } from "react";
import { useDrawerSelection } from "../AppShell.js";

interface SeatDetailTriggerProps {
  rigId: string;
  logicalId: string;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  testId?: string;
}

export function SeatDetailTrigger({ rigId, logicalId, children, className, style, testId }: SeatDetailTriggerProps) {
  const { setSelection } = useDrawerSelection();
  return (
    <button
      type="button"
      data-testid={testId ?? "seat-detail-trigger"}
      onClick={() => setSelection({ type: "seat-detail", rigId, logicalId })}
      className={className ?? "text-left"}
      style={style}
    >
      {children}
    </button>
  );
}
