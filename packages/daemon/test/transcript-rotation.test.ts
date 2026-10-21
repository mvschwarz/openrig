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
  getLastCheckedAt,
  getTranscriptRotationOptionsFromEnv,
  clearAllTranscriptRotationsForTest,
  DEFAULT_TRANSCRIPT_LINES,
  DEFAULT_TRANSCRIPT_POLL_INTERVAL_MS,
} from "../src/domain/transcript-rotation.js";
import { TranscriptStore } from "../src/domain/transcript-store.js";
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

describe("startTranscriptRotation: skips the capture of a pane with no output since the last capture", () => {
  function hintedAdapter(content: string) {
    const activity = new Map<string, number>();
    return {
      activity,
      capturePaneContent: vi.fn(async () => content),
      readAllSessionWindowActivity: vi.fn(async () => new Map(activity)),
    };
  }
  const opts = { lines: 1000, pollIntervalMs: 1000 };

  it("an idle pane is captured once, then only every 10 s; a skipped tick records a check, not a capture", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    const adapter = hintedAdapter("idle-scrollback\n");
    adapter.activity.set("s@rig", 1_800_000_000 - 3600); // last output an hour ago
    const outputPath = path.join(tmpDir, "rig", "s.log");
    startTranscriptRotation(adapter as unknown as TmuxAdapter, "s@rig", outputPath, opts);
    await vi.advanceTimersByTimeAsync(60_000);
    // Before: every idle tick re-captured the full 1000 lines (about 20 per minute at the idle ceiling).
    expect(adapter.capturePaneContent.mock.calls.length).toBeLessThanOrEqual(7);
    expect(fs.readFileSync(outputPath, "utf8")).toBe("idle-scrollback\n");
    // The capture time is the last real capture; the check time is the last skipped tick.
    expect(Date.now() - getLastCaptureAt("s@rig")!).toBeLessThanOrEqual(10_000 + 3000);
    expect(Date.now() - getLastCheckedAt("s@rig")!).toBeLessThanOrEqual(3000); // the idle ceiling
    stopTranscriptRotation("s@rig");
  });

  it("new output (a later activity second) is captured on the next tick", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    const adapter = hintedAdapter("before\n");
    adapter.activity.set("s@rig", 1_800_000_000 - 3600);
    const outputPath = path.join(tmpDir, "rig", "s.log");
    startTranscriptRotation(adapter as unknown as TmuxAdapter, "s@rig", outputPath, opts);
    await vi.advanceTimersByTimeAsync(10_000);
    const calls = adapter.capturePaneContent.mock.calls.length;
    adapter.capturePaneContent.mockResolvedValue("before\nafter\n");
    adapter.activity.set("s@rig", Math.floor(Date.now() / 1000));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(adapter.capturePaneContent.mock.calls.length).toBeGreaterThan(calls);
    expect(fs.readFileSync(outputPath, "utf8")).toBe("before\nafter\n");
    stopTranscriptRotation("s@rig");
  });

  it("output in the same second as the capture start is never skipped", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_500 });
    const adapter = hintedAdapter("x\n");
    adapter.activity.set("s@rig", 1_800_000_000); // the second the first capture starts in
    const outputPath = path.join(tmpDir, "rig", "s.log");
    startTranscriptRotation(adapter as unknown as TmuxAdapter, "s@rig", outputPath, opts);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(adapter.capturePaneContent.mock.calls.length).toBe(2);
    stopTranscriptRotation("s@rig");
  });

  it("without an activity hint every due tick still captures", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    const adapter = makeFakeAdapter("plain\n");
    startTranscriptRotation(adapter as unknown as TmuxAdapter, "s@rig", path.join(tmpDir, "rig", "s.log"), opts);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(adapter.capturePaneContent.mock.calls.length).toBe(11);
    stopTranscriptRotation("s@rig");
  });
});

