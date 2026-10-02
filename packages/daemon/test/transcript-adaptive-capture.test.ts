import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import { startTranscriptRotation, clearAllTranscriptRotationsForTest, getLastCaptureAt, getTranscriptCaptureStats } from "../src/domain/transcript-rotation.js";

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "adaptive-capture-")); vi.useFakeTimers(); });
afterEach(() => { clearAllTranscriptRotationsForTest(); vi.useRealTimers(); fs.rmSync(root, { recursive: true, force: true }); });

function fixture() {
  let hint = 1;
  let text = "first\n";
  const adapter = {
    capturePaneContent: vi.fn(async () => text),
    readAllSessionWindowActivity: vi.fn(async () => new Map([["seat", hint], ["other", hint]])),
  };
  return { adapter, activity: (value: number, content: string) => { hint = value; text = content; } };
}

function start(adapter: object, session = "seat", resolve?: () => { lines: number; pollIntervalMs: number }) {
  const file = path.join(root, session);
  startTranscriptRotation(adapter as TmuxAdapter, session, file, { lines: 1000, pollIntervalMs: 2000 }, resolve);
  return file;
}

describe("adaptive capture", () => {
  it("backs off unchanged output, shares hints across seats, and reconciles without a changed hint", async () => {
    const { adapter, activity } = fixture();
    const file = start(adapter); start(adapter, "other");
    await vi.advanceTimersByTimeAsync(16_000);
    // Each seat captures at 0, 2, 6 and 14s, rather than every 2s.
    expect(adapter.capturePaneContent).toHaveBeenCalledTimes(8);
    expect(adapter.readAllSessionWindowActivity).toHaveBeenCalledTimes(9);
    expect(getTranscriptCaptureStats().idleSeats).toBe(2);
    expect(Date.now() - getLastCaptureAt("seat")!).toBe(2000);
    activity(1, "same-second output not reflected by the hint\n");
    await vi.advanceTimersByTimeAsync(6000);
    expect(fs.readFileSync(file, "utf8")).toBe("same-second output not reflected by the hint\n");
  });

  it("returns to active cadence on an activity hint and preserves boundary headers", async () => {
    const { adapter, activity } = fixture();
    const file = path.join(root, "seat");
    fs.writeFileSync(file, "--- SESSION BOUNDARY: fixture\nfirst\n");
    start(adapter);
    await vi.advanceTimersByTimeAsync(8000);
    activity(2, "burst αβ\nlast line\n");
    await vi.advanceTimersByTimeAsync(2000);
    expect(fs.readFileSync(file, "utf8")).toBe("--- SESSION BOUNDARY: fixture\nburst αβ\nlast line\n");
    expect(getTranscriptCaptureStats().idleSeats).toBe(0);
  });

  it("does not infer idle when hints are missing or unavailable", async () => {
    const { adapter } = fixture();
    adapter.readAllSessionWindowActivity.mockResolvedValue(new Map());
    start(adapter);
    await vi.advanceTimersByTimeAsync(8000);
    expect(adapter.capturePaneContent).toHaveBeenCalledTimes(5);
    expect(getTranscriptCaptureStats().idleSeats).toBe(0);
  });

  it("restores configured cadence when an established idle hint becomes unavailable", async () => {
    const { adapter } = fixture();
    start(adapter, "seat", () => ({ lines: 1000, pollIntervalMs: 2000 }));
    await vi.advanceTimersByTimeAsync(6000);
    const captures = adapter.capturePaneContent.mock.calls.length;
    adapter.readAllSessionWindowActivity.mockResolvedValue(new Map());
    await vi.advanceTimersByTimeAsync(1000);
    expect(adapter.capturePaneContent).toHaveBeenCalledTimes(captures);
    await vi.advanceTimersByTimeAsync(1000);
    expect(adapter.capturePaneContent).toHaveBeenCalledTimes(captures + 1);
    expect(getTranscriptCaptureStats().idleSeats).toBe(0);
  });

  it("falls back to full captures without overlapping probes while a shared hint read is stalled", async () => {
    const { adapter } = fixture();
    let release!: (value: Map<string, number>) => void;
    adapter.readAllSessionWindowActivity.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    start(adapter); start(adapter, "other");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(adapter.readAllSessionWindowActivity).toHaveBeenCalledTimes(1);
    // Both seats keep capturing at configured cadence after the 1s hint deadline.
    expect(adapter.capturePaneContent).toHaveBeenCalledTimes(10);
    expect(getTranscriptCaptureStats().idleSeats).toBe(0);
    release(new Map([["seat", 1], ["other", 1]]));
    await vi.advanceTimersByTimeAsync(2000);
    expect(adapter.readAllSessionWindowActivity).toHaveBeenCalledTimes(2);
    expect(adapter.capturePaneContent).toHaveBeenCalledTimes(12);
  });

  it("applies live intervals and line counts while keeping pending captures exclusive", async () => {
    const { adapter } = fixture();
    let options = { lines: 1000, pollIntervalMs: 2000 };
    start(adapter, "seat", () => options);
    await vi.advanceTimersByTimeAsync(6000);
    options = { lines: 40, pollIntervalMs: 1000 };
    await vi.advanceTimersByTimeAsync(1000);
    expect(adapter.capturePaneContent).toHaveBeenLastCalledWith("seat", 40);
    expect(getTranscriptCaptureStats().activeIntervalMs).toBe(1000);
    let release!: (value: string) => void;
    adapter.capturePaneContent.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    await vi.advanceTimersByTimeAsync(2000);
    const count = adapter.capturePaneContent.mock.calls.length;
    options = { lines: 20, pollIntervalMs: 2000 };
    await vi.advanceTimersByTimeAsync(10_000);
    expect(adapter.capturePaneContent).toHaveBeenCalledTimes(count);
    release("last\n");
    await vi.advanceTimersByTimeAsync(2000);
    expect(adapter.capturePaneContent).toHaveBeenLastCalledWith("seat", 20);
  });

  it("reports UTF8 byte cost and failures without manufacturing capture freshness", async () => {
    const { adapter, activity } = fixture(); activity(1, "α\n");
    start(adapter); await vi.advanceTimersByTimeAsync(0);
    const first = getLastCaptureAt("seat");
    adapter.capturePaneContent.mockResolvedValueOnce(null as never);
    await vi.advanceTimersByTimeAsync(2000);
    expect(getLastCaptureAt("seat")).toBe(first);
    expect(getTranscriptCaptureStats()).toMatchObject({ captures: 2, failures: 1, capturedBytes: 3 });
  });
});
