// V1 attempt-3 Phase 4 — SubSpecTrigger.

import { type ReactNode, type CSSProperties } from "react";
import { useDrawerSelection } from "../AppShell.js";
import type { SubSpecPreviewData } from "../drawer-viewers/SubSpecPreview.js";

interface SubSpecTriggerProps {
  data: SubSpecPreviewData;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  testId?: string;
}

export function SubSpecTrigger({ data, children, className, style, testId }: SubSpecTriggerProps) {
  const { setSelection } = useDrawerSelection();
  return (
    <button
      type="button"
      data-testid={testId ?? "sub-spec-trigger"}
      onClick={() => setSelection({ type: "sub-spec", data })}
      className={className ?? "text-left"}
      style={style}
    >
      {children}
    </button>
  );
}
