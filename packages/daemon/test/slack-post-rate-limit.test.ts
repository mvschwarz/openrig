// F1 — postChatMessage honors Slack's own Retry-After on a 429, bounded:
// a SHORT retry-after (within the inline cap) is waited once and the post is
// retried a single time; a long pause, a missing header, or any non-429
// failure keeps today's immediate-failure behavior byte-for-byte. A 429 means
// Slack rejected the request without accepting it, so the single retry cannot
// double-post, and the delivery path already reconciles by marker on replay.
import { describe, it, expect, vi } from "vitest";
import { postChatMessage, type FetchImpl } from "../src/domain/gateway/slack/slack-api.js";

function scriptedSlack(responses: Response[]): { fetchImpl: FetchImpl; calls: () => number } {
  let i = 0;
  const fetchImpl = (async () => {
    const res = responses[Math.min(i, responses.length - 1)]!;
    i += 1;
    return res;
  }) as FetchImpl;
  return { fetchImpl, calls: () => i };
}

const rateLimited = (retryAfter?: string) =>
  Response.json({ ok: false, error: "rate_limited" }, {
    status: 429,
    ...(retryAfter !== undefined ? { headers: { "retry-after": retryAfter } } : {}),
  });
const posted = () => Response.json({ ok: true, ts: "1728400000.000100" }, { status: 200 });

describe("postChatMessage rate limit (Retry-After)", () => {
  it("waits out a short Retry-After once and retries, then reports the posted ts", async () => {
    const { fetchImpl, calls } = scriptedSlack([rateLimited("2"), posted()]);
    const sleep = vi.fn(async () => {});
    const r = await postChatMessage("xoxb-fake", { channel: "C1", text: "hello" }, fetchImpl, 5_000, sleep);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.error ?? "post failed");
    expect(r.ts).toBe("1728400000.000100");
    expect(calls(), "one rejected attempt, one retry").toBe(2);
    expect(sleep, "the platform's requested wait, in milliseconds").toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(2_000);
  });

  it("fails fast when the requested Retry-After is beyond the cap, exactly as today", async () => {
    const { fetchImpl, calls } = scriptedSlack([rateLimited("60")]);
    const sleep = vi.fn(async () => {});
    const r = await postChatMessage("xoxb-fake", { channel: "C1", text: "hello" }, fetchImpl, 5_000, sleep);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(429);
    expect(sleep, "a long platform pause is not absorbed inline").not.toHaveBeenCalled();
    expect(calls()).toBe(1);
  });

  it("fails fast on a 429 without a Retry-After header", async () => {
    const { fetchImpl, calls } = scriptedSlack([rateLimited()]);
    const sleep = vi.fn(async () => {});
    const r = await postChatMessage("xoxb-fake", { channel: "C1", text: "hello" }, fetchImpl, 5_000, sleep);
    expect(r.ok).toBe(false);
    expect(sleep).not.toHaveBeenCalled();
    expect(calls()).toBe(1);
  });

  it("never sleeps for a non-429 failure", async () => {
    const { fetchImpl, calls } = scriptedSlack([Response.json({ ok: false, error: "invalid_auth" }, { status: 401 })]);
    const sleep = vi.fn(async () => {});
    const r = await postChatMessage("xoxb-fake", { channel: "C1", text: "hello" }, fetchImpl, 5_000, sleep);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(401);
    expect(sleep).not.toHaveBeenCalled();
    expect(calls()).toBe(1);
  });

  it("returns the second attempt's failure when the retry is also rate limited", async () => {
    const { fetchImpl, calls } = scriptedSlack([rateLimited("1"), rateLimited("1")]);
    const sleep = vi.fn(async () => {});
    const r = await postChatMessage("xoxb-fake", { channel: "C1", text: "hello" }, fetchImpl, 5_000, sleep);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(429);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(calls(), "exactly one retry, never a loop").toBe(2);
  });
});
