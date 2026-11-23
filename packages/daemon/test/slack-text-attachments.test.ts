import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { resolveSlackHandle } from "../src/domain/gateway/human-registry.js";
import { DEFAULT_CONFIG, loadConfig, saveConfig, staticReadiness } from "../src/domain/gateway/slack/config.js";
import { makeQueuePorts } from "../src/domain/gateway/slack/queue-access.js";
import { defaultReadLocalImage, LOCAL_ATTACHMENT_MAX_BYTES } from "../src/domain/gateway/slack/slack-delivery.js";
import { buildSlackGatewayWire } from "../src/domain/gateway/slack/slack-subsystem.js";

const human = "reader@external";
const registry = { ok: true as const, entities: [{ entityId: "reader", class: "human" as const, displayName: "Reader", address: human,
  connectorBindings: [{ kind: "slack" as const, connectorRef: "primary", secretsRef: "env:SLACK_BOT_TOKEN", role: "primary" as const, handle: "UREADER" }], prefs: { deliveryClass: "A" as const } }] };
const original = "# Notes\n你好, café\nToken: xoxb-EXAMPLE-secret\n";
const redacted = "# Notes\n你好, café\nToken: [redacted-secret]\n";
const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

describe("opt-in Slack text attachments", () => {
  let home: string;
  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), "slack-text-")); });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });
  const file = (name: string, body: string | Uint8Array = original) => {
    const filename = path.join(home, name);
    fs.writeFileSync(filename, body);
    return filename;
  };

  it("keeps existing config bytes and Markdown evidence pointers unchanged by default", () => {
    const configPath = saveConfig(DEFAULT_CONFIG, home);
    const before = fs.readFileSync(configPath, "utf8");
    expect(loadConfig(home)).not.toHaveProperty("textAttachmentExtensions");
    saveConfig(loadConfig(home), home);
    expect(fs.readFileSync(configPath, "utf8")).toBe(before);
    expect(defaultReadLocalImage(file("PROOF.md"))).toBeNull();
  });

  it("round-trips the selected extensions and reports them in Slack readiness", () => {
    saveConfig({ ...DEFAULT_CONFIG, textAttachmentExtensions: [".md", ".txt"] }, home);
    const cfg = loadConfig(home);
    expect(cfg.textAttachmentExtensions).toEqual([".md", ".txt"]);
    expect(staticReadiness(cfg, true, true).find((row) => row.label === "text-attachments"))
      .toMatchObject({ ok: true, detail: expect.stringContaining(".md, .txt") });
  });

  it.each([null, ".md", ["md"], [".exe"], [12]])("rejects malformed extension config on save and load: %j", (extensions) => {
    const cfg = { ...DEFAULT_CONFIG, textAttachmentExtensions: extensions } as never;
    expect(() => saveConfig(cfg, home)).toThrow(/textAttachmentExtensions/);
    expect(fs.existsSync(path.join(home, "slack-connector.json"))).toBe(false);
    file("slack-connector.json", JSON.stringify(cfg));
    expect(() => loadConfig(home)).toThrow(/textAttachmentExtensions/);
  });

  it.each([".md", ".txt", ".csv", ".json"])("uploads only opted-in %s files and redacts a copy of their UTF-8 bytes", (extension) => {
    const filename = file(`notes${extension.toUpperCase()}`);
    expect(defaultReadLocalImage(filename, [])).toBeNull();
    const result = defaultReadLocalImage(filename, [extension]);
    expect(result).toMatchObject({ filename: path.basename(filename) });
    expect(result && "bytes" in result && Buffer.from(result.bytes).toString("utf8")).toBe(redacted);
    expect(fs.readFileSync(filename, "utf8")).toBe(original);
    expect(defaultReadLocalImage("relative/notes" + extension, [extension])).toBeNull();
    expect(defaultReadLocalImage(file("other.log"), [extension])).toBeNull();
  });

  it("retains the regular-file, size and readable-text boundaries", () => {
    const big = file("large.txt", "");
    fs.truncateSync(big, LOCAL_ATTACHMENT_MAX_BYTES + 1);
    expect(defaultReadLocalImage(big, [".txt"])).toMatchObject({ skipped: expect.stringContaining("attachment cap") });
    fs.mkdirSync(path.join(home, "directory.txt"));
    expect(defaultReadLocalImage(path.join(home, "directory.txt"), [".txt"])).toEqual({ skipped: "not a regular file" });
    expect(defaultReadLocalImage(path.join(home, "missing.txt"), [".txt"])).toEqual({ skipped: "unreadable (ENOENT)" });
    expect(defaultReadLocalImage(file("invalid.txt", new Uint8Array([0xff, 0xfe])), [".txt"]))
      .toEqual({ skipped: "text attachment is not valid UTF-8" });
    // Media uploads keep their original bytes, even when text uploads are enabled.
    const image = file("image.png", original);
    const result = defaultReadLocalImage(image, [".txt"]);
    expect(result && "bytes" in result && Buffer.from(result.bytes).toString("utf8")).toBe(original);
  });

  it.each([false, true])("uses the saved opt-in through the real queue and Slack wire (enabled=%s)", async (enabled) => {
    const db = createDb();
    migrate(db, ALL_MIGRATIONS);
    const repo = new QueueRepository(db, new EventBus(db), { loadHumanRegistry: () => registry });
    const evidenceRef = file("PROOF.md");
    const secretsEnvFile = file("fake.env", "SLACK_BOT_TOKEN=xoxb-EXAMPLE-fake\n");
    saveConfig({ ...DEFAULT_CONFIG, enabled: true, channel: "CDEFAULT", secretsEnvFile,
      ...(enabled ? { textAttachmentExtensions: [".md"] } : {}) }, home);
    const calls: Array<{ url: string; body: unknown }> = [];
    const wire = buildSlackGatewayWire({
      home, queueRepo: repo, registry: { loadHumanRegistry: () => registry, resolveSlackHandle },
      fetchImpl: async (url, init) => {
        if (url.endsWith("chat.postMessage")) {
          calls.push({ url, body: JSON.parse(String(init?.body)) });
          return reply({ ok: true, ts: "1234.5" });
        }
        if (url.endsWith("files.getUploadURLExternal")) {
          calls.push({ url, body: Object.fromEntries(new URLSearchParams(String(init?.body))) });
          return reply({ ok: true, file_id: "FTEXT", upload_url: "https://files.slack.invalid/upload" });
        }
        if (url === "https://files.slack.invalid/upload") {
          calls.push({ url, body: Buffer.from(init?.body as Uint8Array).toString("utf8") });
          return new Response("ok");
        }
        if (url.endsWith("files.completeUploadExternal")) {
          calls.push({ url, body: Object.fromEntries(new URLSearchParams(String(init?.body))) });
          return reply({ ok: true });
        }
        throw new Error(`Unexpected test request: ${url}`);
      },
    });
    try {
      wire.startServices?.();
      const row = await repo.create({ sourceSession: "writer@fixture", destinationSession: human, summary: "Review notes", body: "Please review.", humanAlert: true, evidenceRef, nudge: false });
      const alert = (await makeQueuePorts(repo, { loadHumanRegistry: () => registry }).listHumanAlerts({})).find((item) => item.qitemId === row.qitemId);
      expect(alert).toBeDefined();
      expect(wire.dispatcher.dispatch("post_message", human, alert)).toMatchObject({ ok: true });
      await vi.waitFor(() => expect(repo.getById(row.qitemId)?.deliveryOutcome).toBe("posted"));
      if (enabled) {
        await vi.waitFor(() => expect(calls).toHaveLength(4));
        expect(calls[1]?.body).toEqual({ filename: "PROOF.md", length: String(Buffer.byteLength(redacted)) });
        expect(calls[2]?.body).toBe(redacted);
        expect(calls[3]?.body).toMatchObject({ channel_id: "CDEFAULT", thread_ts: "1234.5" });
      } else {
        expect(calls.map((call) => call.url)).toEqual(["https://slack.com/api/chat.postMessage"]);
      }
      expect(fs.readFileSync(evidenceRef, "utf8")).toBe(original);
    } finally {
      wire.stop();
      db.close();
    }
  });
});
