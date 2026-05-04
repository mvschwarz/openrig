import { GenericListView } from "./GenericListView.js";

export function ActiveWorkView({ highlightedQitemId }: { highlightedQitemId?: string | null }) {
  return (
    <GenericListView
      viewName="active-work"
      title="Active work"
      subtitle="Pending / in-progress / blocked, priority-first"
      emptyMessage="No active work in flight."
      withVerbActions
      highlightedQitemId={highlightedQitemId}
    />
  );
}
