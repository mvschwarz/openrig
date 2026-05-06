import * as React from "react";
import { cn } from "@/lib/utils";

export type SectionHeaderTone = "default" | "muted" | "emphasis";

type PolymorphicAs = "header" | "div" | "section";

export interface SectionHeaderProps extends React.HTMLAttributes<HTMLElement> {
  children?: React.ReactNode;
  right?: React.ReactNode;
  tone?: SectionHeaderTone;
  as?: PolymorphicAs;
}

const toneClass: Record<SectionHeaderTone, string> = {
  default: "text-stone-900",
  muted: "text-on-surface-variant",
  emphasis: "text-tertiary",
};

export function SectionHeader({
  children,
  right,
  tone = "default",
  as = "header",
  className,
  ...rest
}: SectionHeaderProps) {
  const cls = cn(
    "font-mono text-[10px] uppercase tracking-[0.18em] flex items-baseline justify-between gap-2",
    toneClass[tone],
    className,
  );
  const inner = (
    <>
      <span className="flex-1">{children}</span>
      {right ? <span className="ml-auto flex items-center gap-2">{right}</span> : null}
    </>
  );
  if (as === "div") return <div className={cls} {...rest}>{inner}</div>;
  if (as === "section") return <section className={cls} {...rest}>{inner}</section>;
  return <header className={cls} {...rest}>{inner}</header>;
}
