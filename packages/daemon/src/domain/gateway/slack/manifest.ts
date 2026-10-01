// OPR.0.6.0.5 — the Slack app manifest OpenRig ships, so a user can create their own private
// Socket Mode app from it. One pure constructor (no I/O) shared by `rig slack manifest` and the
// daemon's read-only route, so the CLI and the TUI render the same object.
//
// Scopes and events are DERIVED from the connector's canonical sources, never listed here:
//   bot scopes  = BASELINE_REQUIRED_SCOPES + FEATURE_SCOPES (capabilities.ts)
//   bot events  = ADMITTED_EVENT_TYPES via EVENT_SUBSCRIPTIONS (capabilities.ts).
// A Slack subscription name is not always the payload type (subscribing to `message.channels`
// delivers payloads of type `message`), so the mapping is explicit and checked.
// The constructor imports no configuration: it cannot load files or read the environment.
import { stringify } from "yaml";
import { ADMITTED_EVENT_TYPES, BASELINE_REQUIRED_SCOPES, EVENT_SUBSCRIPTIONS, FEATURE_SCOPES } from "./capabilities.js";

export const MANIFEST_DISPLAY_NAME = "OpenRig";
export const SLACK_CREATE_APP_URL = "https://api.slack.com/apps?new_app=1&manifest_yaml=";

export interface SlackAppManifest {
  display_information: { name: string; description: string };
  features: { bot_user: { display_name: string; always_online: boolean } };
  oauth_config: { scopes: { bot: string[] } };
  settings: {
    event_subscriptions: { bot_events: string[] };
    interactivity: { is_enabled: boolean };
    org_deploy_enabled: boolean;
    socket_mode_enabled: boolean;
    token_rotation_enabled: boolean;
  };
}

export interface SlackManifestBundle {
  manifest: SlackAppManifest;
  /** The manifest as YAML, exactly what the prefill link carries. */
  yaml: string;
  /** Slack's create-app-from-manifest link with the YAML URL-encoded. */
  url: string;
  scopes: string[];
  events: string[];
}

export interface ManifestSources {
  requiredScopes: readonly string[];
  featureScopes: readonly string[];
  admittedEventTypes: readonly string[];
  eventSubscriptions: Readonly<Record<string, { subscription: string; scope: string }>>;
}

export const CANONICAL_MANIFEST_SOURCES: ManifestSources = {
  requiredScopes: BASELINE_REQUIRED_SCOPES,
  featureScopes: FEATURE_SCOPES.map((f) => f.scope),
  admittedEventTypes: ADMITTED_EVENT_TYPES,
  eventSubscriptions: EVENT_SUBSCRIPTIONS,
};

/** Build the manifest from its sources. Throws if an admitted event type has no subscription
 *  mapping, or if a subscribed event's scope is not requested — a manifest Slack would reject
 *  or that silently loses inbound traffic is a construction error, not a runtime surprise. */
export function buildSlackAppManifest(sources: ManifestSources = CANONICAL_MANIFEST_SOURCES): SlackManifestBundle {
  const scopes = [...new Set([...sources.requiredScopes, ...sources.featureScopes])].sort();
  const events: string[] = [];
  for (const type of sources.admittedEventTypes) {
    const mapped = sources.eventSubscriptions[type];
    if (!mapped) throw new Error(`slack manifest: admitted event type "${type}" has no subscription mapping`);
    if (!scopes.includes(mapped.scope)) {
      throw new Error(`slack manifest: event "${mapped.subscription}" needs scope "${mapped.scope}", which is not requested`);
    }
    events.push(mapped.subscription);
  }
  events.sort();
  const manifest: SlackAppManifest = {
    display_information: {
      name: MANIFEST_DISPLAY_NAME,
      description: "Connects an OpenRig instance to Slack over Socket Mode.",
    },
    features: { bot_user: { display_name: MANIFEST_DISPLAY_NAME, always_online: false } },
    oauth_config: { scopes: { bot: scopes } },
    settings: {
      event_subscriptions: { bot_events: events },
      interactivity: { is_enabled: true }, // #193: button clicks arrive over the socket
      org_deploy_enabled: false,
      socket_mode_enabled: true,
      token_rotation_enabled: false,
    },
  };
  const yaml = stringify(manifest);
  return { manifest, yaml, url: SLACK_CREATE_APP_URL + encodeURIComponent(yaml), scopes, events };
}
