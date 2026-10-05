import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsStore } from "../src/domain/user-settings/settings-store.js";
import { createTranscriptRotationOptionsResolver } from "../src/domain/transcript-rotation.js";
import { ConfigStore } from "../../cli/src/config-store.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "live-transcripts-")); vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); });

it("observes actual CLI config writes/reset and retains settings through malformed intermediate JSON", async () => {
  const file = join(dir, "config.json");
  const cli = new ConfigStore(file);
  const resolve = createTranscriptRotationOptionsResolver(new SettingsStore(file));
  expect(resolve()).toEqual({ lines: 1000, pollIntervalMs: 2000 });
  cli.set("transcripts.poll_interval_seconds", "3"); cli.set("transcripts.lines", "40");
  await vi.advanceTimersByTimeAsync(1000);
  expect(resolve()).toEqual({ lines: 40, pollIntervalMs: 3000 });
  writeFileSync(file, "{"); await vi.advanceTimersByTimeAsync(1000);
  expect(resolve()).toEqual({ lines: 40, pollIntervalMs: 3000 });
  cli.reset(); await vi.advanceTimersByTimeAsync(1000);
  expect(resolve()).toEqual({ lines: 1000, pollIntervalMs: 2000 });
});

it.each(["0", "-1", "2junk", "1.5", "3601", "2147483648"])("rejects unsafe live intervals %s at both write surfaces", (value) => {
  const file = join(dir, "config.json");
  expect(() => new ConfigStore(file).set("transcripts.poll_interval_seconds", value)).toThrow();
  expect(() => new SettingsStore(file).set("transcripts.poll_interval_seconds", value)).toThrow();
});
