import { readFileSync } from "node:fs";

/** Windows cannot deliver a catchable SIGINT to another Node process. Poll only
 * this run's private request file, bound to the recorded process start identity. */
export function watchCancelRequest(path: string, processStart: string | undefined, cancel: () => void): () => void {
  let requested = false;
  const timer = setInterval(() => {
    if (requested || processStart === undefined) return;
    try {
      const request = JSON.parse(readFileSync(path, "utf8")) as { processStart?: string };
      if (request.processStart !== processStart) return;
      requested = true;
      cancel();
    } catch { /* absent or a write still in progress; try again */ }
  }, 100);
  timer.unref();
  return () => clearInterval(timer);
}
