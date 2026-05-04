// PL-005 Phase B: shared notification adapter contract.
//
// Each adapter implements `send(payload)`. The dispatcher chooses the
// adapter at construction time based on the operator's notification
// mechanism config.

export interface NotificationPayload {
  /** Short human-readable title (e.g., "human-gate qitem arrived"). */
  title: string;
  /** Longer body. May contain qitem id, source rig, action verb. */
  body: string;
  /** Optional qitem reference (URL or id) for click-through. */
  qitemRef?: string;
  /** Operator-supplied tags for downstream routing (Slack channel, etc.). */
  tags?: string[];
}

export interface NotificationDeliveryResult {
  ok: boolean;
  /** When ok=true: provider-side ack (httpStatus, message-id). */
  ack?: string;
  /** When ok=false: human-readable error. */
  error?: string;
}

export interface NotificationAdapter {
  /** Adapter mechanism label for events / audit. */
  readonly mechanism: string;
  /** Target descriptor (ntfy topic URL or webhook endpoint URL). */
  readonly target: string;
  send(payload: NotificationPayload): Promise<NotificationDeliveryResult>;
}
