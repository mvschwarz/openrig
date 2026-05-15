// LAYER 5 — 6 destination cards, all numeral layout (iter-15 founder
// pick). Tactical schematic drafting alignment: 2 rows × 3 cols, all
// positions aligned, no stagger. All cards 28% wide × 220px tall.
// Project is the only card with the washed/inky look; the rest use
// sharp text.
//
// Column layout: Col 1 left-[5%], Col 2 left-[36%], Col 3 left-[67%]
// Row layout:    Top row top-[22%], Bottom row top-[55%]
//
// librarySize prop wires the Library card body to the live artifact
// count. Lab default keeps the static "field catalog 0.3.1" copy.

import { Network, Folder, Sparkles, FileText, Search, Cog } from "lucide-react";
import { VellumDestinationCard } from "./VellumDestinationCard.js";
import {
  TreeGraphic,
  StratigraphicGraphic,
  PulseGraphic,
  SphereGraphic,
  MagnifierGraphic,
  GearGraphic,
} from "./graphics.js";

interface DestinationsLayerProps {
  librarySize?: number;
}

export function DestinationsLayer({ librarySize }: DestinationsLayerProps = {}) {
  const libraryBody =
    librarySize && librarySize > 0
      ? `Specs · Plugins · Skills · Context packs. Field catalog 0.3.1 — ${librarySize} active artifacts.`
      : "Specs · Plugins · Skills · Context packs. Field catalog 0.3.1 — 38 active artifacts.";

  return (
    <div
      data-testid="destinations-layer"
      className="absolute inset-0 z-[18] pointer-events-none"
    >
      <VellumDestinationCard
        to="/topology"
        num="01"
        big="01"
        label="Topology"
        icon={<Network className="h-4 w-4" />}
        body="Host · Rig · Pod · Seat tree — live edges + runtimes; drill into any rig's pod graph."
        positionClass="top-[22%] left-[5%]"
        graphic={<TreeGraphic />}
        layout="numeral"
        callouts={["HOST", "RIG", "POD", "SEAT"]}
        tint="stone"
        shadow="ambient"
      />

      <VellumDestinationCard
        to="/project"
        num="02"
        big="02"
        label="Project"
        icon={<Folder className="h-4 w-4" />}
        body="Workspace · Mission · Slice. Browse all in-flight work by what agents are doing, not by repo."
        positionClass="top-[22%] left-[36%]"
        graphic={<StratigraphicGraphic />}
        layout="numeral"
        callouts={["WORKSPACE", "MISSION", "SLICE", "TASK"]}
        washed
        tint="stone"
        shadow="ambient"
      />

      <VellumDestinationCard
        to="/for-you"
        num="03"
        big="03"
        label="For You"
        icon={<Sparkles className="h-4 w-4" />}
        body="Action feed → what needs you · what shipped · what's in flight. Prioritized for the operator."
        positionClass="top-[22%] left-[67%]"
        graphic={<PulseGraphic />}
        layout="numeral"
        callouts={["NEEDS YOU", "SHIPPED", "IN-FLIGHT", "BLOCKED"]}
        accent
        tint="stone"
        shadow="ambient"
      />

      <VellumDestinationCard
        to="/specs"
        num="04"
        big="04"
        label="Library"
        icon={<FileText className="h-4 w-4" />}
        body={libraryBody}
        positionClass="top-[55%] left-[5%]"
        graphic={<SphereGraphic />}
        layout="numeral"
        callouts={["SPECS", "PLUGINS", "SKILLS", "PACKS"]}
        tint="stone"
        shadow="ambient"
      />

      <VellumDestinationCard
        to="/search"
        num="05"
        big="05"
        label="Search & Audit"
        icon={<Search className="h-4 w-4" />}
        body="Audit history · full artifact explorer. V1 placeholder; the full surface ships in V2."
        positionClass="top-[55%] left-[36%]"
        graphic={<MagnifierGraphic />}
        layout="numeral"
        callouts={["AUDIT", "HISTORY", "QUERY", "FILTER"]}
        tint="stone"
        shadow="ambient"
      />

      <VellumDestinationCard
        to="/settings"
        num="06"
        big="06"
        label="Settings"
        icon={<Cog className="h-4 w-4" />}
        body="Config · Policy · Log · Status. Operator-grade controls; ConfigStore-backed; reversible."
        positionClass="top-[55%] left-[67%]"
        graphic={<GearGraphic />}
        layout="numeral"
        callouts={["CONFIG", "POLICY", "LOG", "STATUS"]}
        tint="stone"
        shadow="ambient"
      />
    </div>
  );
}
