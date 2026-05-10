// V1 pre-release CLI/daemon Item 1 — transcript rotation contract.
//
// Covers the new capture-pane periodic-overwrite mechanism that replaced
// the legacy pipe-pane infinite-growth file pattern.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  startTranscriptRotation,
  stopTranscriptRotation,
  getActiveRotationCount,
  getTranscriptRotationOptionsFromEnv,
  clearAllTranscriptRotationsForTest,
  DEFAULT_TRANSCRIPT_LINES,
  DEFAULT_TRANSCRIPT_POLL_INTERVAL_MS,
} from "../src/domain/transcript-rotation.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

interface FakeAdapter {
  capturePaneContent: ReturnType<typeof vi.fn>;
  /** rest of TmuxAdapter is unused by rotation; cast at call site. */
}

function makeFakeAdapter(captureValue: string | null = "captured-content"): FakeAdapter {
  return {
    capturePaneContent: vi.fn(async () => captureValue),
  };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "transcript-rotation-"));
});

afterEach(() => {
  clearAllTranscriptRotationsForTest();
  if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
  // Clear env var overrides set by individual tests.
  delete process.env.OPENRIG_TRANSCRIPTS_LINES;
  delete process.env.OPENRIG_TRANSCRIPTS_POLL_INTERVAL_SECONDS;
});

describe("startTranscriptRotation — capture-pane invocation contract", () => {
  it("calls tmuxAdapter.capturePaneContent with sessionName + lines on first tick", async () => {
    const adapter = makeFakeAdapter("hello\nworld\n");
    const outputPath = path.join(tmpDir, "rig", "session.log");
    startTranscriptRotation(
      adapter as unknown as TmuxAdapter,
      "session@rig",
      outputPath,
      { lines: 500, pollIntervalMs: 60_000 },
    );
    // First tick is async; allow microtasks to flush.
    await new Promise((r) => setImmediate(r));
    expect(adapter.capturePaneContent).toHaveBeenCalledWith("session@rig", 500);
    stopTranscriptRotation("session@rig");
  });

  it("writes the captured content to the output path atomically", async () => {
    const adapter = makeFakeAdapter("line1\nline2\nline3\n");
    const outputPath = path.join(tmpDir, "rig", "session.log");
    startTranscriptRotation(
      adapter as unknown as TmuxAdapter,
      "session@rig",
      outputPath,
      { lines: 1000, pollIntervalMs: 60_000 },
    );
    await new Promise((r) => setImmediate(r));
    expect(fs.existsSync(outputPath)).toBe(true);
    expect(fs.readFileSync(outputPath, "utf8")).toBe("line1\nline2\nline3\n");
    // Partial-write tmp file must NOT remain after rename.
    const dirEntries = fs.readdirSync(path.dirname(outputPath));
    expect(dirEntries.filter((e) => e.includes(".tmp."))).toEqual([]);
    stopTranscriptRotation("session@rig");
  });

  it("overwrites the file each tick rather than appending (bounded size)", async () => {
    const adapter = makeFakeAdapter("first-tick");
    const outputPath = path.join(tmpDir, "rig", "session.log");
    startTranscriptRotation(
      adapter as unknown as TmuxAdapter,
      "session@rig",
      outputPath,
      { lines: 1000, pollIntervalMs: 60_000 },
    );
    await new Promise((r) => setImmediate(r));
    // Swap the adapter return value and trigger a fresh start (idempotent
    // replace). The rewrite path must replace, not append.
    adapter.capturePaneContent.mockResolvedValueOnce("second-tick");
    startTranscriptRotation(
      adapter as unknown as TmuxAdapter,
      "session@rig",
      outputPath,
      { lines: 1000, pollIntervalMs: 60_000 },
    );
    await new Promise((r) => setImmediate(r));
    // File holds the second tick's content only — no concatenation of
    // first + second.
    expect(fs.readFileSync(outputPath, "utf8")).toBe("second-tick");
    stopTranscriptRotation("session@rig");
  });

  it("silently skips the write when capturePaneContent returns null", async () => {
    const adapter = makeFakeAdapter(null);
    const outputPath = path.join(tmpDir, "rig", "session.log");
    startTranscriptRotation(
      adapter as unknown as TmuxAdapter,
      "session@rig",
      outputPath,
      { lines: 1000, pollIntervalMs: 60_000 },
    );
    await new Promise((r) => setImmediate(r));
    expect(fs.existsSync(outputPath)).toBe(false);
    stopTranscriptRotation("session@rig");
  });
});

