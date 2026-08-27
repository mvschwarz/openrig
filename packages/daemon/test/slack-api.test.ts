import { describe, it, expect } from "vitest";
import {
  postWebhook,
  callWebApi,
  verifyScopes,
  verifyChannelMembership,
  openSocketConnection,
  type FetchImpl,
} from "../src/domain/gateway/slack/slack-api.js";

// Fake Slack: routes by URL, returns real Response objects (headers + json).
function fakeSlack(spec: {
  webhookStatus?: number;
  scopesHeader?: string; // value of x-oauth-scopes
  methods?: Record<string, { status?: number; json: Record<string, unknown> }>;
  throwOn?: string;
}): FetchImpl {
  return async (url) => {
    if (spec.throwOn && url.includes(spec.throwOn)) throw new Error("ECONNREFUSED");
    if (url.includes("hooks.slack.com") || (!url.includes("slack.com/api/") && url.startsWith("http"))) {
      const st = spec.webhookStatus ?? 200;
      return new Response(st === 200 ? "ok" : `err ${st}`, { status: st });
    }
    const method = url.split("/api/")[1]!.split("?")[0]!; // S10 shape-fix: read methods carry query args
    const m = spec.methods?.[method] ?? { status: 200, json: { ok: true } };
    const headers = new Headers({ "content-type": "application/json" });
    if (spec.scopesHeader !== undefined) headers.set("x-oauth-scopes", spec.scopesHeader);
    return new Response(JSON.stringify(m.json), { status: m.status ?? 200, headers });
  };
}

describe("Slice-11 slack-api — fail-visible webhook (item 3)", () => {
  it("200 → ok", async () => {
    expect((await postWebhook("https://hooks.slack.com/x", { text: "hi" }, fakeSlack({ webhookStatus: 200 }))).ok).toBe(true);
  });
  it("non-2xx → ok:false with a bounded error (fail-visible)", async () => {
    const r = await postWebhook("https://hooks.slack.com/x", { text: "hi" }, fakeSlack({ webhookStatus: 500 }));
    expect(r.ok).toBe(false);
    expect(r.status).toBe(500);
    expect(r.error).toContain("slack 500");
  });
  it("transport throw → ok:false status 0 (never throws past boundary)", async () => {
    const r = await postWebhook("https://hooks.slack.com/x", { text: "hi" }, fakeSlack({ throwOn: "hooks" }));
    expect(r.ok).toBe(false);
    expect(r.status).toBe(0);
  });
});

describe("Slice-11 slack-api — GRANTED-scope-from-headers (item 5, the setup trap)", () => {
  it("reads x-oauth-scopes from the response header, not config", async () => {
    const r = await callWebApi("auth.test", "xoxb-t", {}, fakeSlack({ scopesHeader: "incoming-webhook,chat:write", methods: { "auth.test": { json: { ok: true, user: "bot" } } } }));
    expect(r.ok).toBe(true);
    expect(r.grantedScopes).toEqual(["incoming-webhook", "chat:write"]);
  });

  it("THE TRAP: configured != granted — webhook-only install is caught as missing bot scopes", async () => {
    // Simulates Add-New-Webhook: only incoming-webhook granted, no reinstall yet.
    const fetchImpl = fakeSlack({ scopesHeader: "incoming-webhook", methods: { "auth.test": { json: { ok: true } } } });
    const v = await verifyScopes("xoxb-t", ["chat:write", "channels:read"], fetchImpl);
    expect(v.ok).toBe(false);
    expect(v.missing.sort()).toEqual(["channels:read", "chat:write"]);
    expect(v.granted).toEqual(["incoming-webhook"]);
  });

  it("all required scopes present → ok", async () => {
    const fetchImpl = fakeSlack({ scopesHeader: "chat:write,channels:read,channels:history", methods: { "auth.test": { json: { ok: true } } } });
    const v = await verifyScopes("xoxb-t", ["chat:write", "channels:read"], fetchImpl);
    expect(v.ok).toBe(true);
    expect(v.missing).toEqual([]);
  });

  it("invalid token → verdict not-ok with error, never a false pass", async () => {
    const fetchImpl = fakeSlack({ scopesHeader: "", methods: { "auth.test": { status: 200, json: { ok: false, error: "invalid_auth" } } } });
    const v = await verifyScopes("bad", ["chat:write"], fetchImpl);
    expect(v.ok).toBe(false);
    expect(v.error).toBe("invalid_auth");
  });
});

describe("Slice-11 slack-api — channel membership + socket (item 5, inbound)", () => {
  it("verifyChannelMembership reflects is_member", async () => {
    const inFetch = fakeSlack({ methods: { "conversations.info": { json: { ok: true, channel: { is_member: true, name: "founder" } } } } });
    const inR = await verifyChannelMembership("xoxb-t", "C1", inFetch);
    expect(inR).toMatchObject({ ok: true, isMember: true, name: "founder" });

    const outFetch = fakeSlack({ methods: { "conversations.info": { json: { ok: true, channel: { is_member: false } } } } });
    expect((await verifyChannelMembership("xoxb-t", "C1", outFetch)).isMember).toBe(false);
  });

  it("openSocketConnection returns the ws url", async () => {
    const fetchImpl = fakeSlack({ methods: { "apps.connections.open": { json: { ok: true, url: "wss://slack/ws" } } } });
    const r = await openSocketConnection("xapp-t", fetchImpl);
    expect(r).toMatchObject({ ok: true, url: "wss://slack/ws" });
  });

  it("openSocketConnection surfaces an error verdict", async () => {
    const fetchImpl = fakeSlack({ methods: { "apps.connections.open": { json: { ok: false, error: "not_allowed_token_type" } } } });
    const r = await openSocketConnection("xoxb-wrong", fetchImpl);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("not_allowed_token_type");
  });
});
