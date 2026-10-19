// #161: a batch's sessions write their transcripts in separate event-loop turns, so one chunk's 24 read, compare,
// write and rename steps never run back to back in one task. Real timers: the yield is to the real loop.
import { afterEach, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { startTranscriptRotation, clearAllTranscriptRotationsForTest } from "../src/domain/transcript-rotation.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "batched-yield-"));
afterEach(() => { clearAllTranscriptRotationsForTest(); fs.rmSync(root, { recursive: true, force: true }); });

it("writes one batched transcript per event-loop turn", async () => {
  const names = Array.from({ length: 6 }, (_, i) => `y${i}@rig`);
  const adapter = new TmuxAdapter(async () => { throw new Error("shell path unused"); }, undefined, async (argv) => {
    if (argv[1] === "list-sessions") return names.join("\n") + "\n";
    // Each chained pane: its marker line, then its text.
    return argv.filter((a) => a.startsWith("__openrig_capture_")).map((m, k) => `${m}\n${names[k]} text\n`).join("");
  });
  for (const n of names) startTranscriptRotation(adapter, n, path.join(root, n), { lines: 20, pollIntervalMs: 60_000 });
  const written = () => names.filter((n) => fs.existsSync(path.join(root, n))).length;
  const perTurn: number[] = [];
  for (let turn = 0; turn < 50 && written() < names.length; turn++) {
    const before = written();
    await new Promise((resolve) => setImmediate(resolve));
    perTurn.push(written() - before);
  }
  expect(written()).toBe(names.length);
  expect(Math.max(...perTurn)).toBe(1);
});
