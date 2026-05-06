// V1 attempt-3 Phase 3 — Dashboard surface per dashboard.md.
//
// Mounted at `/` route. Header + 6-card grid + recent activity.

import { DashboardHeader } from "./DashboardHeader.js";
import { CardGrid } from "./CardGrid.js";
import { RecentActivity } from "./RecentActivity.js";

export function Dashboard() {
  return (
    <div
      data-testid="dashboard-surface"
      className="mx-auto w-full max-w-[960px] px-6 py-8"
    >
      <DashboardHeader />
      <CardGrid />
      <RecentActivity />
    </div>
  );
}
