// V1 attempt-3 Phase 4 — FileReferenceTrigger.

import { type ReactNode, type CSSProperties } from "react";
import { useDrawerSelection } from "../AppShell.js";
import type { FileViewerData } from "../drawer-viewers/FileViewer.js";

interface FileReferenceTriggerProps {
  data: FileViewerData;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  testId?: string;
}

export function FileReferenceTrigger({ data, children, className, style, testId }: FileReferenceTriggerProps) {
  const { setSelection } = useDrawerSelection();
  return (
    <button
      type="button"
      data-testid={testId ?? "file-reference-trigger"}
      onClick={() => setSelection({ type: "file", data })}
      className={className ?? "text-left"}
      style={style}
    >
      {children}
    </button>
  );
}
