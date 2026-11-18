// The host side of the transcript grep scan: one request, one thread, a deadline.
//
// The scan itself lives in domain/transcript-grep-worker.ts, because a pattern the route accepts as
// valid syntax can backtrack catastrophically and would otherwise hold the daemon's event loop for as
// long as it runs. Here the host starts that thread, waits a bounded time, and ends it if the scan is
// still going: a pattern that cannot finish costs one grep and one thread, never the daemon.

import { Worker } from "node:worker_threads";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * How long a grep scan may run before its thread is ended.
 *
 * Measured on this machine against a real transcript: 50,000 lines, 5.1 MB, scanned in about 0.9 s
 * from source (which pays the loader start) and the same with a character-class pattern. Two seconds
 * would have left little room for a cold cache or a slower host, and a transcript twice that size
 * would have tripped it while scanning perfectly well. Ten seconds still ends a pattern that
 * backtracks forever — the case this bound exists for — and it is short enough that a person waiting
 * on a search would rather have the answer than a longer wait.
 */
export const TRANSCRIPT_GREP_TIMEOUT_MS = 10_000;

/** A grep that did not finish inside its bound; the scan ended with it. */
export class TranscriptGrepTimeoutError extends Error {
  readonly code = "grep_timeout";
  constructor(readonly pattern: string, readonly timeoutMs: number) {
    super(`the pattern did not finish scanning within ${Math.round(timeoutMs / 1000)} s and the scan was ended`);
    this.name = "TranscriptGrepTimeoutError";
  }
}

/**
 * The thread that runs the scan.
 *
 * The compiled build has `transcript-grep-worker.js` beside this file and starts it directly. Running
 * from source there is only the `.ts` entry, and a worker does not inherit the parent's preload: tsx's
 * `--import` registers ESM hooks on the main thread only, so a `.ts` worker entry would fail with
 * `ERR_UNKNOWN_FILE_EXTENSION`. The bootstrap below registers the loader inside the thread and then
 * imports the TypeScript entry.
 */
function startScanThread(workerPath: { compiled: string; sourceUrl: string }): Worker {
  if (existsSync(workerPath.compiled)) return new Worker(workerPath.compiled);
  return new Worker(
    `const { register } = require("tsx/esm/api");\nregister();\nimport(${JSON.stringify(workerPath.sourceUrl)});\n`,
    { eval: true },
  );
}

let lastRequestId = 0;

/**
 * Scan one transcript file for a pattern, on a thread the host can end.
 *
 * Resolves with the matching lines, `null` when the file does not exist, and rejects with
 * TranscriptGrepTimeoutError when the scan outlived its bound.
 */
export function scanTranscriptGrep(
  filePath: string,
  pattern: string,
  timeoutMs = TRANSCRIPT_GREP_TIMEOUT_MS,
): Promise<string[] | null> {
  if (!existsSync(filePath)) return Promise.resolve(null);
  const id = ++lastRequestId;
  return new Promise<string[] | null>((resolve, reject) => {
    const worker = startScanThread({
      compiled: fileURLToPath(new URL("./transcript-grep-worker.js", import.meta.url)),
      // A file URL, not a path: dynamic import wants one, and a Windows path is not one.
      sourceUrl: new URL("./transcript-grep-worker.ts", import.meta.url).href,
    });
    let settled = false;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      settle();
    };
    const timer = setTimeout(
      () => finish(() => reject(new TranscriptGrepTimeoutError(pattern, timeoutMs))),
      timeoutMs,
    );
    // Idle, the thread keeps no process up; while an answer is owed it does.
    worker.ref();
    worker.on("message", (reply: { id: number; matches?: string[]; error?: string }) => {
      if (reply.id !== id) return;
      if (reply.error !== undefined) finish(() => reject(new Error(reply.error)));
      else finish(() => resolve(reply.matches ?? []));
    });
    // A worker that dies fails what it owed: a scan that cannot report is not an empty result.
    worker.on("error", (error) => finish(() => reject(error)));
    worker.on("exit", (code) => finish(() => reject(new Error(`the transcript grep scan exited with code ${code}`))));
    worker.postMessage({ id, filePath, pattern });
  });
}