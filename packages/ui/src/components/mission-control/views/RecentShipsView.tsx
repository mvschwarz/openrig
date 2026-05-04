// PL-005 Phase A: recent ships view (last 10 done items per founder Q4).
import { GenericListView } from "./GenericListView.js";

export function RecentShipsView() {
  return (
    <GenericListView
      viewName="recent-ships"
      title="Recent ships"
      subtitle="Last 10 done / handed-off items with closure reason"
      emptyMessage="Nothing shipped recently."
    />
  );
}
