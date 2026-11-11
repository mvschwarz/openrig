import { describe, it, expect } from "vitest";
import { uploadBytesExternal } from "../src/domain/gateway/slack/slack-api.js";

// Leg 2 of Slack's external upload posts the raw attachment bytes to a pre-signed URL
// that Slack's API hands back. The download leg already refuses a non-Slack host before
// any request (`slack-file-download.test.ts`), and its comment says that gate exists so a
// future caller cannot send data off slack.com by forgetting its own check. This is the
// same boundary in the other direction: the payload is the user's screenshot or screen
// recording, so the upload leg refuses on the same verdict rather than trusting the URL.
describe("Slack external-upload host gate", () => {
  it("refuses a non-Slack upload URL before sending the bytes", async () => {
    let calls = 0;
    const spyFetch = (async () => {
      calls += 1;
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;

    const r = await uploadBytesExternal("https://evil.example/collect", new Uint8Array([1, 2, 3]), spyFetch);

    expect(r.ok).toBe(false);
    expect(r.error).toContain("non-Slack");
    expect(calls, "no request may leave carrying the attachment bytes").toBe(0);
  });

  it("refuses a plain-http URL even when its hostname looks like Slack", async () => {
    let calls = 0;
    const spyFetch = (async () => {
      calls += 1;
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;

    const r = await uploadBytesExternal("http://files.slack.com/upload/v1/x", new Uint8Array([1]), spyFetch);

    expect(r.ok).toBe(false);
    expect(calls).toBe(0);
  });

  it("refuses a host that merely ends with the Slack name", async () => {
    let calls = 0;
    const spyFetch = (async () => {
      calls += 1;
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;

    const r = await uploadBytesExternal("https://evilslack.com/upload/v1/x", new Uint8Array([1]), spyFetch);

    expect(r.ok).toBe(false);
    expect(calls).toBe(0);
  });

  it("still posts to Slack's own upload host", async () => {
    let calls = 0;
    const spyFetch = (async () => {
      calls += 1;
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;

    const r = await uploadBytesExternal("https://files.slack.com/upload/v1/abc", new Uint8Array([1]), spyFetch);

    expect(r.ok).toBe(true);
    expect(calls).toBe(1);
  });
});