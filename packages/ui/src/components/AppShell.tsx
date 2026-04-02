import { type ReactNode, useState, createContext, useContext } from "react";
import { useRouterState } from "@tanstack/react-router";
import { Settings2 } from "lucide-react";
import { Explorer } from "./Explorer.js";
import { SharedDetailDrawer, type DrawerSelection } from "./SharedDetailDrawer.js";
import { useActivityFeed } from "../hooks/useActivityFeed.js";
import { useGlobalEvents } from "../hooks/useGlobalEvents.js";

// -- Shared drawer selection context --

interface DrawerSelectionContextValue {
  selection: DrawerSelection;
  setSelection: (sel: DrawerSelection) => void;
}

interface ExplorerVisibilityContextValue {
  openExplorer: () => void;
}

export const DrawerSelectionContext = createContext<DrawerSelectionContextValue>({
  selection: null,
  setSelection: () => {},
});

export const ExplorerVisibilityContext = createContext<ExplorerVisibilityContextValue>({
  openExplorer: () => {},
});

export function useDrawerSelection() {
  return useContext(DrawerSelectionContext);
}

export function useExplorerVisibility() {
  return useContext(ExplorerVisibilityContext);
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
  const [desktopExplorerOpen, setDesktopExplorerOpen] = useState(true);
  const { events } = useActivityFeed();
  const [selection, setSelection] = useState<DrawerSelection>(null);
  const openExplorer = () => {
    setDesktopExplorerOpen(true);
    setSidebarOpen(true);
  };

  // Mount global SSE event listener
  useGlobalEvents();

  return (
    <DrawerSelectionContext.Provider value={{ selection, setSelection }}>
      <ExplorerVisibilityContext.Provider value={{ openExplorer }}>
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

          <div className="flex-1" />

          <button
            type="button"
            data-testid="system-toggle"
            onClick={() => setSelection(selection?.type === "system" ? null : { type: "system", tab: "log" })}
            className={`inline-flex h-8 w-8 items-center justify-center rounded-md border transition-colors ${
              selection?.type === "system"
                ? "border-stone-900 bg-stone-900 text-white"
                : "border-stone-300 bg-white/70 text-stone-700 hover:bg-stone-100"
            }`}
            aria-label={selection?.type === "system" ? "Close system drawer" : "Open system drawer"}
            title={selection?.type === "system" ? "Close system drawer" : "Open system drawer"}
          >
            <Settings2 className="h-4 w-4" />
          </button>
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
            desktopMode={desktopExplorerOpen ? "full" : "hidden"}
            onDesktopToggle={() => setDesktopExplorerOpen((open) => !open)}
          />

          <main data-testid="content-area" className="flex-1 flex flex-col overflow-auto relative">
            <div key={pathname} className="relative z-10 route-enter flex-1 flex flex-col">{children}</div>
          </main>

          {/* Detail drawer — visible when a rig or node is selected */}
          <SharedDetailDrawer
            selection={selection}
            onClose={() => setSelection(null)}
            events={events}
          />
        </div>
      </div>
      </ExplorerVisibilityContext.Provider>
    </DrawerSelectionContext.Provider>
  );
}
