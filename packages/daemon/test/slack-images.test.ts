// S10 — outbound images via the EXTERNAL-UPLOAD flow (files.upload is sunset and dead).
// Hermetic, fixture-backed: the three legs (getUploadURLExternal → byte POST → complete with
// thread_ts) are captured at the fetch boundary. The live phone render is the named external
// door; these receipts prove the mechanical path.
import { describe, it, expect } from "vitest";
import { subsystemSlackDeliver, isHttpsImageRef, evidenceAttachment } from "../src/domain/gateway/slack/slack-delivery.js";
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
      attempted: new SeenStore("/att.jsonl", fsx, clock),
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

describe("#47 — a non-image https evidenceRef never becomes a Block Kit image block", () => {
  it("isHttpsImageRef: image extension (query/fragment stripped) → image; anything else → not", () => {
    expect(isHttpsImageRef("https://example.invalid/shot.png")).toBe(true);
    expect(isHttpsImageRef("https://example.invalid/shot.PNG?width=800#frag")).toBe(true);
    expect(isHttpsImageRef("https://gitlab.com/acme/team/-/work_items/10")).toBe(false);
    expect(isHttpsImageRef("https://example.invalid/PROOF.md")).toBe(false);
    expect(isHttpsImageRef("http://example.invalid/shot.png")).toBe(false);
    expect(isHttpsImageRef("/tmp/local-shot.png")).toBe(false);
    expect(isHttpsImageRef(null)).toBe(false);
    expect(isHttpsImageRef(42)).toBe(false);
  });

  it("evidenceAttachment: image https ref → media ref; non-image https ref → plain link; explicit media wins", () => {
    const img = evidenceAttachment(undefined, "https://example.invalid/a.jpg", "s");
    expect(img.mediaRefs).toEqual([{ imageUrl: "https://example.invalid/a.jpg", altText: "s" }]);
    expect(img.evidenceLink).toBeUndefined();
    const link = evidenceAttachment(undefined, "https://gitlab.com/acme/team/-/work_items/10", "s");
    expect(link.mediaRefs).toBeUndefined();
    expect(link.evidenceLink).toBe("https://gitlab.com/acme/team/-/work_items/10");
    const explicit = evidenceAttachment([{ imageUrl: "https://example.invalid/x.png", altText: "a" }], "https://gitlab.com/y", "s");
    expect(explicit.mediaRefs).toHaveLength(1); // explicit media stays caller-controlled
    expect(explicit.evidenceLink).toBeUndefined();
    const local = evidenceAttachment(undefined, "/tmp/shot.png", "s");
    expect(local.mediaRefs).toBeUndefined();
    expect(local.evidenceLink).toBeUndefined(); // local refs keep the upload-flow handling
  });

  it.each([
    ["https://example.png", false],
    ["https://example.invalid/PROOF.md?image=shot.png#preview.png", false],
    ["https://example.invalid/shot%20one.PNG?caption=%3F%23#part%2F", true],
    ["https://example.invalid/shot%2Epng", false],
    ["https://example.invalid/shot.png%3Fdownload=1", false],
    ["https://[invalid]/shot.png", false],
    ["https://example.invalid:99999/shot.png", false],
    ["https:///shot.png", false],
  ])("classifies only the parsed URL pathname: %s", (url, expected) => {
    expect(isHttpsImageRef(url)).toBe(expected);
  });

  it.each([
    "https://user:password@example.invalid/proof",
    "https://user:password@example.invalid/shot.png",
    "https://user%3Apassword@example.invalid/shot.png",
  ])("omits URL userinfo before posting evidence: %s", async (url) => {
    const { fetchImpl, calls } = slackFetch();
    const out = await makeDeliver(fetchImpl)(decision(url));
    expect(out.ok).toBe(true);
    expect(calls.map((call) => call.url)).toEqual(["https://slack.com/api/chat.postMessage"]);
    expect(JSON.stringify(calls[0]!.body)).not.toContain(url);
    expect(JSON.stringify(calls[0]!.body)).not.toContain("Evidence:");
    expect((calls[0]!.body as { blocks: { type: string }[] }).blocks.some((block) => block.type === "image")).toBe(false);
  });

  it.each([
    { name: "evidence context", evidenceRef: "https://example.invalid/" + "a".repeat(3000), body: "b", error: /evidence context/ },
    { name: "escaped evidence context", evidenceRef: "https://example.invalid/?" + "&".repeat(600), body: "b", error: /evidence context/ },
    { name: "complete fallback", evidenceRef: "https://example.invalid/" + "a".repeat(1500), body: "b".repeat(2500), error: /complete fallback/ },
  ])("rejects an oversized $name in preflight before any Slack request", async ({ evidenceRef, body, error }) => {
    const { fetchImpl, calls } = slackFetch();
    const outbound = decision(evidenceRef);
    outbound.payload = { ...(outbound.payload as Record<string, unknown>), body };
    const out = await makeDeliver(fetchImpl)(outbound);
    expect(out).toMatchObject({ ok: false, class: "human-message-unrenderable", detail: expect.stringMatching(error) });
    expect(calls).toHaveLength(0);
  });

  it("a GitLab issue-link evidenceRef posts with NO image block and a plain evidence link", async () => {
    const { fetchImpl, calls } = slackFetch();
    const out = await makeDeliver(fetchImpl)(decision("https://gitlab.com/acme/team/-/work_items/10"));
    expect(out.ok).toBe(true);
    const body = calls[0]!.body as { blocks: { type: string; image_url?: string }[]; text: string };
    expect(body.blocks.filter((b) => b.type === "image")).toHaveLength(0);
    const contexts = body.blocks.filter((b) => b.type === "context");
    expect(JSON.stringify(contexts)).toContain("https://gitlab.com/acme/team/-/work_items/10");
    expect(body.text).toContain("Evidence: https://gitlab.com/acme/team/-/work_items/10");
  });

  it("an https image URL with a query string still rides as a Block Kit image (no behavior change)", async () => {
    const { fetchImpl, calls } = slackFetch();
    await makeDeliver(fetchImpl)(decision("https://example.invalid/board.png?width=800"));
    const blocks = (calls[0]!.body as { blocks: { type: string; image_url?: string }[] }).blocks;
    const images = blocks.filter((b) => b.type === "image");
    expect(images).toHaveLength(1);
    expect(images[0]!.image_url).toBe("https://example.invalid/board.png?width=800");
    expect((calls[0]!.body as { text: string }).text).not.toContain("Evidence:");
  });
});
