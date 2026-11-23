import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { once } from "node:events";
import { TranscriptStore } from "../src/domain/transcript-store.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("transcript reads during atomic capture publication", () => {
  // The publisher replaces the file by rename while a reader holds it open, which Windows refuses
  // with EPERM; the race this test is about is a POSIX one, so it is skipped rather than red there.
  it.skipIf(process.platform === "win32").each(["tail", "grep"] as const)("%s reads one complete published file", async (mode) => {
    const root = mkdtempSync(join(tmpdir(), "openrig-transcript-reader-"));
    roots.push(root);
    const store = new TranscriptStore({ transcriptsRoot: root });
    mkdirSync(join(root, "fixture"));
    const target = store.getTranscriptPath("fixture", "seat@fixture");
    const large = Array.from({ length: 300 }, (_, index) => `ALINE${index}`).join("\n") + "\n";
    const small = "BLINE0\n";
    writeFileSync(target, large);
    const flag = new SharedArrayBuffer(4);
    const worker = new Worker(`
      const fs = require('node:fs');
      const { workerData, parentPort } = require('node:worker_threads');
      const stop = new Int32Array(workerData.flag);
      parentPort.postMessage('ready');
      let count = 0;
      while (!Atomics.load(stop, 0)) {
        fs.writeFileSync(workerData.target + '.next', count++ % 2 ? workerData.large : workerData.small);
        fs.renameSync(workerData.target + '.next', workerData.target);
      }
    `, { eval: true, workerData: { target, large, small, flag } });
    let inconsistent = 0;
    try {
      await once(worker, "message");
      // Each grep starts its own thread (a pattern may otherwise hold the event loop), so the
      // publication race is sampled fewer times than the in-process tail read can be.
      const attempts = mode === "grep" ? 5 : 3000;
      for (let attempt = 0; attempt < attempts; attempt++) {
        if (mode === "tail") {
          const content = store.readTail("fixture", "seat@fixture", 1);
          if (content !== "ALINE299\n" && content !== "BLINE0\n") inconsistent++;
        } else {
          const matches = await store.grep("fixture", "seat@fixture", "^[AB]LINE[0-9]+$");
          if (!(matches?.length === 300 && matches[0] === "ALINE0" && matches.at(-1) === "ALINE299") && !(matches?.length === 1 && matches[0] === "BLINE0")) inconsistent++;
        }
      }
    } finally {
      const stopped = once(worker, "exit");
      Atomics.store(new Int32Array(flag), 0, 1);
      await stopped;
    }
    expect(inconsistent).toBe(0);
  }, 60_000);
});
