// Slice Story View v0 — Docs tab.
//
// Two-column layout: left = file tree (slice folder + descendants),
// right = lazy markdown viewer for the selected file. Composable with
// PL-009 Markdown Viewer when that ships; until then v0 renders the
// markdown content as plain `<pre>` so the operator at least sees the
// canonical text + can copy citations into queue messages.

import { useState } from "react";
import type { DocsTreeEntry } from "../../../hooks/useSlices.js";
import { useSliceDoc } from "../../../hooks/useSlices.js";

export function DocsTab({ sliceName, tree }: { sliceName: string; tree: DocsTreeEntry[] }) {
  const initial = tree.find((e) => e.type === "file" && e.name === "README.md")?.relPath
    ?? tree.find((e) => e.type === "file" && e.name === "IMPLEMENTATION-PRD.md")?.relPath
    ?? tree.find((e) => e.type === "file")?.relPath
    ?? null;
  const [selected, setSelected] = useState<string | null>(initial);
  const doc = useSliceDoc(sliceName, selected);

  return (
    <div data-testid="docs-tab" className="flex h-full">
      <aside className="w-56 shrink-0 overflow-y-auto border-r border-stone-200 bg-stone-50 p-2" data-testid="docs-tree">
        {tree.length === 0 && (
          <div className="font-mono text-[10px] text-stone-400">Empty slice folder.</div>
        )}
        {tree.map((entry) => (
          <button
            key={entry.relPath}
            type="button"
            data-testid={`docs-tree-${entry.relPath}`}
            data-selected={entry.relPath === selected}
            disabled={entry.type === "dir"}
            onClick={() => entry.type === "file" && setSelected(entry.relPath)}
            className={`block w-full text-left font-mono text-[10px] ${
              entry.type === "dir"
                ? "py-1 text-stone-400"
                : `cursor-pointer py-1 hover:bg-stone-100 ${entry.relPath === selected ? "bg-stone-200/80 text-stone-900" : "text-stone-700"}`
            }`}
            style={{ paddingLeft: `${(entry.relPath.split("/").length - 1) * 0.75 + 0.25}rem` }}
          >
            {entry.type === "dir" ? `▸ ${entry.name}` : entry.name}
          </button>
        ))}
      </aside>
      <main className="flex-1 min-w-0 overflow-y-auto bg-white" data-testid="docs-viewer">
        {!selected && (
          <div className="m-auto p-4 font-mono text-[10px] text-stone-400">Select a file from the tree</div>
        )}
        {selected && doc.isLoading && (
          <div className="p-4 font-mono text-[10px] text-stone-400">Loading…</div>
        )}
        {selected && doc.isError && (
          <div className="p-4 font-mono text-[10px] text-red-600">Error loading doc.</div>
        )}
        {selected && doc.data && (
          <pre className="whitespace-pre-wrap break-words p-4 font-mono text-[11px] text-stone-800" data-testid="docs-viewer-content">
            {doc.data.content}
          </pre>
        )}
      </main>
    </div>
  );
}
