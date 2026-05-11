// Slice Story View v0 + UI Enhancement Pack v0 — Docs tab.
//
// Two-column layout: left = file tree (slice folder + descendants),
// right = lazy markdown viewer for the selected file.
//
// UI Enhancement Pack v0 item 2: the right pane now renders Markdown
// via the new MarkdownViewer (YAML frontmatter as metadata header,
// code blocks with syntax highlighting, lists, tables, links,
// images, mermaid placeholder per carve-out). v0's plain-`<pre>`
// fallback is preserved for non-`.md` files.
//
// Image src resolution: relative paths in `.md` content are resolved
// against the slice's proof-asset endpoint when applicable. v1 of
// UI Enhancement Pack can extend this to the slice's docs endpoint
// once the daemon adds an analogous static-asset path for slice docs.

import { useState } from "react";
import type { DocsTreeEntry } from "../../../hooks/useSlices.js";
import { useSliceDoc } from "../../../hooks/useSlices.js";
import { MarkdownViewer } from "../../markdown/MarkdownViewer.js";
import { ToolMark } from "../../graphics/RuntimeMark.js";

export function DocsTab({ sliceName, tree }: { sliceName: string; tree: DocsTreeEntry[] }) {
  const initial = tree.find((e) => e.type === "file" && e.name === "README.md")?.relPath
    ?? tree.find((e) => e.type === "file" && e.name === "IMPLEMENTATION-PRD.md")?.relPath
    ?? tree.find((e) => e.type === "file")?.relPath
    ?? null;
  const [selected, setSelected] = useState<string | null>(initial);
  const doc = useSliceDoc(sliceName, selected);

  return (
    <div data-testid="docs-tab" className="flex h-full flex-col sm:flex-row">
      <aside className="w-full max-h-48 shrink-0 overflow-y-auto border-b border-stone-200 bg-stone-50 p-2 sm:w-56 sm:max-h-none sm:border-b-0 sm:border-r" data-testid="docs-tree">
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
            <span className="inline-flex min-w-0 items-center gap-1.5">
              {entry.type === "dir" ? (
                <ToolMark tool="folder" size="xs" decorative />
              ) : (
                <ToolMark tool={entry.name} size="xs" decorative />
              )}
              <span className="truncate">{entry.name}</span>
            </span>
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
          <div data-testid="docs-viewer-content" className="p-4">
            {selected.toLowerCase().endsWith(".md") ? (
              <MarkdownViewer content={doc.data.content} />
            ) : (
              <pre className="whitespace-pre-wrap break-words font-mono text-[11px] text-stone-800">
                {doc.data.content}
              </pre>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
