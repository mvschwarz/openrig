// Resolve one status string per rig for StatusDot/StatusBadge. The rig
// summary's `lifecycleState` wins; older daemons (and the twin fixtures)
// omit it, so fall back to the `/api/ps` row status the Dashboard uses.

import { usePsEntries } from "./usePsEntries.js";

export function useRigStatusResolver(): (rigId: string, lifecycleState?: string | null) => string {
  const ps = usePsEntries();
  return (rigId, lifecycleState) => {
    if (lifecycleState) return lifecycleState;
    const row = ps.data?.find((r) => r.rigId === rigId);
    return row?.lifecycleState ?? row?.status ?? "unknown";
  };
}
