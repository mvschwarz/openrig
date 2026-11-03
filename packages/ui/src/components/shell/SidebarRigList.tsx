// ui-redesign C06: live rig list inside the Fleet section.

import { Link } from "@tanstack/react-router";
import { StatusDot } from "../ui/status-badge.js";
import { Skeleton } from "../ui/skeleton.js";
import { useRigSummary } from "../../hooks/useRigSummary.js";
import { useRigStatusResolver } from "../../hooks/useRigStatusResolver.js";

export interface SidebarRigListProps {
  collapsed: boolean;
}

export function SidebarRigList({ collapsed }: SidebarRigListProps) {
  const rigsQuery = useRigSummary();
  const rigStatus = useRigStatusResolver();
  if (collapsed) return null;
  if (rigsQuery.isLoading) {
    return (
      <div className="flex flex-col gap-1 pl-9 pr-3" aria-label="Loading rigs">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-6 w-full" />
        ))}
      </div>
    );
  }
  if (rigsQuery.isError || !rigsQuery.data || rigsQuery.data.length === 0) return null;
  const rigs = rigsQuery.data.slice(0, 8);
  return (
    <div className="flex flex-col gap-0.5">
      {rigs.map((rig) => (
        <Link
          key={rig.id}
          to="/topology/rig/$rigId"
          params={{ rigId: rig.id }}
          data-testid={`sidebar-rig-${rig.id}`}
          className="flex items-center gap-2 rounded-md px-3 py-1.5 pl-9 text-on-surface-variant hover:bg-surface-low hover:text-on-surface"
        >
          <StatusDot status={rigStatus(rig.id, rig.lifecycleState)} />
          <span className="truncate text-sm">{rig.name}</span>
        </Link>
      ))}
      {rigsQuery.data.length > 8 ? (
        <Link
          to="/topology"
          data-testid="sidebar-rigs-see-all"
          className="rounded-md px-3 py-1.5 pl-9 text-sm text-on-surface-variant hover:bg-surface-low hover:text-on-surface"
        >
          See all rigs
        </Link>
      ) : null}
    </div>
  );
}
