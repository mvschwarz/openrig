// PL-005 Phase A: mutation hook for the 7 Mission Control verbs.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { missionControlAuthHeaders } from "../missionControlAuth.js";

export const MISSION_CONTROL_VERBS = [
  "approve",
  "deny",
  "route",
  "annotate",
  "hold",
  "drop",
  "handoff",
] as const;

export type MissionControlVerb = (typeof MISSION_CONTROL_VERBS)[number];

export interface MissionControlActionInput {
  verb: MissionControlVerb;
  qitemId: string;
  actorSession: string;
  destinationSession?: string;
  body?: string;
  annotation?: string;
  reason?: string;
  notify?: boolean;
  auditNotes?: Record<string, unknown>;
}

export interface MissionControlActionResult {
  actionId: string;
  verb: MissionControlVerb;
  qitemId: string;
  closedQitem: unknown;
  createdQitemId: string | null;
  notifyAttempted: boolean;
  notifyResult: string | null;
  auditedAt: string;
}

async function postAction(input: MissionControlActionInput): Promise<MissionControlActionResult> {
  const res = await fetch("/api/mission-control/action", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...missionControlAuthHeaders() },
    body: JSON.stringify(input),
  });
  const body = await res.json();
  if (!res.ok) {
    const err = new Error(
      typeof body === "object" && body && "message" in body
        ? String((body as { message: unknown }).message)
        : `HTTP ${res.status}`,
    ) as Error & { code?: string; details?: unknown };
    if (typeof body === "object" && body && "error" in body) {
      err.code = String((body as { error: unknown }).error);
    }
    err.details = body;
    throw err;
  }
  return body as MissionControlActionResult;
}

export function useMissionControlAction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: postAction,
    onSuccess: () => {
      // Invalidate all Mission Control views so the operator sees the
      // post-action state without a manual refresh.
      queryClient.invalidateQueries({ queryKey: ["mission-control", "view"] });
    },
  });
}