describe("startTranscriptRotation — timer lifecycle", () => {
  it("registers exactly one active timer per session and replaces on second start", () => {
    const adapter = makeFakeAdapter();
    const outputPath = path.join(tmpDir, "rig", "session.log");
    expect(getActiveRotationCount()).toBe(0);
    startTranscriptRotation(
      adapter as unknown as TmuxAdapter,
      "session@rig",
      outputPath,
      { lines: 1000, pollIntervalMs: 60_000 },
    );
    expect(getActiveRotationCount()).toBe(1);
    startTranscriptRotation(
      adapter as unknown as TmuxAdapter,
      "session@rig",
      outputPath,
      { lines: 1000, pollIntervalMs: 60_000 },
    );
    expect(getActiveRotationCount()).toBe(1);
    stopTranscriptRotation("session@rig");
    expect(getActiveRotationCount()).toBe(0);
  });

  it("stopTranscriptRotation is a safe no-op when no timer is registered", () => {
    expect(getActiveRotationCount()).toBe(0);
    stopTranscriptRotation("never-started@rig");
    expect(getActiveRotationCount()).toBe(0);
  });

  it("tracks separate timers for separate sessions", () => {
    const adapter = makeFakeAdapter();
    startTranscriptRotation(
      adapter as unknown as TmuxAdapter,
      "a@rig",
      path.join(tmpDir, "a.log"),
      { lines: 1000, pollIntervalMs: 60_000 },
    );
    startTranscriptRotation(
      adapter as unknown as TmuxAdapter,
      "b@rig",
      path.join(tmpDir, "b.log"),
      { lines: 1000, pollIntervalMs: 60_000 },
    );
    expect(getActiveRotationCount()).toBe(2);
    stopTranscriptRotation("a@rig");
    expect(getActiveRotationCount()).toBe(1);
    stopTranscriptRotation("b@rig");
    expect(getActiveRotationCount()).toBe(0);
  });
});

describe("getTranscriptRotationOptionsFromEnv — env override + defaults", () => {
  it("returns the documented defaults when no env vars are set", () => {
    const opts = getTranscriptRotationOptionsFromEnv();
    expect(opts.lines).toBe(DEFAULT_TRANSCRIPT_LINES);
    expect(opts.pollIntervalMs).toBe(DEFAULT_TRANSCRIPT_POLL_INTERVAL_MS);
    expect(opts.lines).toBe(1000);
    expect(opts.pollIntervalMs).toBe(2000);
  });

  it("honors OPENRIG_TRANSCRIPTS_LINES + OPENRIG_TRANSCRIPTS_POLL_INTERVAL_SECONDS overrides", () => {
    process.env.OPENRIG_TRANSCRIPTS_LINES = "500";
    process.env.OPENRIG_TRANSCRIPTS_POLL_INTERVAL_SECONDS = "5";
    const opts = getTranscriptRotationOptionsFromEnv();
    expect(opts.lines).toBe(500);
    expect(opts.pollIntervalMs).toBe(5000);
  });

  it("rejects non-positive / non-numeric values and uses defaults", () => {
    process.env.OPENRIG_TRANSCRIPTS_LINES = "0";
    process.env.OPENRIG_TRANSCRIPTS_POLL_INTERVAL_SECONDS = "not-a-number";
    const opts = getTranscriptRotationOptionsFromEnv();
    expect(opts.lines).toBe(DEFAULT_TRANSCRIPT_LINES);
    expect(opts.pollIntervalMs).toBe(DEFAULT_TRANSCRIPT_POLL_INTERVAL_MS);
  });
});
