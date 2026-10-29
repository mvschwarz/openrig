import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HistoryQuery, extractKeywords, type ExecDep } from "../src/domain/history-query.js";

describe("HistoryQuery", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "history-query-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("extractKeywords", () => {
    it("splits question, filters stop words and short words, escapes regex", () => {
      const kw = extractKeywords("What is the deployment strategy?");
      // "What" => stop word, "is" => stop word, "the" => stop word
      expect(kw).toContain("deployment");
      expect(kw).toContain("strategy");
      expect(kw).not.toContain("What");
      expect(kw).not.toContain("is");
      expect(kw).not.toContain("the");
    });

    it("filters words shorter than 3 chars", () => {
      const kw = extractKeywords("go to db and fix it");
      // "go" = 2 chars, "to" = 2 chars, "db" = 2 chars, "it" = 2 chars
      // "and" is a stop word, "fix" stays
      expect(kw).toContain("fix");
      expect(kw).not.toContain("go");
      expect(kw).not.toContain("to");
      expect(kw).not.toContain("db");
    });

    it("regex-escapes special characters", () => {
      const kw = extractKeywords("search for file.ts and (pattern)");
      const escaped = kw.find((k) => k.includes("file"));
      expect(escaped).toBe("file\\.ts");
      const parenEscaped = kw.find((k) => k.includes("pattern"));
      expect(parenEscaped).toBe("\\(pattern\\)");
    });

    it("returns empty array for all-stop-word questions", () => {
      const kw = extractKeywords("what is the");
      expect(kw).toEqual([]);
    });

    it("deduplicates keywords", () => {
      const kw = extractKeywords("deploy deploy deploy strategy");
      const deployCount = kw.filter((k) => k === "deploy").length;
      expect(deployCount).toBe(1);
    });
  });

  describe("search", () => {
    it("searches transcripts with rg backend", async () => {
      const rigDir = join(tmpDir, "my-rig");
      mkdirSync(rigDir, { recursive: true });
      writeFileSync(join(rigDir, "dev-impl.log"), "line1 deployment started\nline2 nothing\nline3 deployment done\n");

      const exec: ExecDep = vi.fn(async (_cmd: string, _args: string[]) => ({
        stdout: "line1 deployment started\nline3 deployment done\n",
        exitCode: 0,
      }));

      const hq = new HistoryQuery({ transcriptsRoot: tmpDir, exec });
      const result = await hq.search("my-rig", "what about deployment?");

      expect(result.backend).toBe("rg");
      expect(result.excerpts.length).toBeGreaterThan(0);
      expect(exec).toHaveBeenCalled();
      const call = (exec as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(call[0]).toBe("rg");
    });

    it("falls back to grep when rg exits with code >= 2 (not found)", async () => {
      const rigDir = join(tmpDir, "my-rig");
      mkdirSync(rigDir, { recursive: true });
      writeFileSync(join(rigDir, "session.log"), "test error handling\n");

      let callCount = 0;
      const exec: ExecDep = vi.fn(async (cmd: string, _args: string[]) => {
        callCount++;
        if (callCount === 1) {
          // rg fails with exit code 2 (error)
          expect(cmd).toBe("rg");
          return { stdout: "", exitCode: 2 };
        }
        // grep fallback
        expect(cmd).toBe("grep");
        return { stdout: "test error handling\n", exitCode: 0 };
      });

      const hq = new HistoryQuery({ transcriptsRoot: tmpDir, exec });
      const result = await hq.search("my-rig", "error handling");

      expect(result.backend).toBe("grep");
      expect(callCount).toBe(2);
    });

    it("returns no excerpts when rg exit code 1 (no matches)", async () => {
      const rigDir = join(tmpDir, "my-rig");
      mkdirSync(rigDir, { recursive: true });
      writeFileSync(join(rigDir, "session.log"), "unrelated content\n");

      const exec: ExecDep = vi.fn(async () => ({
        stdout: "",
        exitCode: 1,
      }));

      const hq = new HistoryQuery({ transcriptsRoot: tmpDir, exec });
      const result = await hq.search("my-rig", "deployment strategy");

      expect(result.excerpts).toEqual([]);
      expect(result.insufficient).toBe(true);
    });

    it("returns insufficient for empty keywords", async () => {
      const rigDir = join(tmpDir, "my-rig");
      mkdirSync(rigDir, { recursive: true });

      const exec: ExecDep = vi.fn();

      const hq = new HistoryQuery({ transcriptsRoot: tmpDir, exec });
      const result = await hq.search("my-rig", "what is the");

      expect(result.insufficient).toBe(true);
      expect(result.excerpts).toEqual([]);
      expect(exec).not.toHaveBeenCalled();
    });

    it("returns insufficient when transcript directory does not exist", async () => {
      const exec: ExecDep = vi.fn();

      const hq = new HistoryQuery({ transcriptsRoot: tmpDir, exec });
      const result = await hq.search("nonexistent-rig", "some query");

      expect(result.insufficient).toBe(true);
      expect(result.noTranscriptDir).toBe(true);
      expect(exec).not.toHaveBeenCalled();
    });

    it("reports a listing error rather than no history when the directory became a file", async () => {
      writeFileSync(join(tmpDir, "replaced-rig"), "not a transcript directory");
      const exec: ExecDep = vi.fn(async () => ({ stdout: "", exitCode: 2 }));
      const hq = new HistoryQuery({ transcriptsRoot: tmpDir, exec });
      expect(await hq.search("replaced-rig", "deployment strategy")).toMatchObject({
        backend: "none", insufficient: true, excerpts: [], error: expect.stringContaining("could not be listed"),
      });
      expect(exec).toHaveBeenCalledTimes(1);
    });

    it("uses native reading on Windows, otherwise reports both failed tools", async () => {
      const rigDir = join(tmpDir, "my-rig");
      mkdirSync(rigDir, { recursive: true });
      writeFileSync(join(rigDir, "dev.log"), "some content\n");

      const exec: ExecDep = vi.fn(async () => ({ stdout: "", exitCode: 2 }));

      const hq = new HistoryQuery({ transcriptsRoot: tmpDir, exec });
      const result = await hq.search("my-rig", "deployment strategy");

      expect(result.insufficient).toBe(true);
      expect(result.backend).toBe(process.platform === "win32" ? "read" : "none");
      if (process.platform !== "win32") expect(result.error).toContain("both failed");
    });

    it("strips ANSI from excerpts", async () => {
      const rigDir = join(tmpDir, "my-rig");
      mkdirSync(rigDir, { recursive: true });
      writeFileSync(join(rigDir, "session.log"), "content\n");

      const exec: ExecDep = vi.fn(async () => ({
        stdout: "\x1b[1mdeployment\x1b[0m started\n\x1b[32mdeployment\x1b[0m finished\n",
        exitCode: 0,
      }));

      const hq = new HistoryQuery({ transcriptsRoot: tmpDir, exec });
      const result = await hq.search("my-rig", "deployment status");

      for (const excerpt of result.excerpts) {
        expect(excerpt).not.toContain("\x1b[");
      }
      expect(result.excerpts).toContain("deployment started");
      expect(result.excerpts).toContain("deployment finished");
    });
  });
});
