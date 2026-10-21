import { promisify } from "node:util";
import { runAsyncSite } from "../domain/sync-site-wrap.js";

/** A runtime probe that must not hold the event loop (`codex -p <profile> mcp list`, `pi --version`): the command and
 *  options its callers gave `execSync` (utf-8, a 10 s bound that ends the probe, no input, their cwd and env), run
 *  asynchronously under runAsyncSite. It answers with stdout; a failure keeps `stderr` for the callers that read it,
 *  and a probe ended at its bound carries `code: "ETIMEDOUT"`, as execSync's did, so it reads as a timeout.
 *  child_process is imported when a probe runs, as the probes did before, so loading a caller doesn't load it. */
export async function execRuntimeProbe(
  site: string,
  cmd: string,
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<string> {
  const { exec } = await import("node:child_process");
  const { timeoutMs = 10_000, ...execOptions } = options;
  return runAsyncSite(site, async () => {
    const running = promisify(exec)(cmd, { encoding: "utf-8", timeout: timeoutMs, ...execOptions });
    running.child.stdin?.end();
    try {
      return (await running).stdout;
    } catch (err) {
      const failure = err as { killed?: boolean; code?: unknown };
      if (failure.killed && (failure.code === null || failure.code === undefined)) failure.code = "ETIMEDOUT";
      throw err;
    }
  });
}
