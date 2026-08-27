// S10 — outbound images via the EXTERNAL-UPLOAD flow (files.upload is sunset and dead).
// Hermetic, fixture-backed: the three legs (getUploadURLExternal → byte POST → complete with
// thread_ts) are captured at the fetch boundary. The live phone render is the named external
// door; these receipts prove the mechanical path.
import { describe, it, expect } from "vitest";
import { subsystemSlackDeliver } from "../src/domain/gateway/slack/slack-delivery.js";
import { SeenStore, type StateFsOps } from "../src/domain/gateway/slack/state-store.js";
import type { OutboundDecision } from "../src/domain/gateway/protocol.js";
import type { FetchImpl } from "../src/domain/gateway/slack/slack-api.js";

function memFs(): StateFsOps {
  const files = new Map<string, string>();
  return {
    readFileSync: (p) => { if (!files.has(p)) throw new Error("ENOENT"); return files.get(p)!; },
    appendFileSync: (p, d) => files.set(p, (files.get(p) ?? "") + d),
    writeFileSync: (p, d) => files.set(p, d),
    rename: (a, b) => { files.set(b, files.get(a) ?? ""); files.delete(a); },
    mkdirp: () => {},
  };
}
const clock = () => new Date("2026-08-27T00:00:00.000Z");

interface Call { url: string; contentType?: string; body?: unknown }
function slackFetch(failLeg?: "get-url" | "put" | "complete"): { fetchImpl: FetchImpl; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    fetchImpl: async (url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const isBytes = headers["content-type"] === "application/octet-stream";
      calls.push({ url, contentType: headers["content-type"], body: isBytes ? `<${(init?.body as Uint8Array).length} bytes>` : JSON.parse(String(init?.body ?? "{}")) });
      if (url.endsWith("files.getUploadURLExternal")) {
        if (failLeg === "get-url") return new Response(JSON.stringify({ ok: false, error: "not_allowed" }), { status: 200, headers: { "content-type": "application/json" } });
        return new Response(JSON.stringify({ ok: true, upload_url: "https://files.slack.invalid/put/abc", file_id: "F-ID-1" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url === "https://files.slack.invalid/put/abc") {
        return new Response("ok", { status: failLeg === "put" ? 500 : 200 });
      }
      if (url.endsWith("files.completeUploadExternal")) {
        if (failLeg === "complete") return new Response(JSON.stringify({ ok: false, error: "complete_failed" }), { status: 200, headers: { "content-type": "application/json" } });
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
      }
      // chat.postMessage
      return new Response(JSON.stringify({ ok: true, ts: "9000.1" }), { status: 200, headers: { "content-type": "application/json" } });
    },
  };
}

function makeDeliver(fetchImpl: FetchImpl, logs: string[] = []) {
  const fsx = memFs();
  return subsystemSlackDeliver({
    botToken: "xoxb-EXAMPLE-fake",
    channel: "C-TEST",
    sourceLabel: "vm",
    fetchImpl,
    delivered: new SeenStore("/del.jsonl", fsx, clock),
    outboundSeen: new SeenStore("/seen.jsonl", fsx, clock),
    readLocalImage: (p) => (p === "/tmp/founder-shot.png" ? { bytes: new Uint8Array(2048), filename: "founder-shot.png" } : null),
    log: (m) => logs.push(m),
  });
}
const decision = (evidenceRef: string): OutboundDecision => ({
  kind: "outbound_decision", decisionId: "d-img", op: "post_message", entityBindingRef: "mike#slack",
  payload: { qitemId: "q-img", summary: "screenshot", body: "b", destinationSession: "mike@external", sourceSession: "dev-driver@v-openrig-build", evidenceRef },
});

describe("S10 outbound images — external-upload flow (founder screenshot class)", () => {
  it("a LOCAL image evidenceRef rides all THREE legs into the thread: get-url → octet-stream bytes → complete(channel, thread_ts)", async () => {
    const { fetchImpl, calls } = slackFetch();
    const out = await makeDeliver(fetchImpl)(decision("/tmp/founder-shot.png"));
    expect(out.ok).toBe(true);
    const urls = calls.map((c) => c.url);
    expect(urls[0]).toBe("https://slack.com/api/chat.postMessage"); // text first — the thread anchor
    expect(urls[1]).toBe("https://slack.com/api/files.getUploadURLExternal");
    expect((calls[1]!.body as Record<string, unknown>).filename).toBe("founder-shot.png");
    expect((calls[1]!.body as Record<string, unknown>).length).toBe(2048);
    expect(urls[2]).toBe("https://files.slack.invalid/put/abc");
    expect(calls[2]!.contentType).toBe("application/octet-stream");
    expect(urls[3]).toBe("https://slack.com/api/files.completeUploadExternal");
    const complete = calls[3]!.body as Record<string, unknown>;
    expect(complete.channel_id).toBe("C-TEST");
    expect(complete.thread_ts).toBe("9000.1"); // attached into the posted root's thread
    expect((complete.files as { id: string }[])[0]!.id).toBe("F-ID-1");
    // no dead files.upload call anywhere
    expect(urls.some((u) => u.endsWith("/files.upload"))).toBe(false);
  });

  it("an https evidenceRef does NOT trigger the upload flow (it rides as a Block Kit image)", async () => {
    const { fetchImpl, calls } = slackFetch();
    await makeDeliver(fetchImpl)(decision("https://example.invalid/board.png"));
    expect(calls.map((c) => c.url)).toEqual(["https://slack.com/api/chat.postMessage"]);
    const blocks = (calls[0]!.body as { blocks: { type: string; image_url?: string }[] }).blocks;
    expect(blocks.filter((b) => b.type === "image")[0]!.image_url).toBe("https://example.invalid/board.png");
  });

  it("a non-uploadable local ref (reader returns null) is a clean skip — text only", async () => {
    const { fetchImpl, calls } = slackFetch();
    await makeDeliver(fetchImpl)(decision("/tmp/not-an-image.txt"));
    expect(calls.map((c) => c.url)).toEqual(["https://slack.com/api/chat.postMessage"]);
  });

  it("upload FAILURE is fail-VISIBLE but does NOT fail the delivery (no duplicate text post on replay)", async () => {
    for (const leg of ["get-url", "put", "complete"] as const) {
      const logs: string[] = [];
      const { fetchImpl } = slackFetch(leg);
      const out = await makeDeliver(fetchImpl, logs)(decision("/tmp/founder-shot.png"));
      expect(out.ok).toBe(true); // the text delivered; failing the decision would repost it
      expect(logs.join("\n")).toMatch(/ATTACHMENT .* FAILED .*text delivered; attachment missing/);
    }
  });
});
