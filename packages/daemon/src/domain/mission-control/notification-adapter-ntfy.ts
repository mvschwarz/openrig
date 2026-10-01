// PL-005 Phase B: ntfy.sh adapter (default per planner brief).
//
// ntfy.sh contract: HTTP POST to https://ntfy.sh/<topic> with the body
// as the notification text. Headers like Title, Click, Tags shape the
// rendering. Free, self-hostable, simple HTTP POST → push notification
// on the operator's phone (ntfy mobile app subscribed to the topic).

import type {
  NotificationAdapter,
  NotificationDeliveryResult,
  NotificationPayload,
} from "./notification-adapter-types.js";
import { validateOutboundUrl, redactUrl, safeDecodeURIComponent } from "./outbound-url-validator.js";

export interface NtfyAdapterOpts {
  /**
   * Full topic URL, e.g., `https://ntfy.sh/my-private-topic-abc123`
   * or self-hosted `https://ntfy.example.com/operator-phone`.
   */
  topicUrl: string;
  /** Optional fetch override for tests. */
  fetchImpl?: typeof fetch;
  /** Optional logger for startup warnings. Defaults to console.warn. */
  warn?: (msg: string) => void;
}

export class NtfyNotificationAdapter implements NotificationAdapter {
  readonly mechanism = "ntfy";
  readonly target: string;
  readonly disabled?: boolean;
  readonly validationError?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly authHeader?: string;

  constructor(opts: NtfyAdapterOpts) {
    const validation = validateOutboundUrl(opts.topicUrl);
    if (!validation.valid) {
      this.disabled = true;
      this.validationError = `Invalid ntfy topic URL '${redactUrl(opts.topicUrl)}': ${validation.reason}`;
      const warn = opts.warn ?? console.warn;
      warn(`[openrig] Notifications disabled: ${this.validationError}`);
      this.target = opts.topicUrl;
    } else {
      const parsed = new URL(validation.parsedUrl!.toString());
      if (parsed.username || parsed.password) {
        const user = safeDecodeURIComponent(parsed.username);
        const pass = safeDecodeURIComponent(parsed.password);
        this.authHeader = `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
        parsed.username = "";
        parsed.password = "";
      }
      this.target = parsed.toString();
    }
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async send(payload: NotificationPayload): Promise<NotificationDeliveryResult> {
    if (this.disabled) {
      return {
        ok: false,
        error: this.validationError ?? "notifications disabled: invalid topic URL",
      };
    }
    const headers: Record<string, string> = {
      Title: truncateHeader(payload.title, 250),
    };
    if (this.authHeader) {
      headers.Authorization = this.authHeader;
    }
    if (payload.qitemRef) headers.Click = payload.qitemRef;
    if (payload.tags && payload.tags.length > 0) {
      headers.Tags = payload.tags.join(",");
    }
    try {
      const res = await this.fetchImpl(this.target, {
        method: "POST",
        headers,
        body: payload.body,
      });
      if (!res.ok) {
        return { ok: false, error: `ntfy POST ${res.status}` };
      }
      return { ok: true, ack: `ntfy ${res.status}` };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

/** ntfy headers must be ASCII single-line; truncate + strip newlines. */
function truncateHeader(s: string, max: number): string {
  const cleaned = s.replace(/[\r\n]+/g, " ").trim();
  return cleaned.length > max ? cleaned.slice(0, max - 1) + "…" : cleaned;
}
