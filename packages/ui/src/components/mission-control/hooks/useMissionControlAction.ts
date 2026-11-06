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
export type MissionControlActionVerb = MissionControlVerb | "answer";

export interface MissionControlActionInput {
  verb: MissionControlActionVerb;
  qitemId: string;
  actorSession: string;
  destinationSession?: string;
  body?: string;
  annotation?: string;
  reason?: string;
  decision?: string;
  questionId?: string;
  optionId?: string;
  expectedRevision?: string;
  authority?: "primary-user";
  notify?: boolean;
  auditNotes?: Record<string, unknown>;
  /** OPR.0.4.4.15 FR-4 — origin host for remote items: the daemon forwards
   *  the verb server-side to that host's write path (absent/'local' =
   *  today's local path byte-for-byte). */
  hostId?: string;
}

export interface MissionControlAnswerOutcome {
  outcome: "recorded" | "answered";
  unanswered: string[];
  message?: string;
}

export interface MissionControlActionResult {
  actionId: string;
  verb: MissionControlActionVerb;
  qitemId: string;
  closedQitem: unknown;
  createdQitemId: string | null;
  notifyAttempted: boolean;
  notifyResult: string | null;
  auditedAt: string;
  decisionRevision?: string;
  reconciled?: true;
  revisionNote?: string;
  answer?: MissionControlAnswerOutcome;
}

const TERMINAL_QUEUE_STATES = new Set([
  "done",
  "closed",
  "completed",
  "canceled",
  "cancelled",
  "denied",
  "expired",
  "handed-off",
  "handed_off",
  "routed",
]);

function isRecordedAnswerResult(result: MissionControlActionResult): boolean {
  if (result.answer) return result.answer.outcome === "recorded";
  if (result.reconciled && typeof result.closedQitem === "object" && result.closedQitem) {
    const state = (result.closedQitem as Record<string, unknown>).state;
    return typeof state === "string" && !TERMINAL_QUEUE_STATES.has(state.toLowerCase());
  }
  return false;
}

async function postAction(input: MissionControlActionInput): Promise<MissionControlActionResult> {
  const res = await fetch("/api/mission-control/action", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...missionControlAuthHeaders() },
    body: JSON.stringify(input),
  });
  const rawText = await res.text();
  let body: unknown;
  if (rawText) {
    try {
      body = JSON.parse(rawText);
    } catch {
      body = undefined;
    }
  }
  if (!res.ok) {
    const trimmedText = rawText.trim();
    let message = trimmedText ? `HTTP ${res.status}: ${trimmedText}` : `HTTP ${res.status}`;
    let code: string | undefined;
    if (typeof body === "object" && body) {
      message = `HTTP ${res.status}`;
      const record = body as Record<string, unknown>;
      if (record.error === "remote_action_failed") {
        const parts = ["remote_action_failed"];
        if (typeof record.detail === "string" && record.detail.length > 0) {
          parts.push(record.detail);
        }
        if (typeof record.remoteStatus === "number") {
          parts.push(`remote status ${record.remoteStatus}`);
        }
        message = parts.join(" · ");
      } else if (typeof record.message === "string" && record.message.length > 0) {
        message = record.message;
      }
      if (typeof record.error === "string" && record.error.length > 0) {
        code = record.error;
      }
    }
    const err = new Error(message) as Error & { code?: string; status?: number; details?: unknown };
    if (code) err.code = code;
    err.status = res.status;
    err.details = body;
    throw err;
  }
  if (!body || typeof body !== "object") {
    throw new Error("Invalid JSON response from action endpoint");
  }
  return body as MissionControlActionResult;
}

export function useMissionControlAction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: postAction,
    onSuccess: (result, input) => {
      // Invalidate all Mission Control views so the operator sees the
      // post-action state without a manual refresh.
      queryClient.invalidateQueries({ queryKey: ["mission-control", "view"] });
      queryClient.invalidateQueries({ queryKey: ["mission-control", "audit"] });
      const isRecorded = isRecordedAnswerResult(result);
      if (input.verb !== "answer" || isRecorded) {
        queryClient.invalidateQueries({ queryKey: ["queue", "item", input.qitemId] });
      }
      if (result.createdQitemId) {
        queryClient.invalidateQueries({ queryKey: ["queue", "item", result.createdQitemId] });
      }
      if (isRecorded) {
        queryClient.invalidateQueries({ queryKey: ["attention-items"] });
      }
      queryClient.invalidateQueries({ queryKey: ["slices"] });
    },
  });
}
