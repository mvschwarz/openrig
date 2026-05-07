import { Link } from "@tanstack/react-router";
import { Folder } from "lucide-react";
import { VellumCard } from "../../ui/vellum-card.js";
import { SectionHeader } from "../../ui/section-header.js";
import { dashboardCardSurfaceClass } from "./card-surface.js";

export function ProjectCard() {
  return (
    <Link
      to="/project"
      data-testid="dashboard-card-project"
      className="block focus-visible:outline focus-visible:outline-2 focus-visible:outline-stone-900 focus-visible:outline-offset-2"
    >
      <VellumCard className={dashboardCardSurfaceClass}>
        <div className="bg-stone-900 text-white px-4 py-1.5 flex items-center gap-2">
          <Folder className="h-3 w-3" />
          <SectionHeader tone="default" className="text-stone-50">
            Project
          </SectionHeader>
        </div>
        <div className="p-4 space-y-2">
          <div className="text-sm text-stone-900 font-mono uppercase">
            Workspace · Mission · Slice
          </div>
          <div className="text-xs text-on-surface-variant">
            Browse by what agents are doing.
          </div>
          <div className="font-mono text-[9px] uppercase tracking-wide text-on-surface-variant pt-1">
            Open project tree →
          </div>
        </div>
      </VellumCard>
    </Link>
  );
}
