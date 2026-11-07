// ui-redesign C06: collapsible labeled sidebar section.

import { useState } from "react";
import * as Collapsible from "@radix-ui/react-collapsible";
import { cn } from "../../lib/utils.js";
import { readFoldedSections, writeFoldedSections } from "../../lib/sidebar-mode.js";

export interface SidebarSectionProps {
  id: string;
  label: string | null;
  collapsed: boolean;
  children: React.ReactNode;
}

export function SidebarSection({ id, label, collapsed, children }: SidebarSectionProps) {
  const [folded, setFolded] = useState<string[]>(() =>
    typeof window === "undefined" ? [] : readFoldedSections(),
  );
  const isFolded = folded.includes(id);
  // The `top` section has no label and is never foldable.
  const foldable = label !== null && id !== "top" && !collapsed;

  const setOpen = (open: boolean) => {
    // F9: re-read current storage instead of the mount-time snapshot, and
    // write outside the state updater (StrictMode may run updaters twice).
    const current = readFoldedSections().filter((v) => v !== id);
    const next = open ? current : [...current, id];
    writeFoldedSections(next);
    setFolded(next);
  };

  const heading = label && !collapsed ? (
    <h2 className="px-3 pt-4 pb-1 text-xs font-medium text-on-surface-variant">{label}</h2>
  ) : null;
  const body = <>{children}</>;

  // One shared group wrapper for both branches so the group markup isn't duplicated.
  const group = (inner: React.ReactNode) => (
    <div role="group" aria-label={label ?? undefined}>
      {inner}
    </div>
  );

  if (!foldable) {
    return group(
      <>
        {heading}
        {body}
      </>,
    );
  }

  return group(
    <Collapsible.Root open={!isFolded} onOpenChange={setOpen}>
      <Collapsible.Trigger
        aria-label={`${isFolded ? "Expand" : "Collapse"} ${label} section`}
        className={cn(
          "w-full px-3 pt-4 pb-1 text-left text-xs font-medium text-on-surface-variant",
          "hover:text-on-surface",
        )}
      >
        <span className="flex w-full items-center justify-between">
          {label}
          <span aria-hidden="true" className="text-[11px] leading-none">
            {isFolded ? "+" : "–"}
          </span>
        </span>
      </Collapsible.Trigger>
      <Collapsible.Content>{body}</Collapsible.Content>
    </Collapsible.Root>,
  );
}
