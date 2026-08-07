// M1 A5 — the connector's SHIPPED Slack delivery path. A DeliverFn that renders an
// OutboundDecision to a hygienic Slack payload (slice-11 item 7 redaction + Block Kit) and posts
// it via the same postWebhook client the relay shipped. proof-1 induces a failure at THIS path's
// HTTP boundary (a non-2xx fetch) to prove the connector acks ok:false + the gateway replays,
// then a 2xx proves ack-after-delivery — verify-not-assume, driven through the real code.

import { postWebhook, type FetchImpl } from "./slack-api.js";
import { buildOutboundMessage, type QitemLike } from "./message.js";
import type { OutboundDecision } from "@openrig/daemon/gateway-protocol";
import type { DeliveryOutcome } from "./connector-server.js";

export interface SlackDeliveryOpts {
  webhookUrl: string;
  sourceLabel: string; // host/box/rig — from config, never hardcoded (item 7)
  bodyExcerpt?: number;
  fetchImpl?: FetchImpl;
}

/** The decision.payload carries the queue content (QitemLike); the connector owns Slack rendering
 *  + hygiene, then posts. A 2xx -> ok:true; any non-2xx/transport error -> ok:false with a bounded
 *  failure class (so the gateway retains + replays — fail-visible, never a silent drop). */
export function slackDeliverFn(opts: SlackDeliveryOpts): (d: OutboundDecision) => Promise<DeliveryOutcome> {
  return async (decision) => {
    const q = (decision.payload ?? {}) as QitemLike;
    const payload = buildOutboundMessage(
      {
        qitemId: q.qitemId ?? decision.decisionId,
        summary: q.summary,
        body: q.body,
        destinationSession: q.destinationSession ?? decision.entityBindingRef,
      },
      { sourceLabel: opts.sourceLabel, bodyExcerpt: opts.bodyExcerpt },
    );
    const res = await postWebhook(opts.webhookUrl, payload, opts.fetchImpl);
    if (res.ok) return { ok: true };
    return { ok: false, class: res.status === 0 ? "transport" : `http-${res.status}`, detail: res.error };
  };
}
