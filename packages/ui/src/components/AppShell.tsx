import type { ReactNode } from "react";
import { useRouterState } from "@tanstack/react-router";
import { Sidebar } from "./Sidebar.js";
import { StatusBar } from "./StatusBar.js";

interface AppShellProps {
  children: ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  const routerState = useRouterState();
  const pathname = routerState.location.pathname;

  return (
    <div className="h-screen flex flex-col bg-background text-foreground">
      {/* Header — machined top bar with brand presence */}
      <header
        data-testid="app-header"
        className="h-14 flex items-center justify-between px-spacing-6 bg-background shrink-0 relative"
      >
        <div className="flex items-center gap-spacing-3">
          {/* Brand mark */}
          <div className="flex items-center gap-spacing-2">
            <div className="w-2 h-2 bg-primary" />
            <h1 className="text-headline-lg uppercase tracking-[0.08em] text-foreground font-inter">
              RIGGED
            </h1>
          </div>
          <span className="text-label-sm text-foreground-muted font-grotesk tracking-[0.06em] opacity-50 ml-spacing-2">
            CONTROL PLANE
          </span>
        </div>

        {/* Version/status indicator in header */}
        <div className="text-label-sm font-mono text-foreground-muted opacity-40">
          v0.1.0
        </div>

        {/* Bottom edge — ghost border replacement with gradient fade */}
        <div className="absolute bottom-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-ghost-border to-transparent" />
      </header>

      {/* Main: Sidebar + Content */}
      <div className="flex flex-1 min-h-0">
        <Sidebar />
        <main data-testid="content-area" className="flex-1 overflow-auto bg-background relative">
          {/* Atmospheric dot grid */}
          <div className="bg-grid absolute inset-0 pointer-events-none z-0" />
          {/* Subtle dither grain */}
          <div className="bg-dither absolute inset-0 pointer-events-none z-0" />
          <div key={pathname} className="relative z-10 route-enter">{children}</div>
        </main>
      </div>

      {/* Status Bar */}
      <StatusBar />
    </div>
  );
}
