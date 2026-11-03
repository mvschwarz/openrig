// ui-redesign C06: one labeled sidebar nav item.

import { Link } from "@tanstack/react-router";
import { cn } from "../../lib/utils.js";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../ui/tooltip.js";
import type { NavItem } from "../../lib/nav.js";

export interface SidebarNavItemProps {
  item: Pick<NavItem, "label" | "to" | "icon" | "testId" | "activeWhen">;
  pathname: string;
  collapsed: boolean;
  badge?: number;
  onNavigate?: () => void;
}

/** Right-side label tooltip used for every collapsed sidebar control. */
export function CollapsedTooltip({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent side="right">{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export function SidebarNavItem({ item, pathname, collapsed, badge = 0, onNavigate }: SidebarNavItemProps) {
  const Icon = item.icon;
  const active = item.activeWhen(pathname);
  const link = (
    <Link
      to={item.to}
      data-testid={item.testId}
      data-active={active}
      aria-label={item.label}
      aria-current={active ? "page" : undefined}
      onClick={onNavigate}
      className={cn(
        "relative flex h-11 lg:h-9 items-center gap-3 rounded-md px-3 text-sm font-medium transition-colors",
        collapsed && "justify-center px-0 w-11 lg:w-9",
        active
          ? "bg-surface-mid text-on-surface"
          : "text-on-surface-variant hover:bg-surface-low hover:text-on-surface",
      )}
    >
      <Icon className="h-4 w-4 shrink-0" strokeWidth={1.75} aria-hidden="true" />
      <span className={collapsed ? "sr-only" : "flex-1 truncate"}>{item.label}</span>
      {!collapsed && badge > 0 ? (
        <span className="rounded-full bg-brand px-1.5 text-[11px] font-semibold text-brand-foreground tabular-nums">
          {badge}
        </span>
      ) : null}
      {collapsed && badge > 0 ? (
        <span
          aria-hidden="true"
          className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-brand"
        />
      ) : null}
    </Link>
  );
  if (!collapsed) return link;
  return <CollapsedTooltip label={item.label}>{link}</CollapsedTooltip>;
}
