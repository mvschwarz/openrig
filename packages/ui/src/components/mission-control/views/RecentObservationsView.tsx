import { GenericListView } from "./GenericListView.js";

export function RecentObservationsView() {
  return (
    <GenericListView
      viewName="recent-observations"
      title="Recent observations"
      subtitle="Recent stream observations relevant to operator attention"
      emptyMessage="No recent observations."
    />
  );
}
