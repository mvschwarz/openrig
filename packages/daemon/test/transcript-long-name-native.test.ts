import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import { TranscriptStore } from "../src/domain/transcript-store.js";
import { getLastCaptureAt, startTranscriptRotation, stopTranscriptRotation } from "../src/domain/transcript-rotation.js";

it.runIf(process.platform === "win32")("rotates a valid long native transcript leaf without extending its filename", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "transcript-long-owned-"));
  const session = `p-${"a".repeat(242)}@r`;
  const store = new TranscriptStore({ transcriptsRoot: root });
  const output = store.getTranscriptPath("owned", session);
  const adapter = { capturePaneContent: async () => "owned captured text\n" } as unknown as TmuxAdapter;
  try {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, "--- SESSION BOUNDARY: owned ---\nold text\n");
    startTranscriptRotation(adapter, session, output, { lines: 100, pollIntervalMs: 60_000 });
    await new Promise(resolve => setImmediate(resolve));
    expect(fs.readFileSync(output, "utf8")).toBe("--- SESSION BOUNDARY: owned ---\nowned captured text\n");
    expect(getLastCaptureAt(session)).toBeTypeOf("number");
    expect(fs.readdirSync(path.dirname(output))).toEqual([path.basename(output)]);
  } finally {
    stopTranscriptRotation(session);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
