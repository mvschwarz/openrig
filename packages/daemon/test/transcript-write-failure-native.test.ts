import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import { getLastCaptureAt, startTranscriptRotation, stopTranscriptRotation } from "../src/domain/transcript-rotation.js";

const fault = vi.hoisted(() => ({ enabled: false }));
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
    if (fault.enabled) {
      actual.writeFileSync(args[0], "owned partial bytes", args[2]);
      throw Object.assign(new Error("owned simulated full disk"), { code: "ENOSPC" });
    }
    return actual.writeFileSync(...args);
  } };
});

it.runIf(process.platform === "win32")("removes a partially written native rotation stage and preserves old bytes and freshness", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "transcript-partial-owned-"));
  const output = path.join(root, "owned.log"), session = "partial@owned";
  const adapter = { capturePaneContent: async () => "complete owned capture" } as unknown as TmuxAdapter;
  try {
    fs.writeFileSync(output, "old owned capture");
    fault.enabled = true;
    startTranscriptRotation(adapter, session, output, { lines: 100, pollIntervalMs: 60_000 });
    await new Promise(resolve => setImmediate(resolve));
    expect(fs.readFileSync(output, "utf8")).toBe("old owned capture");
    expect(getLastCaptureAt(session)).toBeUndefined();
    expect(fs.readdirSync(root)).toEqual(["owned.log"]);
    fault.enabled = false;
    startTranscriptRotation(adapter, session, output, { lines: 100, pollIntervalMs: 60_000 });
    await new Promise(resolve => setImmediate(resolve));
    expect(fs.readFileSync(output, "utf8")).toBe("complete owned capture");
    expect(getLastCaptureAt(session)).toBeTypeOf("number");
  } finally {
    fault.enabled = false;
    stopTranscriptRotation(session);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