describe("startTranscriptRotation: skipped ticks keep ingest health live with honest capture times", () => {
  it("an idle pane stays live for 2 minutes; lastCapturedAt is always a real capture", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    const adapter = {
      capturePaneContent: vi.fn(async () => "idle\n"),
      readAllSessionWindowActivity: vi.fn(async () => new Map([["s@rig", 1_800_000_000 - 3600]])),
    };
    const store = new TranscriptStore({ transcriptsRoot: tmpDir });
    const file = store.getTranscriptPath("rig", "s@rig");
    const captureEnds: number[] = [];
    adapter.capturePaneContent.mockImplementation(async () => { captureEnds.push(Date.now()); return "idle\n"; });
    startTranscriptRotation(adapter as unknown as TmuxAdapter, "s@rig", file, { lines: 1000, pollIntervalMs: 2000 },
      () => ({ lines: 1000, pollIntervalMs: 2000 }));
    for (let i = 0; i < 1200; i++) {
      await vi.advanceTimersByTimeAsync(100);
      const health = store.getIngestHealth("rig", "s@rig");
      expect(health.state).toBe("live");
      expect(["capture_fresh", "capture_unchanged"]).toContain(health.reason);
      // Never later than the last capture that really ran.
      expect(Date.parse(health.lastCapturedAt!)).toBeLessThanOrEqual(captureEnds.at(-1)!);
    }
    // Two minutes: the first capture plus a full read every 10 s, every other tick skipped.
    expect(adapter.capturePaneContent.mock.calls.length).toBeLessThanOrEqual(14);
    stopTranscriptRotation("s@rig");
  });
});

describe("startTranscriptRotation: a capture that fails on an idle pane", () => {
  it("is tried by the full read 10 s after the last capture (plus one idle step), and ingest goes stale at once", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    let fail = false;
    const adapter = {
      capturePaneContent: vi.fn(async () => (fail ? null : "idle\n")),
      readAllSessionWindowActivity: vi.fn(async () => new Map([["s@rig", 1_800_000_000 - 3600]])),
    };
    const store = new TranscriptStore({ transcriptsRoot: tmpDir });
    const file = store.getTranscriptPath("rig", "s@rig");
    startTranscriptRotation(adapter as unknown as TmuxAdapter, "s@rig", file, { lines: 1000, pollIntervalMs: 2000 },
      () => ({ lines: 1000, pollIntervalMs: 2000 }));
    await vi.advanceTimersByTimeAsync(12_000);
    const lastCapture = getLastCaptureAt("s@rig")!;
    fail = true;
    const calls = adapter.capturePaneContent.mock.calls.length;
    const began = Date.now();
    while (adapter.capturePaneContent.mock.calls.length === calls) await vi.advanceTimersByTimeAsync(100);
    expect(Date.now() - lastCapture).toBeLessThanOrEqual(10_000 + 3000);
    expect(Date.now() - began).toBeLessThanOrEqual(10_000 + 3000);
    // The failed capture records no capture and clears the check: the 10 s old capture now reads stale.
    expect(getLastCaptureAt("s@rig")).toBe(lastCapture);
    expect(getLastCheckedAt("s@rig")).toBeUndefined();
    expect(store.getIngestHealth("rig", "s@rig")).toMatchObject({ state: "degraded", reason: "capture_stale" });
    stopTranscriptRotation("s@rig");
  });
});

describe("startTranscriptRotation: output right after a skipped tick is captured on the next tick", () => {
  it("is not delayed by the skip: due at the next shared tick, as after an idle capture", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    const hint = { at: 1_800_000_000 - 3600 };
    const adapter = {
      capturePaneContent: vi.fn(async () => "idle\n"),
      readAllSessionWindowActivity: vi.fn(async () => new Map([["s@rig", hint.at]])),
    };
    const outputPath = path.join(tmpDir, "rig", "s.log");
    startTranscriptRotation(adapter as unknown as TmuxAdapter, "s@rig", outputPath, { lines: 1000, pollIntervalMs: 2000 },
      () => ({ lines: 1000, pollIntervalMs: 2000 }));
    await vi.advanceTimersByTimeAsync(20_000); // idle: every tick since the first is a skip
    const calls = adapter.capturePaneContent.mock.calls.length;
    adapter.capturePaneContent.mockResolvedValue("idle\nnew\n");
    hint.at = Math.floor(Date.now() / 1000);
    const wrote = Date.now();
    while (fs.readFileSync(outputPath, "utf8") !== "idle\nnew\n") await vi.advanceTimersByTimeAsync(100);
    expect(adapter.capturePaneContent.mock.calls.length).toBe(calls + 1);
    // The next 1 s shared tick, plus the shared activity read, as for a seat that idled with captures.
    expect(Date.now() - wrote).toBeLessThanOrEqual(2000);
    stopTranscriptRotation("s@rig");
  });
});
