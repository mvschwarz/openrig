// PL-005 Phase A: my-queue view (operator's human-gate queue).
// Combines HumanSeatCard (first-class human seat per founder Q3) with
// the operator's pending human-gate items + verb actions.

import { HumanSeatCard } from "../components/HumanSeatCard.js";
import { useMissionControlView } from "../hooks/useMissionControlView.js";
import { GenericListView } from "./GenericListView.js";

export interface MyQueueViewProps {
  operatorSession?: string;
}

export function MyQueueView({
  operatorSession = "human-wrandom@kernel",
}: MyQueueViewProps) {
  const query = useMissionControlView("my-queue", { operatorSession });
  return (
    <div data-testid="mc-view-my-queue-container" className="space-y-3 p-3">
      <HumanSeatCard session={operatorSession} rows={query.data?.rows ?? []} />
      <GenericListView
        viewName="my-queue"
        operatorSession={operatorSession}
        title="My queue"
        subtitle="Decisions that need me, ordered by read-cost"
        emptyMessage="No human-gated items waiting on you."
        withVerbActions
      />
    </div>
  );
}
