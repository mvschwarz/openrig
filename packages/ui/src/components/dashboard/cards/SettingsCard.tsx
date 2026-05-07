import { Link } from "@tanstack/react-router";
import { Cog } from "lucide-react";
import { VellumCard } from "../../ui/vellum-card.js";
import { SectionHeader } from "../../ui/section-header.js";
import { dashboardCardSurfaceClass } from "./card-surface.js";

export function SettingsCard() {
  return (
    <Link
      to="/settings"
      data-testid="dashboard-card-settings"
      className="block focus-visible:outline focus-visible:outline-2 focus-visible:outline-stone-900 focus-visible:outline-offset-2"
    >
      <VellumCard className={dashboardCardSurfaceClass} variant="ghost" elevation="flat">
        <div className="border-b border-outline-variant px-4 py-1.5 flex items-center gap-2">
          <Cog className="h-3 w-3 text-stone-700" />
          <SectionHeader tone="muted">Settings</SectionHeader>
        </div>
        <div className="p-4 space-y-2">
          <div className="text-sm text-stone-900 font-mono uppercase">
            Configuration
          </div>
          <div className="text-xs text-on-surface-variant">
            Settings · Log · Status
          </div>
          <div className="font-mono text-[9px] uppercase tracking-wide text-on-surface-variant pt-1">
            Open settings →
          </div>
        </div>
      </VellumCard>
    </Link>
  );
}
