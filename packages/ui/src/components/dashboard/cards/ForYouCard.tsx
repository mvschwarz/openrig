import { Link } from "@tanstack/react-router";
import { Sparkles } from "lucide-react";
import { VellumCard } from "../../ui/vellum-card.js";
import { SectionHeader } from "../../ui/section-header.js";

export function ForYouCard() {
  return (
    <Link
      to="/for-you"
      data-testid="dashboard-card-for-you"
      className="block focus-visible:outline focus-visible:outline-2 focus-visible:outline-stone-900 focus-visible:outline-offset-2"
    >
      <VellumCard className="h-full hover:hard-shadow-hover" accentClass="border-l-4 border-l-tertiary">
        <div className="bg-stone-900 text-white px-4 py-1.5 flex items-center gap-2">
          <Sparkles className="h-3 w-3" />
          <SectionHeader tone="default" className="text-stone-50">
            For You
          </SectionHeader>
        </div>
        <div className="p-4 space-y-2">
          <div className="text-sm text-stone-900 font-mono uppercase">
            Action feed
          </div>
          <div className="text-xs text-on-surface-variant">
            What needs you · what shipped · what's in flight.
          </div>
          <div className="font-mono text-[9px] uppercase tracking-wide text-tertiary pt-1">
            Open feed →
          </div>
        </div>
      </VellumCard>
    </Link>
  );
}
