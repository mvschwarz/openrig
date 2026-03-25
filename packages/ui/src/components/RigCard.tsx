import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useCountUp } from "../hooks/useCountUp.js";

export interface RigSummary {
  id: string;
  name: string;
  nodeCount: number;
  latestSnapshotAt: string | null;
  latestSnapshotId: string | null;
}

interface RigCardProps {
  rig: RigSummary;
  onSelect: (rigId: string) => void;
  onSnapshot: () => void;
  onExport: () => void;
}

function formatAge(timestamp: string | null): string {
  if (!timestamp) return "none";
  const now = Date.now();
  const then = new Date(timestamp).getTime();
  const diffMs = now - then;
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

export function RigCard({ rig, onSelect, onSnapshot, onExport }: RigCardProps) {
  const animatedCount = useCountUp(rig.nodeCount);

  return (
    <Card
      data-testid={`rig-card-${rig.id}`}
      className="cursor-pointer mb-spacing-3 card-elevated transition-all duration-150 ease-tactical group"
      role="button"
      tabIndex={0}
      onClick={() => onSelect(rig.id)}
      onKeyDown={(e) => { if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) { e.preventDefault(); onSelect(rig.id); } }}
    >
      <CardContent className="p-spacing-6">
        {/* Header: name + node count */}
        <div className="flex justify-between items-baseline mb-spacing-4">
          <div className="flex items-center gap-spacing-3">
            {/* Active indicator dot */}
            <div className="w-1.5 h-1.5 bg-primary opacity-60" />
            <h3 className="text-headline-md uppercase tracking-[0.02em]">{rig.name}</h3>
          </div>
          <span className="text-label-lg font-mono text-foreground-muted" data-testid={`node-count-${rig.id}`}>
            <span className="font-mono text-foreground text-body-md">{animatedCount}</span>
            {" "}NODE{rig.nodeCount !== 1 ? "S" : ""}
          </span>
        </div>

        {/* Recessed telemetry section */}
        <div className="inset-surface p-spacing-4 mb-spacing-4">
          <div className="flex gap-spacing-8 text-label-md">
            <div className="flex flex-col gap-spacing-1">
              <span className="text-label-sm uppercase text-foreground-muted opacity-60 tracking-[0.06em]">
                SNAPSHOT
              </span>
              <span className="font-mono text-foreground text-body-sm" data-testid={`snapshot-age-${rig.id}`}>
                {formatAge(rig.latestSnapshotAt)}
              </span>
            </div>
            <div className="flex flex-col gap-spacing-1">
              <span className="text-label-sm uppercase text-foreground-muted opacity-60 tracking-[0.06em]">
                STATUS
              </span>
              <span className="font-mono text-primary text-body-sm">
                ACTIVE
              </span>
            </div>
          </div>
        </div>

        {/* Tactical action buttons */}
        <div className="flex gap-spacing-3 pt-spacing-2">
          <Button
            variant="tactical"
            size="sm"
            onClick={(e) => { e.stopPropagation(); onSnapshot(); }}
          >
            SNAPSHOT
          </Button>
          <Button
            variant="tactical"
            size="sm"
            onClick={(e) => { e.stopPropagation(); onExport(); }}
          >
            EXPORT
          </Button>
          <Button
            variant="tactical"
            size="sm"
            className="ml-auto group-hover:text-primary transition-colors"
            onClick={(e) => { e.stopPropagation(); onSelect(rig.id); }}
          >
            GRAPH &rarr;
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
