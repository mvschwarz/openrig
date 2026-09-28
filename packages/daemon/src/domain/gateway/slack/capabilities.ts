// OPR.0.6.0.5 — the Slack connector's canonical capability sets, as pure constants (no imports,
// no I/O). config.ts, inbound.ts and the shipped app manifest all read these, so the manifest
// can be built without loading configuration and cannot drift from what the connector checks
// and admits.

/** Baseline bot scopes: the default `requiredScopes` that `rig slack verify` checks. */
export const BASELINE_REQUIRED_SCOPES: readonly string[] = ["chat:write", "channels:history", "channels:read"];

/** Bot scopes the shipped connector code uses beyond the baseline. `rig slack verify` does not
 *  require them, so a baseline READY does not prove these features have their grants. The app
 *  manifest requests them; each entry names the code path that needs it. */
export const FEATURE_SCOPES: ReadonlyArray<{ scope: string; usedBy: string }> = [
  { scope: "files:read", usedBy: "inbound attachments: authenticated url_private download (slack-subsystem inbound file port)" },
  { scope: "files:write", usedBy: "outbound attachments: files.getUploadURLExternal / files.completeUploadExternal (slack-api)" },
  { scope: "app_mentions:read", usedBy: "the app_mention event the inbound path admits (ADMITTED_EVENT_TYPES)" },
];

/** The Slack event payload types the inbound path admits (the `type` gate of ingestDecision). */
export const ADMITTED_EVENT_TYPES: readonly string[] = ["message", "app_mention"];

/** Admitted payload type → the Slack bot event to subscribe to, and the scope Slack requires for
 *  it. A subscription name is not always the payload type: `message.channels` delivers payloads
 *  of type `message`. Public channels only; no DM or private-channel subscriptions. */
export const EVENT_SUBSCRIPTIONS: Readonly<Record<string, { subscription: string; scope: string }>> = {
  message: { subscription: "message.channels", scope: "channels:history" },
  app_mention: { subscription: "app_mention", scope: "app_mentions:read" },
};
