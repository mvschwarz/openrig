import { type ReactNode, useState } from "react";
import { useRouterState } from "@tanstack/react-router";
import { Sidebar } from "./Sidebar.js";
import { StatusBar } from "./StatusBar.js";
import { ActivityFeed } from "./ActivityFeed.js";
import { useActivityFeed } from "../hooks/useActivityFeed.js";

interface AppShellProps {
  children: ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  const routerState = useRouterState();
  const pathname = routerState.location.pathname;
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const { events, feedOpen, setFeedOpen } = useActivityFeed();

  return (
    <div className="h-screen flex flex-col">
      {/* Header — dark chrome bar */}
      <header
        data-testid="app-header"
        className="h-12 flex items-center justify-between px-spacing-4 bg-surface-dark text-foreground-on-dark shrink-0 relative z-30"
      >
        <div className="flex items-center gap-spacing-3">
          {/* Hamburger — visible on narrow viewports, or always as toggle */}
          <button
            data-testid="sidebar-toggle"
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="flex flex-col gap-[3px] p-1 lg:hidden"
            aria-label="Toggle navigation"
          >
            <span className="block w-4 h-[1.5px] bg-foreground-on-dark" />
            <span className="block w-4 h-[1.5px] bg-foreground-on-dark" />
            <span className="block w-3 h-[1.5px] bg-foreground-on-dark" />
          </button>

          <h1 className="text-label-lg uppercase tracking-[0.08em] font-inter font-bold">
            RIGGED
          </h1>
        </div>

        <span className="text-label-sm font-mono text-foreground-muted-on-dark">
          v0.1.0
        </span>
      </header>

      {/* Main: Sidebar + Content */}
      <div className="flex flex-1 min-h-0 relative">
        {/* Sidebar overlay backdrop for mobile */}
        {sidebarOpen && (
          <div
            className="fixed inset-0 bg-black/30 z-20 lg:hidden"
            onClick={() => setSidebarOpen(false)}
          />
        )}

        <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />

        <main data-testid="content-area" className="flex-1 overflow-auto bg-background relative">
          {/* Subtle dither grain texture on canvas */}
          <div className="bg-dither absolute inset-0 pointer-events-none z-0" />
          <div key={pathname} className="relative z-10 route-enter">{children}</div>
        </main>
      </div>

      {/* Activity Feed */}
      <ActivityFeed events={events} open={feedOpen} onClose={() => setFeedOpen(false)} />

      {/* Status Bar */}
      <StatusBar onToggleFeed={() => setFeedOpen(!feedOpen)} feedOpen={feedOpen} eventCount={events.length} />
    </div>
  );
}
