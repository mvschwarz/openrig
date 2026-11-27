import type { ReapEligibility } from "./seat-reaper-eligibility.js";
import type { StopSeatResult } from "./seat-lifecycle-service.js";

export type SeatReapedEvent = {
  readonly type: "seat.reaped";
  readonly phase: "decision" | "capture" | "effect" | "terminal";
  readonly passId: string;
  readonly timestampMs: number;
  readonly reason: "idle_reap";
  readonly operator: "daemon:seat-reaper";
  readonly rigId?: string;
  readonly rigName?: string;
  readonly nodeId?: string;
  readonly sessionName?: string;
  readonly decision?: string;
  readonly idleMinutes?: number;
  readonly thresholdMinutes?: number;
  readonly eligibility?: ReapEligibility["snapshot"] & { readonly workspace: "clean"; readonly protectedRig: false; readonly optedIn: true; readonly deliveryLease: true };
  readonly sessionId?: string;
  readonly resumeToken?: string;
  readonly resumeType?: string;
  readonly result?: StopSeatResult;
  readonly stopPhase?: string;
  readonly budgetConsumed?: boolean;
  readonly attentionRequired?: boolean;
};
