// PL-005 Phase B: generic webhook adapter (operator-routable alternate).
//
// Documented stable JSON body shape so the operator can POST through
// Slack incoming webhooks, Discord, Telegram bots, or their own infra.

import type {
  NotificationAdapter,
  NotificationDeliveryResult,
  NotificationPayload,
} from "./notification-adapter-types.js";
import { validateOutboundUrl, redactUrl } from "./outbound-url-validator.js";

export interface WebhookAdapterOpts {
  /** Full webhook endpoint URL. */
  endpointUrl: string;
  /** Optional fetch override for tests. */
  fetchImpl?: typeof fetch;
  /** Optional extra headers (e.g., `X-Webhook-Signature`). */
  extraHeaders?: Record<string, string>;
  /** Optional logger for startup warnings. Defaults to console.warn. */
  warn?: (msg: string) => void;
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
  readonly disabled?: boolean;
  readonly validationError?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly extraHeaders: Record<string, string>;

  constructor(opts: WebhookAdapterOpts) {
    const validation = validateOutboundUrl(opts.endpointUrl);
    if (!validation.valid) {
      this.disabled = true;
      this.validationError = `Invalid webhook endpoint URL '${redactUrl(opts.endpointUrl)}': ${validation.reason}`;
      const warn = opts.warn ?? console.warn;
      warn(`[openrig] Notifications disabled: ${this.validationError}`);
    }
    this.target = opts.endpointUrl;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.extraHeaders = opts.extraHeaders ?? {};
  }

  async send(payload: NotificationPayload): Promise<NotificationDeliveryResult> {
    if (this.disabled) {
      return {
        ok: false,
        error: this.validationError ?? "notifications disabled: invalid webhook endpoint URL",
      };
    }
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
