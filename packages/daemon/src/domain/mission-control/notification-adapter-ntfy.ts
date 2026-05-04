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

export interface NtfyAdapterOpts {
  /**
   * Full topic URL, e.g., `https://ntfy.sh/my-private-topic-abc123`
   * or self-hosted `https://ntfy.example.com/operator-phone`.
   */
  topicUrl: string;
  /** Optional fetch override for tests. */
  fetchImpl?: typeof fetch;
}

export class NtfyNotificationAdapter implements NotificationAdapter {
  readonly mechanism = "ntfy";
  readonly target: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: NtfyAdapterOpts) {
    this.target = opts.topicUrl;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async send(payload: NotificationPayload): Promise<NotificationDeliveryResult> {
    const headers: Record<string, string> = {
      Title: truncateHeader(payload.title, 250),
    };
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
