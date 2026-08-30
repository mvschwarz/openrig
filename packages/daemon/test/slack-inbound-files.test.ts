// OPR.0.5.6.2 — inbound images/files: the deferred half of images-both-ways.
// The T1076 seam cleanly IGNORES file-bearing events (ingestDecision rejects
// subtype file_share, then files[]), so a human dropping an image into a mapped
// thread today produces NO row at all. These pins commit the contract: the
// reply row lands carrying our downloaded workspace-local copy by LOCAL path
// (never a Slack URL — ToS: Slack owns nothing), download failure is honest and
// named (never a silent drop of message or file), multiple files stay
// individually attributable, unmapped threads ride slice 10's unrouted-signal
// path with the file included, and loop safety (bot posts, edit subtypes) is
// unchanged. RED at base: the row-landing pins fail at the admission layer.
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { InboundRouter, ingestDecision, handleEnvelope, type SlackEvent } from "../src/domain/gateway/slack/inbound.js";
import { SeenStore, DeadLetterStore } from "../src/domain/gateway/slack/state-store.js";
import { makeThreadRouteResolver } from "../src/domain/gateway/slack/thread-routing.js";
import { makeInboundFilePort } from "../src/domain/gateway/slack/slack-subsystem.js";

const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 1, 2, 3, 4]);
const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 9, 9, 9]);
const MEDIA_DIR = "/media/slack-inbound";

function memFs() {
  const files = new Map<string, string>();
  return {
    files,
    readFileSync: (p: string) => { const v = files.get(p); if (v === undefined) throw new Error("ENOENT"); return v; },
    existsSync: (p: string) => files.has(p),
    writeFileSync: (p: string, d: string) => { files.set(p, d); },
    appendFileSync: (p: string, d: string) => { files.set(p, (files.get(p) ?? "") + d); },
    rename: (a: string, b: string) => { files.set(b, files.get(a) ?? ""); files.delete(a); },
    mkdirp: () => {},
  };
}
const clock = () => new Date("2026-08-30T01:40:00Z");

/** Stubbed Slack transport: url -> bytes (or an induced failure). */
function stubFetch(routes: Record<string, Uint8Array | { status: number } | { html: true }>) {
  const seenAuth: string[] = [];
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    seenAuth.push(String((init?.headers as Record<string, string> | undefined)?.["authorization"] ?? ""));
    const hit = routes[url];
    if (hit === undefined) return new Response("not found", { status: 404 });
    if (hit instanceof Uint8Array) return new Response(hit.slice().buffer as ArrayBuffer, { status: 200, headers: { "content-type": "application/octet-stream" } });
    if ("html" in hit) return new Response("<html>login</html>", { status: 200, headers: { "content-type": "text/html" } });
    return new Response("err", { status: hit.status });
  };
  return { fetchImpl, seenAuth };
}

interface Landed { source: string; destination: string; tags?: string[]; summary: string; body: string }

function harness(opts?: {
  routes?: Record<string, Uint8Array | { status: number } | { html: true }>;
  mapped?: Record<string, string>;
}) {
  const fs = memFs();
  const rows: Landed[] = [];
  const logs: string[] = [];
  const media = new Map<string, Uint8Array>();
  const { fetchImpl, seenAuth } = stubFetch(opts?.routes ?? {});
  const filePort = makeInboundFilePort({
    token: "xoxb-test-token",
    mediaDir: MEDIA_DIR,
    fetchImpl,
    mkdirp: () => {},
    writeFile: (p: string, bytes: Uint8Array) => { media.set(p, bytes); },
    log: (m: string) => logs.push(m),
  });
  const threadMap = {
    resolveByThread: (threadTs: string) => (opts?.mapped?.[threadTs] ? { seat: opts.mapped[threadTs]!, state: "open" } : null),
  } as never;
  const router = new InboundRouter({
    queue: { createQitem: async (input: Landed) => { rows.push(input); return `qitem-f-${rows.length}`; } },
    seen: new SeenStore("/s.jsonl", fs, clock),
    deadLetter: new DeadLetterStore<SlackEvent>("/d.jsonl", fs, clock),
    destination: "operator-agent@kernel",
    resolveSender: () => ({ admitted: true, source: "founder@humans" }),
    resolveRoute: makeThreadRouteResolver({
      map: threadMap,
      unroutedDestination: "orch-lead@v-openrig-build",
      log: (m: string) => logs.push(m),
    }),
    files: filePort,
    log: (m: string) => logs.push(m),
  } as never);
  return { router, rows, media, logs, seenAuth };
}

