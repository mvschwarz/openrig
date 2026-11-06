// A remote client lists Slack channels and people through the daemon, which holds the bot token. A fake fetch plays
// Slack; nothing reaches the network.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatewayRoutes } from "../src/routes/gateway.js";
import { DEFAULT_CONFIG, saveConfig } from "../src/domain/gateway/slack/config.js";

const TOKEN = "xoxb-test-secret";
let home: string;
let calls: URL[];
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "gateway-slack-directory-"));
  calls = [];
  writeFileSync(join(home, "slack.env"), `SLACK_BOT_TOKEN=${TOKEN}\n`);
  // Inbound delivery stays disabled: listing must not need it.
  saveConfig({ ...DEFAULT_CONFIG, enabled: false, secretsEnvFile: join(home, "slack.env") }, home);
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function app(reply: (method: string) => { status?: number; headers?: Record<string, string>; body: unknown }) {
  const fetchImpl = async (url: string) => {
    const u = new URL(url); calls.push(u);
    const r = reply(u.pathname.replace("/api/", ""));
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: r.headers });
  };
  return gatewayRoutes({ home, slack: { fetchImpl, env: {} } });
}

describe("GET /api/gateway/slack/channels and /users", () => {
  it("lists one page of public, unarchived channels with explicit fields and the next cursor", async () => {
    const res = await app(() => ({ body: { ok: true, channels: [{ id: "C1", name: "ops", is_member: true, purpose: { value: "x" }, is_private: false }],
      response_metadata: { next_cursor: "dGVhbQ==" } } })).request("/slack/channels?cursor=abc&limit=50");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, channels: [{ id: "C1", name: "ops", isMember: true }], nextCursor: "dGVhbQ==" });
    expect(Object.fromEntries(calls[0]!.searchParams)).toMatchObject({ types: "public_channel", exclude_archived: "true", cursor: "abc", limit: "50" });
  });

  it("lists people without their email or the token, and the last page has no cursor", async () => {
    const res = await app(() => ({ body: { ok: true, members: [{ id: "U1", name: "sam", real_name: "Sam Lee", is_bot: false, deleted: false,
      profile: { display_name: "sam", email: "sam@example.com" } }], response_metadata: { next_cursor: "" } } })).request("/slack/users");
    const body = await res.json();
    expect(body).toEqual({ ok: true, users: [{ id: "U1", name: "sam", realName: "Sam Lee", displayName: "sam", isBot: false, deleted: false }], nextCursor: null });
    expect(JSON.stringify(body)).not.toMatch(/example\.com|xoxb/);
  });

  it("says which scope is missing instead of returning an empty list", async () => {
    const res = await app(() => ({ body: { ok: false, error: "missing_scope", needed: "users:read", provided: "chat:write" } })).request("/slack/users");
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "slack_missing_scope", needed: "users:read" });
  });

  it("keeps Slack's retry timing when rate limited", async () => {
    const res = await app(() => ({ status: 429, headers: { "retry-after": "30" }, body: { ok: false, error: "ratelimited" } })).request("/slack/channels");
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("30");
  });

  it("never returns the token in a transport failure, even one whose message quotes the request header", async () => {
    // Node's fetch rejects a token copied with a newline before connecting, quoting the whole header in its message.
    const fetchImpl = async (_url: string, init?: RequestInit) => {
      throw new TypeError(`Headers.append: "${(init?.headers as Record<string, string>).authorization}" is an invalid header value.`);
    };
    const res = await gatewayRoutes({ home, slack: { fetchImpl, env: { SLACK_BOT_TOKEN: "xoxb-copied\nSECRETTAIL" } } }).request("/slack/channels");
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).toContain("slack_unreachable");
    expect(text).not.toMatch(/xoxb|SECRETTAIL/);
  });

  it("tells an unconfigured bot token apart from an empty directory", async () => {
    saveConfig({ ...DEFAULT_CONFIG, secretsEnvFile: null }, home);
    const unconfigured = await app(() => ({ body: { ok: true, channels: [] } })).request("/slack/channels");
    expect(unconfigured.status).toBe(503);
    expect(await unconfigured.json()).toMatchObject({ error: "slack_not_configured" });
    expect(calls).toHaveLength(0);
    saveConfig({ ...DEFAULT_CONFIG, secretsEnvFile: join(home, "slack.env") }, home);
    const empty = await app(() => ({ body: { ok: true, channels: [], response_metadata: { next_cursor: "" } } })).request("/slack/channels");
    expect(await empty.json()).toEqual({ ok: true, channels: [], nextCursor: null });
  });
});
