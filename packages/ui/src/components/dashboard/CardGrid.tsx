// V1 attempt-3 Phase 3 — Dashboard 6-card grid per dashboard.md L100–L102 + SC-12.
//
// 3×2 desktop, 2×3 tablet, 1×6 mobile.

import { TopologyCard } from "./cards/TopologyCard.js";
import { ProjectCard } from "./cards/ProjectCard.js";
import { ForYouCard } from "./cards/ForYouCard.js";
import { SpecsCard } from "./cards/SpecsCard.js";
import { SearchCard } from "./cards/SearchCard.js";
import { SettingsCard } from "./cards/SettingsCard.js";

export function CardGrid() {
  return (
    <div
      data-testid="dashboard-card-grid"
      className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3"
    >
      <TopologyCard />
      <ProjectCard />
      <ForYouCard />
      <SpecsCard />
      <SearchCard />
      <SettingsCard />
    </div>
  );
}
