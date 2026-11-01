// A hosted member's last call, as `rig mcp serve --http` records it: once per seat per interval, by atomic rename, at mode
// 0600, beside the token file. A missing or unreadable record is unknown (an empty map), and a write that fails never
// reaches the caller.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mcpPresenceFilePath, presenceRecorder, readPresence } from "../src/mcp-presence.js";

describe("a hosted member's last call", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-presence-")); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("is recorded once per seat per interval, each seat on its own, at mode 0600", () => {
    const file = mcpPresenceFilePath(dir);
    expect(file).toBe(path.join(dir, "mcp-http-presence.json"));
    let now = Date.parse("2026-10-26T12:00:00.000Z");
    const record = presenceRecorder(file, 60_000, () => now);
    record("grok@lab", "grok");
    now += 30_000;
    record("grok@lab", "grok"); // inside the interval: not written
    record("chatgpt@lab", "chatgpt");
    expect(readPresence(file)).toEqual({
      "grok@lab": { grant: "grok", lastCallAt: "2026-10-26T12:00:00.000Z" },
      "chatgpt@lab": { grant: "chatgpt", lastCallAt: "2026-10-26T12:00:30.000Z" },
    });
    now += 31_000;
    record("grok@lab", "grok");
    expect(readPresence(file)["grok@lab"]!.lastCallAt).toBe("2026-10-26T12:01:01.000Z");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(dir)).toEqual(["mcp-http-presence.json"]);
  });

  it("reads as unknown when nothing was recorded or the file can't be read, and a failed write never throws", () => {
    expect(readPresence(path.join(dir, "absent.json"))).toEqual({});
    fs.writeFileSync(path.join(dir, "broken.json"), "{ not json");
    expect(readPresence(path.join(dir, "broken.json"))).toEqual({});
    fs.writeFileSync(path.join(dir, "odd.json"), JSON.stringify({ version: 1, seats: { "grok@lab": { lastCallAt: 7 } } }));
    expect(readPresence(path.join(dir, "odd.json"))).toEqual({});
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() => presenceRecorder(path.join(dir, "missing-dir", "presence.json"))("grok@lab", "grok")).not.toThrow();
      expect(log.mock.calls.flat().join(" ")).toContain("couldn't record grok@lab's call");
    } finally { log.mockRestore(); }
  });
});
