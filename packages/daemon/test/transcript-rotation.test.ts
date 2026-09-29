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
  getLastCaptureAt,
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
  vi.useRealTimers();
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

describe("startTranscriptRotation — unchanged-content write suppression (hotfix qitem-20260822222746-3a64ae43)", () => {
  // The 2s-cadence tick rewrote the transcript file unconditionally on every
  // tick; across hundreds of live seats macOS amplifies each rename through
  // fseventsd into a host CPU/RSS storm. Two byte-identical captures must
  // perform NO second temp-write/rename. Observed via inode stability: the
  // atomic rename replaces the file's inode, so an unchanged inode proves no
  // rewrite occurred — no fs mocking required.
  it("does NOT temp-write/rename when two successive captures are byte-identical (inode stable)", async () => {
    const adapter = makeFakeAdapter("stable-1\nstable-2\n");
    const outputPath = path.join(tmpDir, "rig", "session.log");

    startTranscriptRotation(
      adapter as unknown as TmuxAdapter,
      "session@rig",
      outputPath,
      { lines: 1000, pollIntervalMs: 60_000 },
    );
    await new Promise((r) => setImmediate(r));
    expect(fs.readFileSync(outputPath, "utf8")).toBe("stable-1\nstable-2\n");
    const inoAfterFirst = fs.statSync(outputPath).ino;

    // Second immediate tick captures identical content (idempotent replace).
    startTranscriptRotation(
      adapter as unknown as TmuxAdapter,
      "session@rig",
      outputPath,
      { lines: 1000, pollIntervalMs: 60_000 },
    );
    await new Promise((r) => setImmediate(r));

    // Bounded output preserved ...
    expect(fs.readFileSync(outputPath, "utf8")).toBe("stable-1\nstable-2\n");
    // ... and NO second temp-write/rename occurred (inode unchanged, no tmp litter).
    expect(fs.statSync(outputPath).ino).toBe(inoAfterFirst);
    expect(
      fs.readdirSync(path.dirname(outputPath)).filter((e) => e.includes(".tmp.")),
    ).toEqual([]);

    stopTranscriptRotation("session@rig");
  });

  it("STILL rewrites when the capture content genuinely changes (no over-suppression)", async () => {
    const adapter = makeFakeAdapter("first\n");
    const outputPath = path.join(tmpDir, "rig", "session.log");
    startTranscriptRotation(
      adapter as unknown as TmuxAdapter,
      "session@rig",
      outputPath,
      { lines: 1000, pollIntervalMs: 60_000 },
    );
    await new Promise((r) => setImmediate(r));
    const inoAfterFirst = fs.statSync(outputPath).ino;

    adapter.capturePaneContent.mockResolvedValue("second\n");
    startTranscriptRotation(
      adapter as unknown as TmuxAdapter,
      "session@rig",
      outputPath,
      { lines: 1000, pollIntervalMs: 60_000 },
    );
    await new Promise((r) => setImmediate(r));

    expect(fs.readFileSync(outputPath, "utf8")).toBe("second\n");
    expect(fs.statSync(outputPath).ino).not.toBe(inoAfterFirst);
    stopTranscriptRotation("session@rig");
  });

  it("preserves the SESSION BOUNDARY header while suppressing an unchanged rewrite", async () => {
    const adapter = makeFakeAdapter("scrollback-A\n");
    const outputPath = path.join(tmpDir, "rig", "session.log");
    // Restore orchestrator seeds a boundary line before launch.
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, "--- SESSION BOUNDARY: 2026-08-22 restore\n");

    startTranscriptRotation(
      adapter as unknown as TmuxAdapter,
      "session@rig",
      outputPath,
      { lines: 1000, pollIntervalMs: 60_000 },
    );
    await new Promise((r) => setImmediate(r));
    expect(fs.readFileSync(outputPath, "utf8")).toBe(
      "--- SESSION BOUNDARY: 2026-08-22 restore\nscrollback-A\n",
    );
    const inoAfterFirst = fs.statSync(outputPath).ino;

    // Identical second tick: boundary + body byte-identical → suppressed.
    startTranscriptRotation(
      adapter as unknown as TmuxAdapter,
      "session@rig",
      outputPath,
      { lines: 1000, pollIntervalMs: 60_000 },
    );
    await new Promise((r) => setImmediate(r));
    expect(fs.readFileSync(outputPath, "utf8")).toBe(
      "--- SESSION BOUNDARY: 2026-08-22 restore\nscrollback-A\n",
    );
    expect(fs.statSync(outputPath).ino).toBe(inoAfterFirst);
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

describe("startTranscriptRotation — generation guard (r2 HIGH-2: in-flight tick after stop)", () => {
  it("does NOT resurrect liveness or write when a tick is in-flight during stop", async () => {
    let resolveCapture!: (v: string) => void;
    const deferred = new Promise<string>((res) => {
      resolveCapture = res;
    });
    const adapter = { capturePaneContent: vi.fn(() => deferred) };
    const outputPath = path.join(tmpDir, "rig", "session.log");

    startTranscriptRotation(
      adapter as unknown as TmuxAdapter,
      "s@rig",
      outputPath,
      { lines: 1000, pollIntervalMs: 60_000 },
    );
    // The immediate first tick is now awaiting the deferred capture.
    stopTranscriptRotation("s@rig"); // invalidates the generation
    resolveCapture("late-content\n"); // capture resolves AFTER stop
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(getLastCaptureAt("s@rig")).toBeUndefined(); // no resurrection
    expect(fs.existsSync(outputPath)).toBe(false); // no write after stop
  });

  it("a replaced start waits for the old capture to settle and never publishes its stale bytes", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    let release!: (v: string) => void;
    const firstCapture = new Promise<string>((resolve) => { release = resolve; });
    const adapterA = { capturePaneContent: vi.fn(() => firstCapture) };
    const adapterB = makeFakeAdapter("new-gen\n");
    const outputPath = path.join(tmpDir, "s.log");
    const opts = { lines: 1000, pollIntervalMs: 100 };
    startTranscriptRotation(adapterA as unknown as TmuxAdapter, "s@rig", outputPath, opts);
    startTranscriptRotation(adapterB as unknown as TmuxAdapter, "s@rig", outputPath, opts);
    try {
      await vi.advanceTimersByTimeAsync(1000);
      expect(adapterA.capturePaneContent).toHaveBeenCalledTimes(1);
      expect(adapterB.capturePaneContent).not.toHaveBeenCalled();
      expect(getLastCaptureAt("s@rig")).toBeUndefined();
      expect(fs.existsSync(outputPath)).toBe(false);
      release("old-gen\n");
      await new Promise((resolve) => setImmediate(resolve));
      expect(getLastCaptureAt("s@rig")).toBeUndefined();
      expect(fs.existsSync(outputPath)).toBe(false);
      await vi.advanceTimersByTimeAsync(100);
      expect(adapterB.capturePaneContent).toHaveBeenCalledTimes(1);
      expect(fs.readFileSync(outputPath, "utf8")).toBe("new-gen\n");
      expect(getLastCaptureAt("s@rig")).toBe(Date.now());
    } finally {
      stopTranscriptRotation("s@rig"); release("old-gen\n");
      await new Promise((resolve) => setImmediate(resolve));
    }
  });
});

describe("startTranscriptRotation — bounded polling", () => {
  it("holds at most one capture per delayed session without blocking another session", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const adapter = { capturePaneContent: vi.fn(async (session: string) => {
      if (session !== "fast@rig") await gate;
      return session;
    }) };
    const opts = { lines: 1000, pollIntervalMs: 100 };
    for (const session of ["a@rig", "b@rig", "fast@rig"]) {
      startTranscriptRotation(adapter as unknown as TmuxAdapter, session, path.join(tmpDir, session), opts);
    }
    try {
      await vi.advanceTimersByTimeAsync(2000);
      for (const session of ["a@rig", "b@rig"]) {
        expect(adapter.capturePaneContent.mock.calls.filter(([s]) => s === session)).toHaveLength(1);
        expect(getLastCaptureAt(session)).toBeUndefined();
      }
      expect(adapter.capturePaneContent.mock.calls.filter(([s]) => s === "fast@rig")).toHaveLength(21);
      release();
      await new Promise((resolve) => setImmediate(resolve));
      await vi.advanceTimersByTimeAsync(100);
      for (const session of ["a@rig", "b@rig"]) {
        expect(adapter.capturePaneContent.mock.calls.filter(([s]) => s === session)).toHaveLength(2);
        expect(fs.readFileSync(path.join(tmpDir, session), "utf8")).toBe(session);
      }
    } finally {
      clearAllTranscriptRotationsForTest(); release();
      await new Promise((resolve) => setImmediate(resolve));
    }
  });

  it("does not advance freshness on capture or persistence failure; later unchanged success stays fresh", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const adapter = makeFakeAdapter("first");
    const outputPath = path.join(tmpDir, "s.log");
    const tmpPath = `${outputPath}.tmp.${process.pid}`;
    fs.writeFileSync(outputPath, "--- SESSION BOUNDARY: test\n");
    startTranscriptRotation(adapter as unknown as TmuxAdapter, "s@rig", outputPath, { lines: 1000, pollIntervalMs: 100 });
    await new Promise((resolve) => setImmediate(resolve));
    const firstFreshness = getLastCaptureAt("s@rig");
    expect(firstFreshness).toBe(Date.now());
    adapter.capturePaneContent.mockRejectedValueOnce(new Error("capture failed"));
    await vi.advanceTimersByTimeAsync(100);
    expect(getLastCaptureAt("s@rig")).toBe(firstFreshness);
    adapter.capturePaneContent.mockResolvedValueOnce(null);
    await vi.advanceTimersByTimeAsync(100);
    expect(getLastCaptureAt("s@rig")).toBe(firstFreshness);
    // A directory at the temp-file path forces actual persistence to fail.
    fs.mkdirSync(tmpPath);
    adapter.capturePaneContent.mockResolvedValue("second");
    await vi.advanceTimersByTimeAsync(100);
    expect(getLastCaptureAt("s@rig")).toBe(firstFreshness);
    expect(fs.readFileSync(outputPath, "utf8")).toBe("--- SESSION BOUNDARY: test\nfirst");
    fs.rmdirSync(tmpPath);
    await vi.advanceTimersByTimeAsync(100);
    expect(getLastCaptureAt("s@rig")).toBe(Date.now());
    expect(fs.readFileSync(outputPath, "utf8")).toBe("--- SESSION BOUNDARY: test\nsecond");
    const inode = fs.statSync(outputPath).ino;
    await vi.advanceTimersByTimeAsync(100);
    expect(getLastCaptureAt("s@rig")).toBe(Date.now());
    expect(fs.statSync(outputPath).ino).toBe(inode);
  });
});
