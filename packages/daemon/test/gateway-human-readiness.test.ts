import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { resolveHumanDeliveryReadiness } from "../src/domain/gateway/human-readiness.js";
import { gatewayRoutes } from "../src/routes/gateway.js";
import type { HumanFragment } from "../src/domain/gateway/human-registry.js";
import type { SlackConnectorConfig } from "../src/domain/gateway/slack/config.js";

const human: HumanFragment = {
  entityId: "founder",
  class: "human",
  displayName: "Founder",
  address: "founder@external",
  connectorBindings: [{ kind: "slack", connectorRef: "main", secretsRef: "vault://founder", role: "primary", handle: "U1" }],
  prefs: { deliveryClass: "B" },
};

const config: SlackConnectorConfig = {
  enabled: true,
  inboundDestination: "orch@rig",
  outboundDestinations: [],
  sourceLabel: "openrig",
  channel: "C1",
  requiredScopes: ["chat:write", "channels:read"],
  secretsEnvFile: null,
  queueUrl: null,
  minimumLevelThatPosts: "NOTICE",
  minimumLevelThatInterrupts: "ALERT",
};

describe("registered human primary-binding readiness", () => {
  it("returns connector-neutral ready fields from live scope and membership evidence", async () => {
    const result = await resolveHumanDeliveryReadiness({ human, config, gatewayState: "active", botToken: "secret" }, {
      verifyScopes: async () => ({ ok: true, granted: ["chat:write", "channels:read"], missing: [] }),
      verifyMembership: async () => ({ ok: true, isMember: true }),
      now: () => new Date("2026-09-06T01:00:00.000Z"),
    });
    expect(result).toEqual({
      state: "ready",
      configured: true,
      enabled: true,
      active: true,
      ready: true,
      connector: { kind: "slack", ref: "main" },
      reason: "required scopes and channel membership verified",
      nextAction: null,
      checkedAt: "2026-09-06T01:00:00.000Z",
    });
  });

  it("serves the same connector-neutral record through the gateway human route", async () => {
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("gatewaySubsystem" as never, { status: () => ({ state: "active" }) } as never);
      await next();
    });
    app.route("/", gatewayRoutes({
      readiness: async (entityId, gatewayState) => entityId === "founder"
        ? resolveHumanDeliveryReadiness({ human, config, gatewayState, botToken: "secret" }, {
            verifyScopes: async () => ({ ok: true, granted: config.requiredScopes, missing: [] }),
            verifyMembership: async () => ({ ok: true, isMember: true }),
          })
        : null,
    }));
    const response = await app.request("/human/founder/readiness");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      readiness: { state: "ready", configured: true, enabled: true, active: true, ready: true },
    });
  });

  it("names disabled configuration without probing the connector", async () => {
    const verifyScopes = vi.fn(async () => ({ ok: true, granted: [], missing: [] }));
    const result = await resolveHumanDeliveryReadiness({ human, config: { ...config, enabled: false }, gatewayState: "active", botToken: "secret" }, {
      verifyScopes,
      verifyMembership: async () => ({ ok: true, isMember: true }),
    });
    expect(result).toMatchObject({ state: "not-ready", configured: true, enabled: false, active: false, ready: false, nextAction: "rig slack enable" });
    expect(verifyScopes).not.toHaveBeenCalled();
  });

  it("keeps an unreachable live probe indeterminate instead of calling it ready or failed", async () => {
    const result = await resolveHumanDeliveryReadiness({ human, config, gatewayState: "active", botToken: "secret" }, {
      verifyScopes: async () => ({ ok: false, granted: [], missing: config.requiredScopes, error: "request timed out" }),
      verifyMembership: async () => ({ ok: true, isMember: true }),
    });
    expect(result).toMatchObject({ state: "indeterminate", configured: true, enabled: true, active: true, ready: false });
    expect(result.reason).toContain("request timed out");
    expect(result.nextAction).toBe("rig slack verify --json");
  });
});

