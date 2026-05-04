// PL-005 Phase B: generic webhook adapter (operator-routable alternate).
//
// Documented stable JSON body shape so the operator can POST through
// Slack incoming webhooks, Discord, Telegram bots, or their own infra.

import type {
  NotificationAdapter,
  NotificationDeliveryResult,
  NotificationPayload,
} from "./notification-adapter-types.js";

export interface WebhookAdapterOpts {
  /** Full webhook endpoint URL. */
  endpointUrl: string;
  /** Optional fetch override for tests. */
  fetchImpl?: typeof fetch;
  /** Optional extra headers (e.g., `X-Webhook-Signature`). */
  extraHeaders?: Record<string, string>;
}

export interface WebhookBodyShape {
  source: "openrig.mission-control";
  schema_version: 1;
  title: string;
  body: string;
  qitem_ref?: string;
  tags?: string[];
  emitted_at: string;
}

export class WebhookNotificationAdapter implements NotificationAdapter {
  readonly mechanism = "webhook";
  readonly target: string;
  private readonly fetchImpl: typeof fetch;
  private readonly extraHeaders: Record<string, string>;

  constructor(opts: WebhookAdapterOpts) {
    this.target = opts.endpointUrl;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.extraHeaders = opts.extraHeaders ?? {};
  }

  async send(payload: NotificationPayload): Promise<NotificationDeliveryResult> {
    const body: WebhookBodyShape = {
      source: "openrig.mission-control",
      schema_version: 1,
      title: payload.title,
      body: payload.body,
      qitem_ref: payload.qitemRef,
      tags: payload.tags,
      emitted_at: new Date().toISOString(),
    };
    try {
      const res = await this.fetchImpl(this.target, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...this.extraHeaders,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        return { ok: false, error: `webhook POST ${res.status}` };
      }
      return { ok: true, ack: `webhook ${res.status}` };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
