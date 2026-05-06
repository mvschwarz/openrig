import * as React from "react";
import { cn } from "@/lib/utils";
import { RegistrationMarks } from "./registration-marks";

export type VellumSheetEdge = "left" | "right";
export type VellumSheetWidth = "wide" | "narrow";

export interface VellumSheetProps extends React.HTMLAttributes<HTMLDivElement> {
  children?: React.ReactNode;
  edge?: VellumSheetEdge;
  width?: VellumSheetWidth;
  onClose?: () => void;
  testId?: string;
}

const widthClass: Record<VellumSheetWidth, string> = {
  // V1 calibration 2026-05-06 (universal-shell.md L36 + content-drawer.md L9):
  // 38rem (~608px) = iPad-portrait reading width. Wide enough for markdown /
  // spec docs, narrow enough to keep center workspace visible behind it.
  // Original spec was 45rem; calibrated after founder walk.
  wide: "w-full lg:w-[38rem] lg:max-w-[80vw]",
  narrow: "w-full lg:w-[22rem] lg:max-w-[60vw]",
};

const edgeClass: Record<VellumSheetEdge, string> = {
  // V1 border weight doctrine (universal-shell.md L39–L48):
  // 1px outline-variant ghost line for inter-region edges. NO 2px stone-900
  // (which reads as "boxed UI"; tactical-dossier wants paper-layered).
  left: "border-r border-outline-variant",
  right: "border-l border-outline-variant",
};

export function VellumSheet({
  children,
  edge = "right",
  width = "wide",
  onClose,
  className,
  testId,
  ...rest
}: VellumSheetProps) {
  return (
    <div
      className={cn(
        "vellum-heavy relative flex flex-col h-full shadow-[0_0_24px_rgba(0,0,0,0.08)]",
        widthClass[width],
        edgeClass[edge],
        className,
      )}
      data-testid={testId}
      role="dialog"
      aria-modal="false"
      {...rest}
    >
      {onClose ? (
        <button
          type="button"
          onClick={onClose}
          aria-label="Close sheet"
          className="absolute top-2 right-2 z-10 px-2 py-0.5 border border-stone-900 bg-white font-mono text-[10px] hover:bg-stone-100"
          data-testid={testId ? `${testId}-close` : undefined}
        >
          ×
        </button>
      ) : null}
      <div className="flex-1 overflow-auto">{children}</div>
      <RegistrationMarks testIdPrefix={testId} />
    </div>
  );
}
