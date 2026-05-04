// PL-005 Phase A: cross-fleet human-gate view.
import { GenericListView } from "./GenericListView.js";

export function HumanGateView() {
  return (
    <GenericListView
      viewName="human-gate"
      title="Human gate"
      subtitle="Cross-fleet items waiting on a human decision"
      emptyMessage="No human-gated items across the fleet."
      withVerbActions
    />
  );
}
