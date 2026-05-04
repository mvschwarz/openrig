// PL-005 Phase B: hook to fetch Mission Control audit history.
import { useQuery } from "@tanstack/react-query";

export interface AuditEntry {
  actionId: string;
  actionVerb: string;
  qitemId: string | null;
  actorSession: string;
  actedAt: string;
  beforeState: Record<string, unknown> | null;
  afterState: Record<string, unknown> | null;
  reason: string | null;
  annotation: string | null;
  notifyAttempted: boolean;
  notifyResult: string | null;
  auditNotes: Record<string, unknown> | null;
}

export interface AuditQueryFilters {
  qitemId?: string;
  actionVerb?: string;
  actorSession?: string;
  since?: string;
  until?: string;
  limit?: number;
  beforeId?: string;
}

export interface AuditQueryResult {
  rows: AuditEntry[];
  hasMore: boolean;
  nextBeforeId: string | null;
}

async function fetchAudit(filters: AuditQueryFilters): Promise<AuditQueryResult> {
  const params = new URLSearchParams();
  if (filters.qitemId) params.set("qitem_id", filters.qitemId);
  if (filters.actionVerb) params.set("action_verb", filters.actionVerb);
  if (filters.actorSession) params.set("actor_session", filters.actorSession);
  if (filters.since) params.set("since", filters.since);
  if (filters.until) params.set("until", filters.until);
  if (filters.limit !== undefined) params.set("limit", String(filters.limit));
  if (filters.beforeId) params.set("before_id", filters.beforeId);
  const qs = params.toString();
  const url = `/api/mission-control/audit${qs ? `?${qs}` : ""}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export function useMissionControlAudit(filters: AuditQueryFilters) {
  return useQuery({
    queryKey: ["mission-control", "audit", filters],
    queryFn: () => fetchAudit(filters),
  });
}
