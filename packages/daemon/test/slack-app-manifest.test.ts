import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { parse } from "yaml";
import { buildSlackAppManifest, CANONICAL_MANIFEST_SOURCES } from "../src/domain/gateway/slack/manifest.js";
import { BASELINE_REQUIRED_SCOPES, EVENT_SUBSCRIPTIONS, FEATURE_SCOPES } from "../src/domain/gateway/slack/capabilities.js";
import { DEFAULT_CONFIG } from "../src/domain/gateway/slack/config.js";
import { ingestDecision } from "../src/domain/gateway/slack/inbound.js";
import { gatewayRoutes } from "../src/routes/gateway.js";

const setOf = (xs: Iterable<string>) => new Set(xs);

// Payload types to probe the REAL admission gate with: the admitted ones plus plausible others,
// including a subscription name that is not itself a payload type.
const PROBE_TYPES = ["message", "app_mention", "reaction_added", "member_joined_channel", "message.channels", "file_shared"];
const admits = (type: string) => {
  const d = ingestDecision({ type, user: "U1", text: "hello" });
  return d.ingest || d.reason !== "type";
};

describe("shipped Slack app manifest — canonical sources", () => {
  const bundle = buildSlackAppManifest();
  const scopeSet = setOf(bundle.scopes);

  it("requests exactly the baseline required scopes plus the feature scopes (order-independent)", () => {
    expect(scopeSet).toEqual(setOf([...BASELINE_REQUIRED_SCOPES, ...FEATURE_SCOPES.map((f) => f.scope)]));
    expect(setOf(bundle.manifest.oauth_config.scopes.bot)).toEqual(scopeSet);
  });

  it("includes every scope the connector's default config makes `rig slack verify` check", () => {
    for (const scope of DEFAULT_CONFIG.requiredScopes) expect(scopeSet.has(scope)).toBe(true);
  });

  it("gives every feature scope a stated code path", () => {
    for (const f of FEATURE_SCOPES) expect(f.usedBy.trim().length).toBeGreaterThan(0);
  });

  it("subscribes to events for exactly the payload types the inbound gate admits", () => {
    const admittedByBehavior = setOf(PROBE_TYPES.filter(admits));
    const subscribedPayloadTypes = setOf(Object.entries(EVENT_SUBSCRIPTIONS)
      .filter(([, m]) => bundle.events.includes(m.subscription)).map(([type]) => type));
    expect(admittedByBehavior).toEqual(subscribedPayloadTypes);
    expect(setOf(bundle.manifest.settings.event_subscriptions.bot_events)).toEqual(setOf(bundle.events));
  });

  it("requests the scope Slack requires for every subscribed event", () => {
    for (const m of Object.values(EVENT_SUBSCRIPTIONS)) {
      if (bundle.events.includes(m.subscription)) expect(scopeSet.has(m.scope)).toBe(true);
    }
  });

  it("is a Socket Mode app with no request URL, interactivity or org-wide deploy", () => {
    const s = bundle.manifest.settings;
    expect(s.socket_mode_enabled).toBe(true);
    expect(s.interactivity.is_enabled).toBe(false);
    expect(s.org_deploy_enabled).toBe(false);
    expect(JSON.stringify(bundle.manifest)).not.toMatch(/request_url|redirect_url/);
  });

  it("round-trips: the YAML parses to the manifest and the link carries exactly that YAML", () => {
    expect(parse(bundle.yaml)).toEqual(bundle.manifest);
    const prefix = "https://api.slack.com/apps?new_app=1&manifest_yaml=";
    expect(bundle.url.startsWith(prefix)).toBe(true);
    expect(decodeURIComponent(bundle.url.slice(prefix.length))).toBe(bundle.yaml);
    expect(bundle.url.slice(prefix.length)).not.toMatch(/[\s\n:]/);
  });

  it("carries no private instance, host, rig, seat or workspace identifiers", () => {
    const text = bundle.yaml + bundle.url + JSON.stringify(bundle);
    for (const forbidden of [/esoteric/i, /v-openrig/i, /mm2/i, /openrig-build/i, /\/Users\//, /kernel/i, /@[a-z0-9-]+\b/i, /\bT0[A-Z0-9]{6,}\b/]) {
      expect(text).not.toMatch(forbidden);
    }
  });
});

describe("shipped Slack app manifest — mutation controls", () => {
  it("refuses an admitted payload type that has no subscription mapping", () => {
    expect(() => buildSlackAppManifest({ ...CANONICAL_MANIFEST_SOURCES, admittedEventTypes: ["message", "app_mention", "reaction_added"] }))
      .toThrow(/"reaction_added" has no subscription mapping/);
  });

  it("refuses a subscribed event whose scope is not requested", () => {
    expect(() => buildSlackAppManifest({ ...CANONICAL_MANIFEST_SOURCES, featureScopes: ["files:read", "files:write"] }))
      .toThrow(/needs scope "app_mentions:read"/);
  });

  it("changes the scope set when a feature scope is dropped (the equality test would fail)", () => {
    const narrowed = buildSlackAppManifest({ ...CANONICAL_MANIFEST_SOURCES, featureScopes: ["files:write", "app_mentions:read"] });
    expect(setOf(narrowed.scopes)).not.toEqual(setOf(buildSlackAppManifest().scopes));
  });

  it("would detect the inbound gate admitting a type the manifest does not subscribe to", () => {
    // Behavior-level check: a probe type the gate rejects today must stay out of the manifest.
    expect(admits("reaction_added")).toBe(false);
    expect(buildSlackAppManifest().events).not.toContain("reaction_added");
  });
});

describe("GET /slack/manifest (read-only route)", () => {
  it("returns the same object the constructor builds", async () => {
    const app = new Hono();
    app.route("/", gatewayRoutes({ home: "/nonexistent-openrig-home-for-test" }));
    const res = await app.request("/slack/manifest");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(JSON.parse(JSON.stringify(buildSlackAppManifest())));
  });

  it("is GET-only", async () => {
    const app = new Hono();
    app.route("/", gatewayRoutes({ home: "/nonexistent-openrig-home-for-test" }));
    const res = await app.request("/slack/manifest", { method: "POST" });
    expect(res.status).toBe(404);
  });
});
