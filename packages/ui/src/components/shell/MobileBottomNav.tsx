// ui-redesign C16: mobile bottom nav (moved out of AppShell).
//
// Items: Dashboard, Inbox (with badge), Rigs, Projects, and "More"
// (opens the existing mobile tray via onMore). The nav element keeps
// `lg:hidden` on itself — the SC-1 test filters by that class.

import type { ComponentType } from "react";
import { Link } from "@tanstack/react-router";
import { FolderKanban, Inbox, LayoutDashboard, Menu, Network } from "lucide-react";
import { cn } from "../../lib/utils.js";
import { useAttentionItems } from "../../hooks/useAttentionItems.js";
import { useFeedSubscriptions } from "../../hooks/useFeedSubscriptions.js";

export interface MobileBottomNavProps {
  pathname: string;
  onMore: () => void;
}

interface BottomNavSlot {
  id: "dashboard" | "for-you" | "topology" | "project";
  label: string;
  to: string;
  activeWhen: (p: string) => boolean;
  icon: ComponentType<{ className?: string; strokeWidth?: number | string }>;
  testId: string; // preserved V1 mobile-nav-* testids (rule: keep existing testids)
}

const SLOTS: BottomNavSlot[] = [
  { id: "dashboard", label: "Dashboard", to: "/", activeWhen: (p) => p === "/", icon: LayoutDashboard, testId: "mobile-nav-dashboard" },
  { id: "for-you", label: "Inbox", to: "/for-you", activeWhen: (p) => p.startsWith("/for-you"), icon: Inbox, testId: "mobile-nav-for-you" },
  { id: "topology", label: "Rigs", to: "/topology", activeWhen: (p) => p.startsWith("/topology") || p.startsWith("/rigs/"), icon: Network, testId: "mobile-nav-topology" },
  { id: "project", label: "Projects", to: "/project", activeWhen: (p) => p.startsWith("/project"), icon: FolderKanban, testId: "mobile-nav-project" },
];

export function MobileBottomNav({ pathname, onMore }: MobileBottomNavProps) {
  const subs = useFeedSubscriptions();
  const attentionQuery = useAttentionItems(50, subs.anyRemoteEnabled);
  const inboxBadge = attentionQuery.data?.items.length ?? 0;
  return (
    <nav
      data-testid="mobile-bottom-nav"
      aria-label="Mobile bottom navigation"
      className="fixed bottom-0 left-0 right-0 z-40 lg:hidden bg-background border-t border-outline-variant pb-[env(safe-area-inset-bottom)] flex"
    >
      {SLOTS.map((slot) => {
        const active = slot.activeWhen(pathname);
        return (
          <Link
            key={slot.id}
            to={slot.to}
            data-testid={slot.testId}
            data-active={active}
            className={cn(
              "relative flex-1 flex flex-col items-center justify-center gap-0.5 h-14 text-[11px]",
              active
                ? "text-on-surface"
                : "text-on-surface-variant hover:text-on-surface",
            )}
          >
            <slot.icon className="h-5 w-5" strokeWidth={1.75} aria-hidden="true" />
            <span>{slot.label}</span>
            {slot.id === "for-you" && inboxBadge > 0 ? (
              <span
                data-testid="mobile-nav-inbox-badge"
                className="absolute right-1/2 top-1 translate-x-4 rounded-full bg-brand px-1.5 text-[11px] font-semibold text-brand-foreground tabular-nums"
              >
                {inboxBadge}
              </span>
            ) : null}
          </Link>
        );
      })}
      <button
        type="button"
        data-testid="mobile-nav-more"
        aria-label="More navigation options"
        onClick={onMore}
        className="flex-1 flex flex-col items-center justify-center gap-0.5 h-14 text-[11px] text-on-surface-variant hover:text-on-surface"
      >
        <Menu className="h-5 w-5" strokeWidth={1.75} aria-hidden="true" />
        <span>More</span>
      </button>
    </nav>
  );
}
