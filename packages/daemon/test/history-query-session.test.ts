import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HistoryQuery } from "../src/domain/history-query.js";

const throwExec = async () => {
  throw new Error("must not shell out when the session file is absent");
};

describe("HistoryQuery.searchSession — per-session JSONL by token (L2)", () => {
  let projectsRoot: string;
  beforeEach(() => {
    projectsRoot = mkdtempSync(join(tmpdir(), "rigask-proj-"));
  });
  afterEach(() => {
    rmSync(projectsRoot, { recursive: true, force: true });
  });

  function writeSessionJsonl(encodedCwd: string, token: string, lines: string[]): void {
    const dir = join(projectsRoot, encodedCwd);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${token}.jsonl`), lines.join("\n") + "\n", "utf-8");
  }

  it("locates the session JSONL by token (under any encoded-cwd dir) and returns content hits", async () => {
    const token = "abc-123-session";
    writeSessionJsonl("-Users-me-proj", token, [
      JSON.stringify({ type: "user", text: "deploy the gateway" }),
      JSON.stringify({ type: "assistant", text: "the SECRET_MARKER lives here" }),
    ]);

    // exec stands in for rg/grep — assert it is invoked against the LOCATED file,
    // and that its output is parsed into excerpts.
    const execSpy = vi.fn(async () => ({
      stdout: '{"type":"assistant","text":"the SECRET_MARKER lives here"}\n',
      exitCode: 0,
    }));

    const hq = new HistoryQuery({ transcriptsRoot: "/unused", exec: execSpy, claudeProjectsRoot: projectsRoot });
    const res = await hq.searchSession(token, "SECRET_MARKER");

    expect(res.found).toBe(true);
    expect(res.token).toBe(token);
    expect(res.excerpts.some((e) => e.includes("SECRET_MARKER"))).toBe(true);
    expect(res.insufficient).toBe(false);
    // exec ran against the located <token>.jsonl file
    expect(execSpy).toHaveBeenCalled();
    const argv = execSpy.mock.calls[0]![1] as string[];
    expect(argv.some((a) => a.endsWith(`${token}.jsonl`))).toBe(true);
  });

  it("honest not-found (session_not_found) when the token has no session file", async () => {
    const hq = new HistoryQuery({ transcriptsRoot: "/unused", exec: throwExec, claudeProjectsRoot: projectsRoot });
    const res = await hq.searchSession("nonexistent-token", "anything");

    expect(res.found).toBe(false);
    expect(res.degraded?.reason).toBe("session_not_found");
    expect(res.degraded?.message).toMatch(/token/i);
    expect(res.insufficient).toBe(true);
  });
});
