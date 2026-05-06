import * as React from "react";
import { cn } from "@/lib/utils";

export type RigStampSize = "sm" | "md" | "lg" | "xl";

export interface RigStampPosition {
  top?: number | string;
  left?: number | string;
  right?: number | string;
  bottom?: number | string;
}

export interface RigStampProps {
  text: string;
  position?: RigStampPosition;
  size?: RigStampSize;
  className?: string;
  testId?: string;
}

const sizeClass: Record<RigStampSize, string> = {
  sm: "text-[10px]",
  md: "text-sm",
  lg: "text-2xl",
  xl: "text-4xl",
};

function toCss(v: number | string | undefined): string | undefined {
  if (v === undefined) return undefined;
  return typeof v === "number" ? `${v}px` : v;
}

export function RigStamp({
  text,
  position,
  size = "md",
  className,
  testId,
}: RigStampProps) {
  const style: React.CSSProperties = {
    top: toCss(position?.top),
    left: toCss(position?.left),
    right: toCss(position?.right),
    bottom: toCss(position?.bottom),
  };
  return (
    <span
      data-testid={testId}
      className={cn("stamp-watermark", sizeClass[size], className)}
      style={style}
      aria-hidden="true"
    >
      {text}
    </span>
  );
}
