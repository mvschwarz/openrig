// #300: the uploaded file's title carries the queue summary, so it must be redacted like the
// message text. Hermetic: a fake Slack at the fetch boundary; no network, no real token.
import { describe, it, expect } from "vitest";
import { subsystemSlackDeliver } from "../src/domain/gateway/slack/slack-delivery.js";
import { SeenStore, type StateFsOps } from "../src/domain/gateway/slack/state-store.js";
import type { FetchImpl } from "../src/domain/gateway/slack/slack-api.js";

const SECRET = "xoxb-1-2-abc";

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

/** Every Slack call's URL and raw body; JSON and form bodies are both kept as text. */
function slack(): { fetchImpl: FetchImpl; calls: { url: string; body: string }[] } {
  const calls: { url: string; body: string }[] = [];
  const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url, body: init?.body instanceof Uint8Array ? "<bytes>" : String(init?.body ?? "") });
      if (url.endsWith("files.getUploadURLExternal")) return json({ ok: true, upload_url: "https://files.slack.invalid/put/abc", file_id: "F-ID-1" });
      if (url === "https://files.slack.invalid/put/abc") return new Response("ok", { status: 200 });
      if (url.endsWith("files.completeUploadExternal")) return json({ ok: true });
      return json({ ok: true, ts: "9000.1" });
    },
  };
}

/** The `files` field of files.completeUploadExternal, whether sent as JSON or as a form field. */
function uploadedTitle(body: string): string {
  let files: unknown;
  try { files = (JSON.parse(body) as { files: unknown }).files; } catch { files = new URLSearchParams(body).get("files"); }
  const list = (typeof files === "string" ? JSON.parse(files) : files) as { title: string }[];
  return list[0]!.title;
}

describe("#300 Slack file-upload title", () => {
  it("redacts a secret in the summary used as the uploaded file's title", async () => {
    const fsx = memFs();
    const clock = () => new Date("2026-10-01T00:00:00.000Z");
    const { fetchImpl, calls } = slack();
    const deliver = subsystemSlackDeliver({
      botToken: "xoxb-EXAMPLE-fake", channel: "C-TEST", sourceLabel: "vm", fetchImpl,
      delivered: new SeenStore("/del.jsonl", fsx, clock), attempted: new SeenStore("/att.jsonl", fsx, clock),
      outboundSeen: new SeenStore("/seen.jsonl", fsx, clock),
      readLocalImage: (p) => (p === "/tmp/shot.png" ? { bytes: new Uint8Array(16), filename: "shot.png" } : null),
      log: () => {},
    });
    const out = await deliver({
      kind: "outbound_decision", decisionId: "d-300", op: "post_message", entityBindingRef: "mike#slack",
      payload: { qitemId: "q-300", summary: `rotate ${SECRET} today`, body: "b", destinationSession: "mike@external",
        sourceSession: "dev-driver@v-openrig-build", evidenceRef: "/tmp/shot.png" },
    });
    expect(out.ok).toBe(true);
    const text = calls.find((c) => c.url.endsWith("chat.postMessage"))!.body;
    const complete = calls.find((c) => c.url.endsWith("files.completeUploadExternal"))!.body;
    expect(text).not.toContain(SECRET); // the message text was already redacted
    const title = uploadedTitle(complete);
    expect(title).not.toContain(SECRET);
    expect(title).toBe("rotate [redacted-secret] today");
  });
});
