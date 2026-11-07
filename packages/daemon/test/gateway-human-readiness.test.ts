import { describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import { resolveHumanDeliveryReadiness } from "../src/domain/gateway/human-readiness.js";
import { loadRelayProfiles } from "../src/domain/gateway/relay-config.js";
import { gatewayRoutes } from "../src/routes/gateway.js";
import {
  addHumanFragment,
  projectionPath,
  type HumanFragment,
} from "../src/domain/gateway/human-registry.js";
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

describe("relay primary-binding readiness", () => {
  const unconfiguredSlack: SlackConnectorConfig = {
    ...config,
    enabled: false,
    channel: null,
  };

  it("reports ready for a valid relay profile even when Slack is disabled and unconfigured", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-ready-"));
    try {
      const envFile = join(dir, "relay.env");
      writeFileSync(
        envFile,
        [
          "OPENRIG_RELAY_URL=http://127.0.0.1:8787/outbound",
          "OPENRIG_RELAY_OUTBOUND_TOKEN=out-secret-token-1",
          "OPENRIG_RELAY_INBOUND_TOKEN=in-secret-token-1",
        ].join("\n"),
        { mode: 0o600 },
      );
      const relayHuman: HumanFragment = {
        ...human,
        connectorBindings: [
          {
            kind: "relay",
            connectorRef: "bridge-main",
            secretsRef: `file:${envFile}`,
            role: "primary",
            handle: "founder",
          },
        ],
      };
      const verifyScopes = vi.fn();
      const result = await resolveHumanDeliveryReadiness(
        { human: relayHuman, config: unconfiguredSlack, gatewayState: "active", botToken: null, home: dir },
        { verifyScopes, entities: [relayHuman], now: () => new Date("2026-11-06T00:00:00.000Z") },
      );
      expect(verifyScopes).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        state: "ready",
        configured: true,
        enabled: true,
        active: true,
        ready: true,
        connector: { kind: "relay", ref: "bridge-main" },
        nextAction: null,
        checkedAt: "2026-11-06T00:00:00.000Z",
      });
      expect(JSON.stringify(result)).not.toContain("out-secret-token-1");
      expect(JSON.stringify(result)).not.toContain("in-secret-token-1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps relay profile ready with redacted warning when secret file has group/other bits or uses the same directional token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-warn-ready-"));
    try {
      const envFile = join(dir, "relay-warn.env");
      writeFileSync(
        envFile,
        [
          "OPENRIG_RELAY_URL=http://127.0.0.1:8787/outbound",
          "OPENRIG_RELAY_OUTBOUND_TOKEN=shared-bidirectional-tok-99",
          "OPENRIG_RELAY_INBOUND_TOKEN=shared-bidirectional-tok-99",
        ].join("\n"),
        { mode: 0o644 },
      );
      chmodSync(envFile, 0o644);
      const relayHuman: HumanFragment = {
        ...human,
        connectorBindings: [
          {
            kind: "relay",
            connectorRef: "bridge-warn",
            secretsRef: `file:${envFile}`,
            role: "primary",
            handle: "founder",
          },
        ],
      };
      const result = await resolveHumanDeliveryReadiness(
        { human: relayHuman, config: unconfiguredSlack, gatewayState: "active", botToken: null, home: dir },
        { entities: [relayHuman], now: () => new Date("2026-11-07T00:00:00.000Z") },
      );
      expect(result).toMatchObject({
        state: "ready",
        configured: true,
        enabled: true,
        active: true,
        ready: true,
        connector: { kind: "relay", ref: "bridge-warn" },
        nextAction: null,
      });
      expect(result.reason).toMatch(/warning/i);
      expect(result.reason).toMatch(/group\/other/i);
      expect(result.reason).toMatch(/OPENRIG_RELAY_OUTBOUND_TOKEN/);
      expect(JSON.stringify(result)).not.toContain("shared-bidirectional-tok-99");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports not-ready with sanitized reason when relay credentials are invalid or ambiguous", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-unready-"));
    try {
      const envFile1 = join(dir, "relay1.env");
      const envFile2 = join(dir, "relay2.env");
      writeFileSync(
        envFile1,
        [
          "OPENRIG_RELAY_URL=http://127.0.0.1:8787/out1",
          "OPENRIG_RELAY_OUTBOUND_TOKEN=out-1",
          "OPENRIG_RELAY_INBOUND_TOKEN=shared-inbound-secret",
        ].join("\n"),
        { mode: 0o600 },
      );
      writeFileSync(
        envFile2,
        [
          "OPENRIG_RELAY_URL=http://127.0.0.1:8788/out2",
          "OPENRIG_RELAY_OUTBOUND_TOKEN=out-2",
          "OPENRIG_RELAY_INBOUND_TOKEN=shared-inbound-secret",
        ].join("\n"),
        { mode: 0o600 },
      );
      const h1: HumanFragment = {
        ...human,
        entityId: "founder",
        address: "founder@external",
        connectorBindings: [{ kind: "relay", connectorRef: "r1", secretsRef: `file:${envFile1}`, role: "primary", handle: "f1" }],
      };
      const h2: HumanFragment = {
        ...human,
        entityId: "partner",
        address: "partner@external",
        connectorBindings: [{ kind: "relay", connectorRef: "r2", secretsRef: `file:${envFile2}`, role: "primary", handle: "p1" }],
      };
      const relayProfiles = loadRelayProfiles(dir, { entities: [h1, h2] });
      const r1Readiness = await resolveHumanDeliveryReadiness({
        human: h1,
        config: unconfiguredSlack,
        gatewayState: "active",
        botToken: null,
        relayProfiles,
      });
      expect(r1Readiness).toMatchObject({
        state: "not-ready",
        configured: false,
        enabled: true,
        active: false,
        ready: false,
        connector: { kind: "relay", ref: "r1" },
      });
      expect(r1Readiness.reason).toMatch(/ambiguous.*OPENRIG_RELAY_INBOUND_TOKEN/i);
      expect(r1Readiness.reason).not.toContain("shared-inbound-secret");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never falls back to single input.human when home registry is corrupt or human is unregistered, and preserves cross-profile ambiguity from home", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-failclosed-"));
    try {
      const envFile1 = join(dir, "relay1.env");
      const envFile2 = join(dir, "relay2.env");
      writeFileSync(
        envFile1,
        [
          "OPENRIG_RELAY_URL=http://127.0.0.1:8787/out1",
          "OPENRIG_RELAY_OUTBOUND_TOKEN=out-1",
          "OPENRIG_RELAY_INBOUND_TOKEN=shared-inbound-secret",
        ].join("\n"),
        { mode: 0o600 },
      );
      writeFileSync(
        envFile2,
        [
          "OPENRIG_RELAY_URL=http://127.0.0.1:8788/out2",
          "OPENRIG_RELAY_OUTBOUND_TOKEN=out-2",
          "OPENRIG_RELAY_INBOUND_TOKEN=shared-inbound-secret",
        ].join("\n"),
        { mode: 0o600 },
      );
      const h1: HumanFragment = {
        ...human,
        entityId: "founder",
        address: "founder@external",
        connectorBindings: [{ kind: "relay", connectorRef: "r1", secretsRef: `file:${envFile1}`, role: "primary", handle: "f1" }],
      };
      const h2: HumanFragment = {
        ...human,
        entityId: "partner",
        address: "partner@external",
        connectorBindings: [{ kind: "relay", connectorRef: "r2", secretsRef: `file:${envFile2}`, role: "primary", handle: "p1" }],
      };

      // 1. Unregistered human in empty home must not fall back to single-human evaluation
      const verifyScopes = vi.fn();
      const unregisteredReady = await resolveHumanDeliveryReadiness(
        { human: h1, config: unconfiguredSlack, gatewayState: "active", botToken: null, home: dir },
        { verifyScopes },
      );
      expect(unregisteredReady.ready).toBe(false);
      expect(unregisteredReady.state).toBe("not-ready");
      expect(verifyScopes).not.toHaveBeenCalled();

      // 2. Full registry on disk with cross-profile ambiguous inbound token remains not-ready
      expect(addHumanFragment(h1 as unknown as Record<string, unknown>, dir).ok).toBe(true);
      expect(addHumanFragment(h2 as unknown as Record<string, unknown>, dir).ok).toBe(true);
      const fromHomeAmbiguous = await resolveHumanDeliveryReadiness(
        { human: h1, config: unconfiguredSlack, gatewayState: "active", botToken: null, home: dir },
        { verifyScopes },
      );
      expect(fromHomeAmbiguous.ready).toBe(false);
      expect(fromHomeAmbiguous.state).toBe("not-ready");
      expect(fromHomeAmbiguous.reason).toMatch(/ambiguous.*OPENRIG_RELAY_INBOUND_TOKEN/i);

      // 3. Corrupt registry projection fails closed (never ready)
      writeFileSync(projectionPath(dir), "corrupted: hand-edited\n");
      const corruptReady = await resolveHumanDeliveryReadiness(
        { human: h1, config: unconfiguredSlack, gatewayState: "active", botToken: null, home: dir },
        { verifyScopes },
      );
      expect(corruptReady.ready).toBe(false);
      expect(corruptReady.state).toBe("not-ready");
      expect(verifyScopes).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
