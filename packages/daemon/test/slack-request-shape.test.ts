// S10 post-seal request-shape fix — RED-first. Operator live measurement (testimony, mirrored
// here as a fixture — no credentials, no live Slack): conversations.info over JSON POST returns
// Slack `invalid_arguments`; the same token/channel over GET + URL query returns ok + is_member.
// callWebApi always emitted JSON POST, so `rig slack verify` false-failed a correct membership.
//
// The committed discriminators pin the REQUEST SHAPE (method, URL/query, headers, body absence)
// and the EFFECT (verifyChannelMembership returns the correct is_member from the supported
// shape) — while the JSON-POST family (auth.test, apps.connections.open, chat.postMessage,
// files.completeUploadExternal) stays byte-identically POST.
import { describe, it, expect } from "vitest";
import {
  verifyChannelMembership,
  fetchRecentMessageTexts,
  getGrantedScopes,
  postChatMessage,
  type FetchImpl,
} from "../src/domain/gateway/slack/slack-api.js";

interface Captured { url: string; method: string; headers: Record<string, string>; body: string | undefined }

/** A fake Slack that enforces the MEASURED live contract for read methods: JSON POST →
 *  invalid_arguments; GET + query → ok. JSON-POST family methods accept POST as before. */
function shapeEnforcingSlack(): { fetchImpl: FetchImpl; calls: Captured[] } {
  const calls: Captured[] = [];
  const READ_METHODS = ["conversations.info", "conversations.history", "conversations.replies"];
  return {
    calls,
    fetchImpl: async (url, init) => {
      const method = (init?.method ?? "GET").toUpperCase();
      const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
      const body = init?.body === undefined ? undefined : String(init.body);
      calls.push({ url, method, headers, body });
      const apiMethod = url.replace("https://slack.com/api/", "").split("?")[0]!;
      const isRead = READ_METHODS.includes(apiMethod);
      const jsonHeaders = { "content-type": "application/json" };
      if (isRead && (method !== "GET" || body !== undefined)) {
        // The measured live behavior: the read endpoint rejects the JSON-POST shape.
        return new Response(JSON.stringify({ ok: false, error: "invalid_arguments" }), { status: 200, headers: jsonHeaders });
      }
      if (apiMethod === "conversations.info") {
        const channel = new URL(url).searchParams.get("channel");
        return new Response(JSON.stringify({ ok: true, channel: { is_member: channel === "C-MEMBER", name: "ops" } }), { status: 200, headers: { ...jsonHeaders, "x-oauth-scopes": "chat:write,channels:read" } });
      }
      if (apiMethod === "conversations.history" || apiMethod === "conversations.replies") {
        return new Response(JSON.stringify({ ok: true, messages: [{ text: "hello (or-mark:d-shape)" }] }), { status: 200, headers: jsonHeaders });
      }
      // JSON-POST family: accepted as-is.
      return new Response(JSON.stringify({ ok: true, ts: "1.1", url: "wss://fake" }), { status: 200, headers: { ...jsonHeaders, "x-oauth-scopes": "chat:write" } });
    },
  };
}

describe("request shape — READ methods use GET + URL query (the supported live shape)", () => {
  it("conversations.info: GET, channel in the QUERY, Authorization header, NO body, NO json content-type — and the correct is_member comes back", async () => {
    const { fetchImpl, calls } = shapeEnforcingSlack();
    const r = await verifyChannelMembership("xoxb-EXAMPLE-fake", "C-MEMBER", fetchImpl);
    expect(r.ok, "the supported shape must not false-fail").toBe(true);
    expect(r.isMember).toBe(true);
    const c = calls[0]!;
    expect(c.method).toBe("GET");
    expect(c.url).toContain("https://slack.com/api/conversations.info?");
    expect(new URL(c.url).searchParams.get("channel")).toBe("C-MEMBER");
    expect(c.body).toBeUndefined();
    expect(c.headers["authorization"]).toContain("Bearer ");
    expect(c.headers["content-type"] ?? "").not.toContain("application/json");
  });

  it("conversations.info: a genuine non-member reads FALSE (honest result, not a shape artifact)", async () => {
    const { fetchImpl } = shapeEnforcingSlack();
    const r = await verifyChannelMembership("xoxb-EXAMPLE-fake", "C-OTHER", fetchImpl);
    expect(r.ok).toBe(true);
    expect(r.isMember).toBe(false);
  });

  it("conversations.history and conversations.replies ride the same read shape (the reconcile door's scan)", async () => {
    const { fetchImpl, calls } = shapeEnforcingSlack();
    const hist = await fetchRecentMessageTexts("xoxb-EXAMPLE-fake", "C-MEMBER", undefined, fetchImpl);
    expect(hist.ok).toBe(true);
    expect(hist.texts[0]).toContain("or-mark:d-shape");
    const replies = await fetchRecentMessageTexts("xoxb-EXAMPLE-fake", "C-MEMBER", "1724.1", fetchImpl);
    expect(replies.ok).toBe(true);
    for (const c of calls) {
      expect(c.method).toBe("GET");
      expect(c.body).toBeUndefined();
    }
    expect(calls[1]!.url).toContain("conversations.replies?");
    expect(new URL(calls[1]!.url).searchParams.get("ts")).toBe("1724.1");
  });
});

describe("request shape — the JSON-POST family is UNDISTURBED", () => {
  it("auth.test stays a JSON POST and the scope header still parses", async () => {
    const { fetchImpl, calls } = shapeEnforcingSlack();
    const g = await getGrantedScopes("xoxb-EXAMPLE-fake", fetchImpl);
    expect(g.ok).toBe(true);
    expect(g.granted).toContain("chat:write");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers["content-type"]).toContain("application/json");
  });

  it("chat.postMessage stays a JSON POST with the body intact", async () => {
    const { fetchImpl, calls } = shapeEnforcingSlack();
    const r = await postChatMessage("xoxb-EXAMPLE-fake", { channel: "C-MEMBER", text: "t" }, fetchImpl);
    expect(r.ok).toBe(true);
    expect(calls[0]!.method).toBe("POST");
    expect(JSON.parse(calls[0]!.body ?? "{}").channel).toBe("C-MEMBER");
  });
});
