// Operator Surface Reconciliation v0 — Priority Stack panel.
//
// Item 1A: verbatim render of STEERING.md content. Uses the v0
// MarkdownViewer so the operator sees the same rendering surface
// they'd see in /files. Last-modified timestamp on the header
// surfaces freshness at a glance.

import type { PriorityStackPayload } from "../../hooks/useSteering.js";
import { MarkdownViewer } from "../markdown/MarkdownViewer.js";

export function PriorityStackPanel({ priorityStack }: { priorityStack: PriorityStackPayload | null }) {
  if (!priorityStack) {
    return (
      <section
        data-testid="steering-priority-stack-empty"
        className="border border-stone-200 bg-stone-50 p-3 font-mono text-[10px] text-stone-500"
      >
        Priority stack source unavailable. Configure OPENRIG_STEERING_PATH or OPENRIG_STEERING_WORKSPACE.
      </section>
    );
  }
  return (
    <section
      data-testid="steering-priority-stack"
      className="border-2 border-stone-900 bg-white"
    >
      <header className="flex items-baseline justify-between border-b border-stone-300 bg-stone-100 px-3 py-2">
        <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-stone-700">
          Priority stack — the constraint frame
        </div>
        <div className="font-mono text-[9px] text-stone-500" data-testid="steering-priority-stack-mtime">
          last modified {priorityStack.mtime}
        </div>
      </header>
      <div className="max-h-[60vh] overflow-y-auto p-4">
        <MarkdownViewer content={priorityStack.content} hideRawToggle />
      </div>
    </section>
  );
}
