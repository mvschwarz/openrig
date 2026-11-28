import type { NotificationAdapter } from "./notification-adapter-types.js";
import { NtfyNotificationAdapter } from "./notification-adapter-ntfy.js";
import { WebhookNotificationAdapter } from "./notification-adapter-webhook.js";

/** The daemon's notification adapter, from its environment: OPENRIG_NOTIFICATIONS_MECHANISM=ntfy|webhook|none (default
 *  none) and OPENRIG_NOTIFICATIONS_TARGET=<topic url | webhook url>. Null when the mechanism is none or the target is
 *  empty; an unrecognized mechanism throws. No legacy alias for these names (new in Phase B). */
export function notificationAdapterFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  opts: { fetchImpl?: typeof fetch } = {},
): NotificationAdapter | null {
  const mechanism = env.OPENRIG_NOTIFICATIONS_MECHANISM ?? "none";
  const target = env.OPENRIG_NOTIFICATIONS_TARGET ?? "";
  if (mechanism === "none" || target.length === 0) return null;
  if (mechanism === "ntfy") return new NtfyNotificationAdapter({ topicUrl: target, ...opts });
  if (mechanism === "webhook") return new WebhookNotificationAdapter({ endpointUrl: target, ...opts });
  throw new Error(`OPENRIG_NOTIFICATIONS_MECHANISM='${mechanism}' is not recognized; supported: ntfy | webhook | none`);
}