/** The OUTERMOST real entry: Socket envelope -> fast-ack -> ingestDecision ->
 *  route. Row pins ride THIS path so an admission regression can never hide
 *  behind a direct route() call. */
async function deliver(h: ReturnType<typeof harness>, ev: SlackEvent): Promise<void> {
  await handleEnvelope({ envelope_id: "env-1", type: "events_api", payload: { event: ev } }, () => {}, h.router);
}

const F_IMG = { id: "F1", name: "whiteboard sketch.png", mimetype: "image/png", url_private: "https://files.slack.com/files-pri/T1-F1/sketch.png" };
const F_PDF = { id: "F2", name: "notes.pdf", mimetype: "application/pdf", url_private: "https://files.slack.com/files-pri/T1-F2/notes.pdf" };

const fileEvent = (over?: Partial<SlackEvent>): SlackEvent => ({
  type: "message",
  subtype: "file_share",
  user: "U1",
  text: "",
  ts: "500.1",
  channel: "C1",
  thread_ts: "400.0",
  files: [F_IMG],
  ...over,
});

describe("inbound files: admission (the T1076 seam replaced)", () => {
  it("a file_share message with files is ADMITTED (the motivating class)", () => {
    expect(ingestDecision(fileEvent()).ingest).toBe(true);
  });
  it("a file-only message with empty text is admitted (a pure drop has no caption)", () => {
    expect(ingestDecision(fileEvent({ text: "" })).ingest).toBe(true);
  });
  it("loop safety unchanged: a BOT file post is still rejected", () => {
    const d = ingestDecision(fileEvent({ bot_id: "B9" }));
    expect(d.ingest).toBe(false);
    if (!d.ingest) expect(d.reason).toBe("bot_id");
  });
  it("non-file subtypes are still rejected (message_changed)", () => {
    const d = ingestDecision({ type: "message", subtype: "message_changed", user: "U1", text: "edit", ts: "1.1", channel: "C1" });
    expect(d.ingest).toBe(false);
    if (!d.ingest) expect(d.reason).toBe("subtype");
  });
});

