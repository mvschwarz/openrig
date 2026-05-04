// Preview Terminal v0 (PL-018) — stacked pinned-preview panel.
//
// Renders all currently pinned preview panes. Composes with the
// existing topology + slice surfaces — operator pins from the
// node-detail drawer / loop-state row / topology tab, and the stack
// surfaces them globally in one always-visible side rail.

import { PreviewPane } from "./PreviewPane.js";
import { usePreviewPins } from "./usePreviewPins.js";

export function PreviewStack({ testIdPrefix = "preview-stack" }: { testIdPrefix?: string }) {
  const { pins } = usePreviewPins();

  if (pins.length === 0) return null;

  return (
    <aside
      data-testid={testIdPrefix}
      className="absolute inset-y-0 right-0 z-10 w-72 border-l border-stone-300/25 bg-[rgba(250,249,245,0.04)] supports-[backdrop-filter]:bg-[rgba(250,249,245,0.02)] backdrop-blur-[12px] shadow-[-6px_0_14px_rgba(46,52,46,0.04)] flex flex-col overflow-y-auto pointer-events-auto"
    >
      <header className="px-3 py-2 border-b border-stone-300/35 shrink-0">
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-stone-700">
          Pinned previews
        </span>
        <span className="ml-2 font-mono text-[9px] text-stone-500">
          {pins.length} pinned
        </span>
      </header>
      <div className="flex-1 px-2 py-2 space-y-2">
        {pins.map((p) => (
          <PreviewPane
            key={`${p.rigId}:${p.logicalId}`}
            rigId={p.rigId}
            rigName={p.rigName}
            logicalId={p.logicalId}
            compact
            testIdPrefix={`pinned-preview-${p.logicalId}`}
          />
        ))}
      </div>
    </aside>
  );
}
