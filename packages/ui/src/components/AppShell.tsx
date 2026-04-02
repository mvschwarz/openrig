import { type ReactNode, useState, createContext, useContext } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { Cog } from "lucide-react";
import { Explorer } from "./Explorer.js";
import { SharedDetailDrawer, type DrawerSelection } from "./SharedDetailDrawer.js";
import { useActivityFeed } from "../hooks/useActivityFeed.js";
import { useGlobalEvents } from "../hooks/useGlobalEvents.js";
import { useRigSummary } from "../hooks/useRigSummary.js";
import { shortId } from "../lib/display-id.js";

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

function parseCurrentRigId(pathname: string): string | null {
  const match = pathname.match(/^\/rigs\/([^/]+)/);
  return match?.[1] ?? null;
}

function resolveSurfaceTitle(pathname: string, rigId: string | null, rigName: string | null): string | null {
  if (pathname === "/") return null;
  if (rigId) return rigName ?? shortId(rigId, 8);
  if (pathname.startsWith("/packages") || pathname === "/import" || pathname === "/bootstrap") return "Specs";
  if (pathname.startsWith("/discovery")) return "Discovery";
  if (pathname.startsWith("/bundles/inspect")) return "Bundle Inspector";
  if (pathname.startsWith("/bundles/install")) return "Bundle Install";
  return null;
}

export function AppShell({ children }: AppShellProps) {
  const routerState = useRouterState();
  const pathname = routerState.location.pathname;
  const currentRigId = parseCurrentRigId(pathname);
  const { data: rigs } = useRigSummary();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [desktopExplorerOpen, setDesktopExplorerOpen] = useState(true);
  const { events } = useActivityFeed();
  const [selection, setSelection] = useState<DrawerSelection>(null);
  const currentRigName = currentRigId ? (rigs?.find((rig) => rig.id === currentRigId)?.name ?? null) : null;
  const surfaceTitle = resolveSurfaceTitle(pathname, currentRigId, currentRigName);
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
          {surfaceTitle && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-28">
              <div
                data-testid="header-surface-title"
                className="truncate font-mono text-sm font-semibold uppercase tracking-[0.12em] text-stone-700"
              >
                {surfaceTitle}
              </div>
            </div>
          )}

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

            <Link
              to="/"
              data-testid="brand-home-link"
              className="inline-flex items-center bg-stone-950 px-3 py-1 font-mono text-sm font-bold uppercase tracking-[0.08em] text-stone-50 transition-colors hover:bg-stone-800"
            >
              RIGGED
            </Link>
          </div>

          <div className="flex-1" />

          <button
            type="button"
            data-testid="system-toggle"
            onClick={() => setSelection(selection?.type === "system" ? null : { type: "system", tab: "log" })}
            className={`inline-flex h-8 w-8 items-center justify-center text-stone-700 transition-colors ${
              selection?.type === "system"
                ? "text-stone-950"
                : "hover:text-stone-950"
            }`}
            aria-label={selection?.type === "system" ? "Close system drawer" : "Open system drawer"}
            title={selection?.type === "system" ? "Close system drawer" : "Open system drawer"}
          >
            <Cog className="h-4 w-4" />
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
