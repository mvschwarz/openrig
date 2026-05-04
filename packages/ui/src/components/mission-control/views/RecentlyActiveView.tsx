import { GenericListView } from "./GenericListView.js";

export function RecentlyActiveView() {
  return (
    <GenericListView
      viewName="recently-active"
      title="Recently active"
      subtitle="Activity-sorted via PL-004 Phase B view-projector"
      emptyMessage="No recent activity."
    />
  );
}
