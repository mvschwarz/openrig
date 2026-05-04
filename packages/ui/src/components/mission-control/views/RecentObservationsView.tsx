import { GenericListView } from "./GenericListView.js";

export function RecentObservationsView({ highlightedQitemId }: { highlightedQitemId?: string | null }) {
  return (
    <GenericListView
      viewName="recent-observations"
      title="Recent observations"
      subtitle="Recent stream observations relevant to operator attention"
      emptyMessage="No recent observations."
      highlightedQitemId={highlightedQitemId}
    />
  );
}
