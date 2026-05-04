// Token / Context Usage Surface v0 (PL-012) — fleet-wide context view.
//
// Fetches /api/ps then per-rig /api/rigs/:id/nodes (matching how
// rig ps --nodes assembles the cross-rig list), enriches each node with
// the existing contextUsage block, and projects a flat per-seat list
// for the /context dashboard.
//
// No new daemon route at v0; reuses what's already shipped.

import { useQuery } from "@tanstack/react-query";
import type { NodeInventoryEntry } from "./useNodeInventory.js";

export type ContextTier = "critical" | "warning" | "low" | "unknown";

export interface FleetSeat {
  rigId: string;
  rigName: string;
  logicalId: string;
  canonicalSessionName: string | null;
  runtime: string | null;
  usedPercentage: number | null;
  fresh: boolean;
  availability: string;
  sampledAt: string | null;
  tier: ContextTier;
}

export interface FleetSummary {
  total: number;
  byTier: Record<ContextTier, number>;
  byRuntime: Record<string, number>;
  byRig: Array<{ rigId: string; rigName: string; count: number }>;
}

export interface FleetData {
  seats: FleetSeat[];
  summary: FleetSummary;
}

export function deriveContextTier(percent: number | null | undefined, availability?: string): ContextTier {
  if (availability !== "known" || typeof percent !== "number") return "unknown";
  if (percent >= 80) return "critical";
  if (percent >= 60) return "warning";
  return "low";
}

interface PsRig {
  rigId: string;
  name: string;
  rigName?: string;
}

async function fetchFleet(): Promise<FleetData> {
  const psRes = await fetch("/api/ps");
  if (!psRes.ok) throw new Error(`HTTP ${psRes.status} from /api/ps`);
  const rigs = (await psRes.json()) as PsRig[];

  const seats: FleetSeat[] = [];
  for (const rig of rigs) {
    const rigName = rig.rigName ?? rig.name;
    const nodesRes = await fetch(`/api/rigs/${encodeURIComponent(rig.rigId)}/nodes`);
    if (!nodesRes.ok) continue;
    const nodes = (await nodesRes.json()) as NodeInventoryEntry[];
    for (const n of nodes) {
      const ctx = n.contextUsage;
      const usedPercentage = ctx?.usedPercentage ?? null;
      const availability = ctx?.availability ?? "unknown";
      const fresh = ctx?.fresh ?? false;
      seats.push({
        rigId: rig.rigId,
        rigName,
        logicalId: n.logicalId,
        canonicalSessionName: n.canonicalSessionName,
        runtime: n.runtime,
        usedPercentage,
        fresh,
        availability,
        sampledAt: ctx?.sampledAt ?? null,
        tier: deriveContextTier(usedPercentage, availability),
      });
    }
  }

  const byTier: Record<ContextTier, number> = { critical: 0, warning: 0, low: 0, unknown: 0 };
  const byRuntime: Record<string, number> = {};
  const byRigCount = new Map<string, { rigName: string; count: number }>();
  for (const s of seats) {
    byTier[s.tier]++;
    const rt = s.runtime ?? "unknown";
    byRuntime[rt] = (byRuntime[rt] ?? 0) + 1;
    const existing = byRigCount.get(s.rigId);
    if (existing) existing.count++;
    else byRigCount.set(s.rigId, { rigName: s.rigName, count: 1 });
  }
  const byRig = Array.from(byRigCount.entries()).map(([rigId, v]) => ({ rigId, rigName: v.rigName, count: v.count }));

  return {
    seats,
    summary: { total: seats.length, byTier, byRuntime, byRig },
  };
}

export function useContextFleet() {
  return useQuery({
    queryKey: ["context-fleet"],
    queryFn: fetchFleet,
    staleTime: 0,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
  });
}