describe("#192 readiness checks every channel the connector posts to", () => {
  const mapped: SlackConnectorConfig = { ...config, channel: "C0DEFAULT", channelMap: [
    { match: "my-rig", channel: "C0EXAMPLE1" }, { match: "other-rig", channel: "C0EXAMPLE1" }, { match: "pr@my-rig", channel: "C0EXAMPLE2" },
  ] };
  const scopes = async () => ({ ok: true, granted: config.requiredScopes, missing: [] });
  const membership = (members: Record<string, { ok: boolean; isMember: boolean; error?: string }>, asked: string[]) =>
    async (_token: string, channel: string) => { asked.push(channel); return members[channel] ?? { ok: true, isMember: false }; };
  const yes = { ok: true, isMember: true };

  it("is not-ready when the app is missing from a mapped channel, naming the channel and what maps to it", async () => {
    const asked: string[] = [];
    const result = await resolveHumanDeliveryReadiness({ human, config: mapped, gatewayState: "active", botToken: "secret" }, {
      verifyScopes: scopes, verifyMembership: membership({ C0DEFAULT: yes, C0EXAMPLE1: yes, C0EXAMPLE2: { ok: true, isMember: false } }, asked),
    });
    expect(asked).toEqual(["C0DEFAULT", "C0EXAMPLE1", "C0EXAMPLE2"]); // each unique channel once
    expect(result).toMatchObject({ state: "not-ready", ready: false, reason: "connector is not a member of mapped channel C0EXAMPLE2 (pr@my-rig)", nextAction: "rig slack verify --json" });
  });

  it("names every missing channel, the default first", async () => {
    const result = await resolveHumanDeliveryReadiness({ human, config: mapped, gatewayState: "active", botToken: "secret" }, {
      verifyScopes: scopes, verifyMembership: membership({ C0DEFAULT: { ok: true, isMember: false }, C0EXAMPLE1: { ok: true, isMember: false }, C0EXAMPLE2: yes }, []),
    });
    expect(result.reason).toBe("connector is not a member of its configured channel; mapped channel C0EXAMPLE1 (my-rig, other-rig)");
  });

  it("is ready only when the app is in every channel", async () => {
    const result = await resolveHumanDeliveryReadiness({ human, config: mapped, gatewayState: "active", botToken: "secret" }, {
      verifyScopes: scopes, verifyMembership: membership({ C0DEFAULT: yes, C0EXAMPLE1: yes, C0EXAMPLE2: yes }, []),
    });
    expect(result).toMatchObject({ state: "ready", ready: true, reason: "required scopes and channel membership verified (3 channels)", nextAction: null });
  });

  it("is indeterminate when a mapped check is unavailable and no channel is known to be missing", async () => {
    const result = await resolveHumanDeliveryReadiness({ human, config: mapped, gatewayState: "active", botToken: "secret" }, {
      verifyScopes: scopes, verifyMembership: membership({ C0DEFAULT: yes, C0EXAMPLE1: { ok: false, isMember: false, error: "ratelimited" }, C0EXAMPLE2: yes }, []),
    });
    expect(result).toMatchObject({ state: "indeterminate", reason: "channel membership verification unavailable: C0EXAMPLE1: ratelimited" });
  });

  it("a known missing channel outranks an unavailable check", async () => {
    const result = await resolveHumanDeliveryReadiness({ human, config: mapped, gatewayState: "active", botToken: "secret" }, {
      verifyScopes: scopes, verifyMembership: membership({ C0DEFAULT: yes, C0EXAMPLE1: { ok: false, isMember: false, error: "ratelimited" }, C0EXAMPLE2: { ok: true, isMember: false } }, []),
    });
    expect(result).toMatchObject({ state: "not-ready", reason: "connector is not a member of mapped channel C0EXAMPLE2 (pr@my-rig)" });
  });

  it("without a map: one check of the default channel, with today's wording for every outcome", async () => {
    const run = async (answer: { ok: boolean; isMember: boolean; error?: string }) => {
      const asked: string[] = [];
      const result = await resolveHumanDeliveryReadiness({ human, config, gatewayState: "active", botToken: "secret" }, {
        verifyScopes: scopes, verifyMembership: membership({ C1: answer }, asked),
      });
      return { asked, state: result.state, reason: result.reason };
    };
    expect(await run(yes)).toEqual({ asked: ["C1"], state: "ready", reason: "required scopes and channel membership verified" });
    expect(await run({ ok: true, isMember: false })).toEqual({ asked: ["C1"], state: "not-ready", reason: "connector is not a member of its configured channel" });
    expect(await run({ ok: false, isMember: false, error: "boom" })).toEqual({ asked: ["C1"], state: "indeterminate", reason: "channel membership verification unavailable: boom" });
  });
});
