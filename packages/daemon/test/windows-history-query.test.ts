import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { HistoryQuery } from "../src/domain/history-query.js";

describe.skipIf(process.platform !== "win32")("history without external search tools", () => {
  it("reads actual Unicode/CRLF logs and session JSONL, and reports read failure", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openrig-history-native-"));
    try {
      await mkdir(path.join(root, "rig"));
      await mkdir(path.join(root, "projects", "cwd"), { recursive: true });
      await writeFile(path.join(root, "rig", "seat.log"), "unrelated\r\n\u001b[32m部署 日本語 matched\u001b[0m\r\nlast matched");
      await writeFile(path.join(root, "projects", "cwd", "session.jsonl"), JSON.stringify({ message: "matched " + "🙂".repeat(200) }) + "\r\n");
      const query = new HistoryQuery({ transcriptsRoot: root, claudeProjectsRoot: path.join(root, "projects"), exec: async () => ({ stdout: "", exitCode: 2 }) });
      expect(await query.search("rig", "matched")).toMatchObject({ backend: "read", insufficient: false, excerpts: ["部署 日本語 matched", "last matched"] });
      const session = await query.searchSession("session", "matched");
      expect(session).toMatchObject({ backend: "read", found: true, insufficient: false });
      expect(session.excerpts[0]!.length).toBeLessThanOrEqual(241);
      expect(session.excerpts[0]).toMatch(/…$/);
      await mkdir(path.join(root, "projects", "cwd", "unreadable.jsonl"));
      expect(await query.searchSession("unreadable", "matched")).toMatchObject({ backend: "none", found: true, insufficient: true, degraded: { reason: "unreadable" } });
    } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
  });
});
