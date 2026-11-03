// ui-redesign C06: labeled sidebar shell (replaces the icon rail).

import { Link } from "@tanstack/react-router";
import { PanelLeftClose, PanelLeftOpen, Plus, Search } from "lucide-react";
import { cn } from "../../lib/utils.js";
import { NAV_CHAT, NAV_FOOTER, NAV_SECTIONS, type NavItem } from "../../lib/nav.js";
import { readSettingString, resolveChatTo } from "../../lib/chat-targets.js";
import { useSettings } from "../../hooks/useSettings.js";
import { useAttentionItems } from "../../hooks/useAttentionItems.js";
import { useFeedSubscriptions } from "../../hooks/useFeedSubscriptions.js";
import { Button } from "../ui/button.js";
import { Kbd } from "../ui/kbd.js";
import { SidebarNavItem, CollapsedTooltip } from "./SidebarNavItem.js";
import { SidebarSection } from "./SidebarSection.js";
import { SidebarRigList } from "./SidebarRigList.js";

export interface SidebarProps {
  pathname: string;
  onMobileClose?: () => void;
  vertical?: boolean;
  collapsed: boolean;
  onToggleCollapsed?: () => void;
  isMobileTray?: boolean;
}

function NewRigButton({ collapsed }: { collapsed: boolean }) {
  const button = (
    <Button asChild data-testid="sidebar-new-rig" className={cn(collapsed && "px-0 w-11 lg:w-9")}>
      <Link to="/specs/rig" aria-label="New rig">
        <Plus className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
        <span className={collapsed ? "sr-only" : undefined}>New rig</span>
      </Link>
    </Button>
  );
  if (!collapsed) return button;
  return <CollapsedTooltip label="New rig">{button}</CollapsedTooltip>;
}

function SearchButton({ collapsed }: { collapsed: boolean }) {
  const openPalette = () => {
    window.dispatchEvent(new CustomEvent("openrig:open-palette"));
  };
  const button = (
    <button
      type="button"
      data-testid="sidebar-search"
      aria-label="Search"
      onClick={openPalette}
      className={cn(
        "flex h-11 lg:h-9 items-center rounded-md text-sm font-medium text-on-surface-variant transition-colors hover:bg-surface-low hover:text-on-surface",
        collapsed ? "justify-center px-0 w-11 lg:w-9" : "gap-3 px-3",
      )}
    >
      <Search className="h-4 w-4 shrink-0" strokeWidth={1.75} aria-hidden="true" />
      <span className={collapsed ? "sr-only" : "flex-1 text-left"}>Search</span>
      {!collapsed ? <Kbd>⌘K</Kbd> : null}
    </button>
  );
  if (!collapsed) return button;
  return <CollapsedTooltip label="Search">{button}</CollapsedTooltip>;
}

export function Sidebar({
  pathname,
  onMobileClose,
  vertical: _vertical,
  collapsed,
  onToggleCollapsed,
  isMobileTray,
}: SidebarProps) {
  void _vertical;
  const effectiveCollapsed = isMobileTray ? false : collapsed;
  const { data: settingsData } = useSettings();
  const subs = useFeedSubscriptions();
  const attentionQuery = useAttentionItems(50, subs.anyRemoteEnabled);
  const inboxBadge = attentionQuery.data?.items.length ?? 0;

  const renderItem = (item: NavItem & { activeWhen: (p: string) => boolean }, badge = 0) => (
    <div key={item.id}>
      <SidebarNavItem
        item={item}
        pathname={pathname}
        collapsed={effectiveCollapsed}
        badge={badge}
        onNavigate={onMobileClose}
      />
      {item.id === "rigs" ? <SidebarRigList collapsed={effectiveCollapsed} /> : null}
    </div>
  );

  return (
    <nav
      data-testid="app-rail"
      aria-label="Primary navigation"
      data-collapsed={effectiveCollapsed}
      style={isMobileTray ? undefined : { width: effectiveCollapsed ? "var(--sidebar-width-collapsed)" : "var(--sidebar-width)" }}
      className={cn(
        "flex flex-col bg-surface-low border-r",
        // In the mobile tray the sidebar fills the tray and its link list
        // scrolls inside it; on desktop it keeps its fixed column width.
        isMobileTray ? "w-full min-h-0 flex-1" : "shrink-0",
      )}
    >
      {/* Header row: desktop wordmark (C07) + collapse toggle on desktop only. */}
      <div className={cn("hidden lg:flex items-center", effectiveCollapsed ? "justify-center px-0 py-2" : "justify-between px-3 py-2")}>
        {effectiveCollapsed ? null : (
          <Link
            to="/"
            data-testid="brand-home-link"
            className="text-sm font-semibold text-on-surface"
          >
            OpenRig
          </Link>
        )}
        <button
          type="button"
          data-testid="sidebar-toggle"
          aria-label={effectiveCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          onClick={onToggleCollapsed}
          className="flex h-8 w-8 items-center justify-center rounded-md text-on-surface-variant hover:bg-surface-low hover:text-on-surface"
        >
          {effectiveCollapsed ? (
            <PanelLeftOpen className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
          ) : (
            <PanelLeftClose className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
          )}
        </button>
      </div>

      {/* Primary action + search */}
      <div className={cn("flex flex-col gap-1", effectiveCollapsed ? "items-center px-0" : "px-2", isMobileTray && "pt-2")}>
        <NewRigButton collapsed={effectiveCollapsed} />
        <SearchButton collapsed={effectiveCollapsed} />
      </div>

      {/* Nav sections */}
      <div className="flex-1 overflow-y-auto scrollbar-none px-2 py-1">
        {NAV_SECTIONS.map((section) => (
          <SidebarSection
            key={section.id}
            id={section.id}
            label={section.label}
            collapsed={effectiveCollapsed}
          >
            {section.items.map((item) => renderItem(item, item.id === "inbox" ? inboxBadge : 0))}
          </SidebarSection>
        ))}

        <div className="flex-1" />

        {/* Chat group */}
        <SidebarSection id="chat" label="Chat" collapsed={effectiveCollapsed}>
          {NAV_CHAT.map((c) =>
            renderItem({
              ...c,
              to: resolveChatTo(readSettingString(settingsData, `agents.${c.role}_session`), c.role),
              activeWhen: () => false,
            }),
          )}
        </SidebarSection>

        {/* Footer */}
        <SidebarSection id="footer" label={null} collapsed={effectiveCollapsed}>
          {NAV_FOOTER.map((item) => renderItem(item))}
        </SidebarSection>
      </div>
    </nav>
  );
}
