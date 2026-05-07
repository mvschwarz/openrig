import { Link } from "@tanstack/react-router";
import { FileText } from "lucide-react";
import { VellumCard } from "../../ui/vellum-card.js";
import { SectionHeader } from "../../ui/section-header.js";
import { useSpecLibrary } from "../../../hooks/useSpecLibrary.js";
import { dashboardCardSurfaceClass } from "./card-surface.js";

export function SpecsCard() {
  const { data: library } = useSpecLibrary();
  const total = library?.length ?? 0;

  return (
    <Link
      to="/specs"
      data-testid="dashboard-card-specs"
      className="block focus-visible:outline focus-visible:outline-2 focus-visible:outline-stone-900 focus-visible:outline-offset-2"
    >
      <VellumCard className={dashboardCardSurfaceClass}>
        <div className="bg-stone-900 text-white px-4 py-1.5 flex items-center gap-2">
          <FileText className="h-3 w-3" />
          <SectionHeader tone="default" className="text-stone-50">
            Library
          </SectionHeader>
        </div>
        <div className="p-4 space-y-2">
          <div className="flex justify-between font-mono text-xs">
            <span className="text-on-surface-variant">Library</span>
            <span className="text-stone-900 font-bold" data-testid="specs-count">{total}</span>
          </div>
          <div className="text-xs text-on-surface-variant">
            Specs / context packs / agent images / skills
          </div>
          <div className="font-mono text-[9px] uppercase tracking-wide text-on-surface-variant pt-1">
            Open Library →
          </div>
        </div>
      </VellumCard>
    </Link>
  );
}
