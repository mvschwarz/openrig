import { type ReactNode, useState, createContext, useContext } from "react";
import { useRouterState } from "@tanstack/react-router";
import { Explorer } from "./Explorer.js";
import { SharedDetailDrawer, type DrawerSelection } from "./SharedDetailDrawer.js";
import { StatusBar } from "./StatusBar.js";
import { ActivityFeed } from "./ActivityFeed.js";
import { useActivityFeed } from "../hooks/useActivityFeed.js";
import { useGlobalEvents } from "../hooks/useGlobalEvents.js";

// -- Shared drawer selection context --

interface DrawerSelectionContextValue {
  selection: DrawerSelection;
  setSelection: (sel: DrawerSelection) => void;
}

export const DrawerSelectionContext = createContext<DrawerSelectionContextValue>({
  selection: null,
  setSelection: () => {},
});

export function useDrawerSelection() {
  return useContext(DrawerSelectionContext);
}

// Backward-compat alias for consumers that still use the old name
export const NodeSelectionContext = DrawerSelectionContext;
export function useNodeSelection() {
  const { selection, setSelection } = useDrawerSelection();
  return {
    selectedNode: selection?.type === "node" ? { rigId: selection.rigId, logicalId: selection.logicalId } : null,
    setSelectedNode: (node: { rigId: string; logicalId: string } | null) =>
      setSelection(node ? { type: "node", rigId: node.rigId, logicalId: node.logicalId } : null),
  };
}

// -- AppShell --

interface AppShellProps {
  children: ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  const routerState = useRouterState();
  const pathname = routerState.location.pathname;
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const { events, feedOpen, setFeedOpen } = useActivityFeed();
  const [selection, setSelection] = useState<DrawerSelection>(null);

  // Mount global SSE event listener
  useGlobalEvents();

  return (
    <DrawerSelectionContext.Provider value={{ selection, setSelection }}>
      <div className="h-screen flex flex-col">
        {/* Header — paper with thick bottom border */}
        <header
          data-testid="app-header"
          className="h-14 flex items-center justify-between px-spacing-6 bg-background border-b-2 border-stone-900 shrink-0 relative z-30"
        >
          <div className="flex items-center gap-spacing-4">
            {/* Hamburger — narrow viewports only */}
            <button
              data-testid="sidebar-toggle"
              onClick={() => setSidebarOpen(!sidebarOpen)}
              className="flex flex-col gap-[3px] p-1 lg:hidden"
              aria-label="Toggle navigation"
            >
              <span className="block w-4 h-[1.5px] bg-stone-900" />
              <span className="block w-4 h-[1.5px] bg-stone-900" />
              <span className="block w-3 h-[1.5px] bg-stone-900" />
            </button>

            {/* Case ID block */}
            <div className="font-mono text-base font-bold tracking-tighter text-stone-900 border-x border-stone-300 px-3 py-0.5">
              RIGGED
            </div>
          </div>

          {/* Center nav — hidden on narrow */}
          <nav className="hidden md:flex gap-spacing-8">
            {[
              { path: "/", label: "RIGS" },
              { path: "/packages", label: "SPECS" },
              { path: "/discovery", label: "DISCOVERY" },
            ].map((item) => {
              const isActive = item.path === "/"
                ? pathname === "/" || pathname.startsWith("/rigs")
                : pathname.startsWith(item.path);
              return (
                <a
                  key={item.path}
                  href={item.path}
                  className={`font-headline tracking-tight uppercase text-sm font-bold transition-colors ${
                    isActive
                      ? "text-stone-900 border-b-2 border-stone-900 pb-0.5"
                      : "text-stone-500 hover:bg-stone-200"
                  }`}
                >
                  {item.label}
                </a>
              );
            })}
          </nav>

          {/* Right side — icons */}
          <div className="flex items-center gap-spacing-2">
            <button
              onClick={() => setFeedOpen(!feedOpen)}
              className="p-2 hover:bg-stone-200 transition-colors font-mono text-xs text-stone-500"
              aria-label="Activity"
            >
              {events.length > 0 ? `${events.length}` : ""}
            </button>
          </div>
        </header>

        {/* Main: Explorer + Content + Detail Panel */}
        <div className="flex flex-1 min-h-0 relative">
          {/* Explorer overlay backdrop for mobile */}
          {sidebarOpen && (
            <div
              className="fixed inset-0 bg-black/20 z-20 lg:hidden"
              onClick={() => setSidebarOpen(false)}
            />
          )}

          <Explorer
            open={sidebarOpen}
            onClose={() => setSidebarOpen(false)}
            selection={selection}
            onSelect={setSelection}
          />

          <main data-testid="content-area" className="flex-1 flex flex-col overflow-auto relative">
            <div key={pathname} className="relative z-10 route-enter flex-1 flex flex-col">{children}</div>
          </main>

          {/* Detail drawer — visible when a rig or node is selected */}
          <SharedDetailDrawer
            selection={selection}
            onClose={() => setSelection(null)}
          />
        </div>

        {/* Activity Feed */}
        <ActivityFeed events={events} open={feedOpen} onClose={() => setFeedOpen(false)} />

        {/* Status Bar */}
        <StatusBar onToggleFeed={() => setFeedOpen(!feedOpen)} feedOpen={feedOpen} eventCount={events.length} />
      </div>
    </DrawerSelectionContext.Provider>
  );
}
