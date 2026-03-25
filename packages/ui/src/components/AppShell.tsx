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
      {/* Header */}
      <header
        data-testid="app-header"
        className="h-14 flex items-center px-spacing-6 bg-background border-b border-ghost-border shrink-0"
      >
        <h1 className="text-headline-lg uppercase tracking-[0.05em] text-foreground font-inter">
          RIGGED
        </h1>
      </header>

      {/* Main: Sidebar + Content */}
      <div className="flex flex-1 min-h-0">
        <Sidebar />
        <main data-testid="content-area" className="flex-1 overflow-auto bg-background relative">
          <div className="bg-grid absolute inset-0 pointer-events-none z-0" />
          <div key={pathname} className="relative z-10 route-enter">{children}</div>
        </main>
      </div>

      {/* Status Bar */}
      <StatusBar />
    </div>
  );
}
