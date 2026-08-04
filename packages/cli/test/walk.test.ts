// Slice-03 Atom 6 (rig walk) — the pacing primitive. Drives the CLI command with
// an injected client (records /api/transport/send posts) + an injected sleep
// (records inter-piece delays), so the paced push-sequence is asserted without a
// real pane or real time.

import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { walkCommand, parsePaceMs, type WalkDeps } from "../src/commands/walk.js";
import { STATE_FILE, type LifecycleDeps, type DaemonState } from "../src/daemon-lifecycle.js";

function mockLifecycleDeps(): LifecycleDeps {
  return {
    spawn: vi.fn(() => ({ pid: 1, unref: vi.fn() }) as never),
    fetch: vi.fn(async () => ({ ok: true })),
    kill: vi.fn(() => true),
    readFile: vi.fn((p: string) =>
      p === STATE_FILE
        ? JSON.stringify({ pid: 123, port: 7777, db: "test.sqlite", startedAt: "2026-05-04T00:00:00Z" } as DaemonState)
        : null),
    writeFile: vi.fn(),
    removeFile: vi.fn(),
    exists: vi.fn((p: string) => p === STATE_FILE),
    mkdirp: vi.fn(),
    openForAppend: vi.fn(() => 3),
    isProcessAlive: vi.fn(() => true),
  };
}

interface RecordedSend { path: string; body: Record<string, unknown> }

function testDeps(sends: RecordedSend[], sleeps: number[], sendStatus = 200): WalkDeps {
  return {
    lifecycleDeps: mockLifecycleDeps(),
    clientFactory: () => ({
      post: async (path: string, body: unknown) => {
        sends.push({ path, body: body as Record<string, unknown> });
        return { status: sendStatus, data: sendStatus >= 400 ? { error: "Session not found" } : { verified: true } };
      },
    }) as never,
    sleep: async (ms: number) => { sleeps.push(ms); },
  };
}

function makeCmd(deps: WalkDeps): Command {
  const prog = new Command();
  prog.exitOverride();
  prog.addCommand(walkCommand(deps));
  return prog;
}

function tmpFile(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "walk-piece-"));
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
}

function captureLogs(fn: () => Promise<void>): Promise<{ logs: string[]; errLogs: string[]; exitCode: number | undefined }> {
  return new Promise(async (resolve) => {
    const logs: string[] = []; const errLogs: string[] = [];
    const origLog = console.log; const origErr = console.error; const origExit = process.exitCode;
    console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
    console.error = (...a: unknown[]) => { errLogs.push(a.map(String).join(" ")); };
    process.exitCode = undefined;
    try { await fn(); } catch { /* commander exitOverride */ }
    const exitCode = process.exitCode;
    console.log = origLog; console.error = origErr; process.exitCode = origExit;
    resolve({ logs, errLogs, exitCode });
  });
}

describe("parsePaceMs", () => {
  it("parses s / ms / bare-seconds and the default", () => {
    expect(parsePaceMs(undefined)).toBe(10_000);
    expect(parsePaceMs("10s")).toBe(10_000);
    expect(parsePaceMs("500ms")).toBe(500);
    expect(parsePaceMs("2")).toBe(2_000);
    expect(parsePaceMs("bogus")).toBeNull();
    expect(parsePaceMs("-1")).toBeNull();
  });
});

