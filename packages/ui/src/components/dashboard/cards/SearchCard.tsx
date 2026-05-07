import { Link } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { VellumCard } from "../../ui/vellum-card.js";
import { SectionHeader } from "../../ui/section-header.js";
import { dashboardCardSurfaceClass } from "./card-surface.js";

export function SearchCard() {
  return (
    <Link
      to="/search"
      data-testid="dashboard-card-search"
      className="block focus-visible:outline focus-visible:outline-2 focus-visible:outline-stone-900 focus-visible:outline-offset-2"
    >
      <VellumCard className={dashboardCardSurfaceClass} variant="ghost" elevation="flat">
        <div className="border-b border-outline-variant px-4 py-1.5 flex items-center gap-2">
          <Search className="h-3 w-3 text-stone-700" />
          <SectionHeader tone="muted">Search & Audit</SectionHeader>
        </div>
        <div className="p-4 space-y-2">
          <div className="text-sm text-stone-900 font-mono uppercase">
            Audit history
          </div>
          <div className="text-xs text-on-surface-variant">
            V1 placeholder · full artifact explorer in V2.
          </div>
          <div className="font-mono text-[9px] uppercase tracking-wide text-on-surface-variant pt-1">
            Open audit →
          </div>
        </div>
      </VellumCard>
    </Link>
  );
}
