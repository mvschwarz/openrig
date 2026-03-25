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
      className="cursor-pointer mb-spacing-1"
      onClick={() => onSelect(rig.id)}
    >
      <CardContent className="p-spacing-4">
        {/* Header: name + node count */}
        <div className="flex justify-between items-baseline mb-spacing-2">
          <h3 className="text-headline-md uppercase">{rig.name}</h3>
          <span className="text-label-md font-mono text-foreground-muted" data-testid={`node-count-${rig.id}`}>
            {animatedCount} NODE{rig.nodeCount !== 1 ? "S" : ""}
          </span>
        </div>

        {/* Recessed telemetry section */}
        <div className="bg-surface p-spacing-3 mb-spacing-3">
          <div className="flex gap-spacing-6 text-label-md">
            <span className="text-foreground-muted">
              SNAPSHOT{" "}
              <span className="font-mono text-foreground" data-testid={`snapshot-age-${rig.id}`}>
                {formatAge(rig.latestSnapshotAt)}
              </span>
            </span>
          </div>
        </div>

        {/* Tactical action buttons */}
        <div className="flex gap-spacing-2">
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
            onClick={(e) => { e.stopPropagation(); onSelect(rig.id); }}
          >
            GRAPH →
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