describe("inbound files: the row carries our local copy, never Slack's URL", () => {
  it("single image into a MAPPED thread: row lands with a local path whose bytes hash-match the original", async () => {
    const h = harness({
      routes: { [F_IMG.url_private]: PNG_BYTES },
      mapped: { "400.0": "dev50-driver@v-openrig-build" },
    });
    await deliver(h, fileEvent());
    expect(h.rows, "the reply row must land (RED: admission ignores file events today)").toHaveLength(1);
    const body = h.rows[0]!.body;
    const stored = [...h.media.keys()];
    expect(stored, "exactly one media file stored").toHaveLength(1);
    expect(stored[0]!.startsWith(MEDIA_DIR + "/"), "stored INSIDE the media dir").toBe(true);
    expect(body, "the row references the local path").toContain(stored[0]!);
    expect(sha(h.media.get(stored[0]!)!), "bytes hash-match the original").toBe(sha(PNG_BYTES));
    expect(h.seenAuth.some((a) => a === "Bearer xoxb-test-token"), "download authenticated with the bot token").toBe(true);
  });

  it("multiple files stay individually attributable; image+text preserves the text", async () => {
    const h = harness({
      routes: { [F_IMG.url_private]: PNG_BYTES, [F_PDF.url_private]: PDF_BYTES },
      mapped: { "400.0": "dev50-driver@v-openrig-build" },
    });
    await deliver(h, fileEvent({ text: "see attached, both of them", files: [F_IMG, F_PDF] }));
    expect(h.rows).toHaveLength(1);
    const body = h.rows[0]!.body;
    expect(body).toContain("see attached, both of them");
    const stored = [...h.media.keys()];
    expect(stored).toHaveLength(2);
    for (const p of stored) expect(body).toContain(p);
    expect(sha(h.media.get(stored.find((p) => p.includes("notes"))!)!)).toBe(sha(PDF_BYTES));
  });

  it("non-image files ride the same mechanics", async () => {
    const h = harness({ routes: { [F_PDF.url_private]: PDF_BYTES }, mapped: { "400.0": "x@y" } });
    await deliver(h, fileEvent({ files: [F_PDF] }));
    expect(h.rows).toHaveLength(1);
    expect([...h.media.keys()]).toHaveLength(1);
  });

  it("ABSENCE: no produced row ever references a Slack URL in any form", async () => {
    const h = harness({
      routes: { [F_IMG.url_private]: PNG_BYTES, [F_PDF.url_private]: PDF_BYTES },
      mapped: { "400.0": "x@y" },
    });
    await deliver(h, fileEvent({ text: "one", files: [F_IMG], ts: "500.1" }));
    await deliver(h, fileEvent({ text: "two", files: [F_IMG, F_PDF], ts: "500.2" }));
    await deliver(h, fileEvent({ text: "three", files: [F_PDF], ts: "500.3" }));
    expect(h.rows.length, "the sweep is only meaningful over landed rows").toBeGreaterThanOrEqual(3);
    for (const row of h.rows) {
      const joined = `${row.summary}\n${row.body}`;
      // presence half: every file-bearing row carries at least one local copy
      expect([...h.media.keys()].some((p) => joined.includes(p)), "each row carries a local media path").toBe(true);
      expect(joined).not.toMatch(/url_private/);
      expect(joined).not.toMatch(/files\.slack\.com|slack\.com\/files|hooks\.slack\.com/);
      expect(joined, "the bot token never reaches a row").not.toContain("xoxb-test-token");
    }
  });
});

describe("inbound files: failure honesty (never a silent drop)", () => {
  it("an induced download failure lands the row with the text AND a named per-file failure; the healthy sibling still stores", async () => {
    const h = harness({
      routes: { [F_IMG.url_private]: { status: 403 }, [F_PDF.url_private]: PDF_BYTES },
      mapped: { "400.0": "x@y" },
    });
    await deliver(h, fileEvent({ text: "the message must survive", files: [F_IMG, F_PDF] }));
    expect(h.rows, "the message NEVER vanishes because a transfer failed").toHaveLength(1);
    const body = h.rows[0]!.body;
    expect(body).toContain("the message must survive");
    expect(body, "the failure is NAMED, per file").toMatch(/file transfer failed/i);
    expect(body).toContain("whiteboard sketch.png");
    expect([...h.media.keys()], "the healthy file still stored (individually attributable)").toHaveLength(1);
    expect(body).toContain([...h.media.keys()][0]!);
    expect(body).not.toMatch(/url_private|files\.slack\.com/);
  });

  it("an auth failure disguised as HTML is detected and named, not stored as garbage", async () => {
    const h = harness({ routes: { [F_IMG.url_private]: { html: true } }, mapped: { "400.0": "x@y" } });
    await deliver(h, fileEvent());
    expect(h.rows).toHaveLength(1);
    expect(h.rows[0]!.body).toMatch(/file transfer failed/i);
    expect([...h.media.keys()], "an HTML login page is never stored as the file").toHaveLength(0);
  });
});

describe("inbound files: unmapped threads reuse the slice-10 unrouted-signal path, file included", () => {
  it("a file event on an UNMAPPED thread routes to the unrouted destination with the unrouted-signal tag and still carries the attachment", async () => {
    const h = harness({ routes: { [F_IMG.url_private]: PNG_BYTES }, mapped: {} });
    await deliver(h, fileEvent({ thread_ts: "999.9" }));
    expect(h.rows).toHaveLength(1);
    const row = h.rows[0]!;
    expect(row.destination).toBe("orch-lead@v-openrig-build");
    expect(row.tags ?? [], "slice 10's unrouted-signal tag, no file special-case").toContain("unrouted-signal");
    expect([...h.media.keys()]).toHaveLength(1);
    expect(row.body).toContain([...h.media.keys()][0]!);
  });
});
