import { useDrawerSelection, useExplorerVisibility } from "./AppShell.js";

export function WorkspaceHome() {
  const { openExplorer } = useExplorerVisibility();
  const { setSelection } = useDrawerSelection();

  return (
    <div
      data-testid="workspace-home"
      className="flex h-full min-h-[420px] flex-col items-center justify-center bg-[radial-gradient(circle_at_top,rgba(245,244,240,0.85),rgba(244,242,236,0.55)_32%,rgba(243,241,236,0.22)_58%,transparent_72%)] px-8 text-center"
    >
      <div className="max-w-xl space-y-3">
        <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-stone-500">
          Explorer-Driven Workspace
        </p>
        <h1 className="font-headline text-2xl font-bold uppercase tracking-tight text-stone-900">
          Select a rig from the explorer to inspect its topology.
        </h1>
        <p className="text-sm text-stone-600">
          Use <span className="font-mono text-stone-800">Specs</span> to import a rig spec or run bootstrap,
          and use the <span className="font-mono text-stone-800">Discovery</span> drawer to place running sessions.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
          <a
            href="/mission-control"
            data-testid="workspace-open-mission-control"
            className="border border-stone-900 bg-stone-900 px-4 py-2 font-mono text-[10px] uppercase tracking-[0.14em] text-stone-50 transition-colors hover:bg-stone-800"
          >
            Mission Control
          </a>
          <button
            type="button"
            data-testid="workspace-open-explorer"
            onClick={openExplorer}
            className="border border-stone-300 px-4 py-2 font-mono text-[10px] uppercase tracking-[0.14em] text-stone-700 transition-colors hover:bg-stone-100"
          >
            Explore
          </button>
          <button
            type="button"
            data-testid="workspace-open-specs"
            onClick={() => setSelection({ type: "specs" })}
            className="border border-stone-300 px-4 py-2 font-mono text-[10px] uppercase tracking-[0.14em] text-stone-700 transition-colors hover:bg-stone-100"
          >
            Open Specs
          </button>
          <button
            type="button"
            data-testid="workspace-open-discovery"
            onClick={() => setSelection({ type: "discovery" })}
            className="border border-stone-300 px-4 py-2 font-mono text-[10px] uppercase tracking-[0.14em] text-stone-700 transition-colors hover:bg-stone-100"
          >
            Open Discovery
          </button>
        </div>
      </div>
    </div>
  );
}