describe("rig walk — paced push-delivery (Atom 6)", () => {
  it("walks a seat through a local file list in order, one send per piece", async () => {
    const sends: RecordedSend[] = []; const sleeps: number[] = [];
    const a = tmpFile("a.md", "AAA"); const b = tmpFile("b.md", "BBB"); const c = tmpFile("c.md", "CCC");
    const { exitCode } = await captureLogs(async () => {
      await makeCmd(testDeps(sends, sleeps)).parseAsync(["node", "rig", "walk", "dev@rig", "--through", a, b, c, "--pace", "10s"]);
    });
    expect(exitCode).toBeUndefined();
    expect(sends).toHaveLength(3);
    expect(sends.every((s) => s.path === "/api/transport/send")).toBe(true);
    expect(sends.every((s) => s.body["session"] === "dev@rig")).toBe(true);
    expect(sends.map((s) => s.body["text"])).toEqual(["AAA", "BBB", "CCC"]);
  });

  it("paces BETWEEN pieces only (N-1 delays for N pieces, at the parsed interval)", async () => {
    const sends: RecordedSend[] = []; const sleeps: number[] = [];
    const a = tmpFile("a.md", "AAA"); const b = tmpFile("b.md", "BBB"); const c = tmpFile("c.md", "CCC");
    await captureLogs(async () => {
      await makeCmd(testDeps(sends, sleeps)).parseAsync(["node", "rig", "walk", "dev@rig", "--through", a, b, c, "--pace", "500ms"]);
    });
    // 3 pieces → 2 inter-piece pauses; never a trailing pause after the last.
    expect(sleeps).toEqual([500, 500]);
  });

  it("aborts the walk when a piece fails to send (does not keep pacing into a broken pane)", async () => {
    const sends: RecordedSend[] = []; const sleeps: number[] = [];
    const a = tmpFile("a.md", "AAA"); const b = tmpFile("b.md", "BBB");
    const { errLogs, exitCode } = await captureLogs(async () => {
      await makeCmd(testDeps(sends, sleeps, 502)).parseAsync(["node", "rig", "walk", "dev@rig", "--through", a, b, "--pace", "10s"]);
    });
    expect(exitCode).toBe(1);
    expect(sends).toHaveLength(1); // stopped after the first failure
    expect(sleeps).toEqual([]); // no pacing past the failure
    expect(errLogs.join("\n")).toMatch(/Session not found|failed/i);
  });

  it("rejects a malformed --pace before sending anything", async () => {
    const sends: RecordedSend[] = []; const sleeps: number[] = [];
    const a = tmpFile("a.md", "AAA");
    const { errLogs, exitCode } = await captureLogs(async () => {
      await makeCmd(testDeps(sends, sleeps)).parseAsync(["node", "rig", "walk", "dev@rig", "--through", a, "--pace", "soon"]);
    });
    expect(exitCode).toBe(1);
    expect(sends).toEqual([]);
    expect(errLogs.join("\n")).toMatch(/pace/i);
  });

  it("walks a seat through a REF's ordered pieces (resolved via the daemon by-ref/pieces route)", async () => {
    const sends: RecordedSend[] = []; const sleeps: number[] = []; const gets: string[] = [];
    const deps: WalkDeps = {
      lifecycleDeps: mockLifecycleDeps(),
      // A non-file --through arg is a context ref → resolved via the daemon.
      fileExists: () => false,
      clientFactory: () => ({
        get: async (path: string) => {
          gets.push(path);
          return { status: 200, data: { ref: "packs/onboarding", pieces: [
            { path: "intro.md", content: "INTRO" },
            { path: "steps.md", content: "STEPS" },
          ] } };
        },
        post: async (path: string, body: unknown) => { sends.push({ path, body: body as Record<string, unknown> }); return { status: 200, data: {} }; },
      }) as never,
      sleep: async (ms: number) => { sleeps.push(ms); },
    };
    const { exitCode } = await captureLogs(async () => {
      await makeCmd(deps).parseAsync(["node", "rig", "walk", "dev@rig", "--through", "packs/onboarding", "--pace", "10s"]);
    });
    expect(exitCode).toBeUndefined();
    expect(gets.some((g) => g.includes("/api/context-packs/library/by-ref/pieces?ref=") && g.includes(encodeURIComponent("packs/onboarding")))).toBe(true);
    expect(sends.map((s) => s.body["text"])).toEqual(["INTRO", "STEPS"]);
    expect(sleeps).toEqual([10_000]);
  });

  it("aborts a ref walk BEFORE any send when the pack has a missing/unreadable member (twin of the local-file abort contract)", async () => {
    const sends: RecordedSend[] = []; const sleeps: number[] = [];
    const deps: WalkDeps = {
      lifecycleDeps: mockLifecycleDeps(),
      fileExists: () => false,
      clientFactory: () => ({
        get: async () => ({ status: 200, data: {
          ref: "packs/broken",
          pieces: [{ path: "present.md", content: "PRESENT" }],
          missingFiles: [{ path: "gone.md", role: "proof" }],
        } }),
        post: async (path: string, body: unknown) => { sends.push({ path, body: body as Record<string, unknown> }); return { status: 200, data: {} }; },
      }) as never,
      sleep: async (ms: number) => { sleeps.push(ms); },
    };
    const { errLogs, exitCode } = await captureLogs(async () => {
      await makeCmd(deps).parseAsync(["node", "rig", "walk", "dev@rig", "--through", "packs/broken", "--pace", "10s"]);
    });
    expect(exitCode).toBe(1);
    expect(sends).toEqual([]); // ZERO pieces sent — no partial walk
    expect(sleeps).toEqual([]);
    expect(errLogs.join("\n")).toMatch(/gone\.md/); // names the missing member
    expect(errLogs.join("\n")).toMatch(/missing|incomplete|partial/i);
  });
});
