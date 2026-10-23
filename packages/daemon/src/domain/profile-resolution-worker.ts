import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolveNodeConfig, type ResolutionContext, type ResolutionResult } from "./profile-resolver.js";

// Keep the resolver's filesystem and catalog semantics in one place. In particular, a missing named skill can
// require a full library scan, and catalog inspection runs synchronous git commands. Neither belongs on the
// daemon's request thread during preflight (#1653). Reuse the imported module within a preflight, but read fresh
// filesystem state for every member. In particular, do not cache scans by their root directory's mtime.
const SOURCE = new URL(`data:text/javascript,${encodeURIComponent(`
import { parentPort, workerData } from "node:worker_threads";
let resolver;
parentPort.on("message", async ({ id, context }) => {
  resolver ??= workerData.url.endsWith(".ts")
    ? (await import(workerData.loaderUrl)).tsImport(workerData.url, workerData.parent)
    : import(workerData.url);
  parentPort.postMessage({ id, result: (await resolver).resolveNodeConfig(context) });
});
`)}`);

type Resolve = (context: ResolutionContext) => Promise<ResolutionResult>;

/** One lazy worker per preflight, never a persistent daemon-wide cache or one worker per member. */
export async function withNodeConfigResolver<T>(run: (resolve: Resolve) => Promise<T>): Promise<T> {
  let worker: Worker | undefined;
  let failure: Error | undefined;
  let nextId = 0;
  const pending = new Map<number, { resolve: (result: ResolutionResult) => void; reject: (error: Error) => void }>();
  const fail = (error: Error) => {
    failure ??= error;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  const resolve: Resolve = async (context) => {
    try {
      if (failure) throw failure;
      if (!worker) {
        const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
        worker = new Worker(SOURCE, {
          execArgv: [],
          workerData: { url: new URL(`./profile-resolver.${extension}`, import.meta.url).href, parent: import.meta.url,
            loaderUrl: extension === "ts" ? pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm/api")).href : undefined },
        });
        worker.on("message", ({ id, result }: { id: number; result: ResolutionResult }) => {
          pending.get(id)?.resolve(result);
          pending.delete(id);
        });
        worker.once("error", fail);
        worker.once("exit", (code) => fail(new Error(`Profile resolution worker exited (code ${code})`)));
      }
      return await new Promise<ResolutionResult>((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        try { worker!.postMessage({ id, context }); }
        catch (error) { pending.delete(id); reject(error); }
      });
    } catch (error) {
      // Node itself reads cwd before a worker entry runs, even for file/ESM workers.
      // Preserve the old preflight behavior if that directory vanished; only this
      // exceptional case keeps synchronous resolution on the request thread.
      if (error && typeof error === "object" && "syscall" in error && error.syscall === "uv_cwd") {
        return resolveNodeConfig(context);
      }
      throw error;
    }
  };
  try {
    return await run(resolve);
  } finally {
    await worker?.terminate();
  }
}

export function resolveNodeConfigAsync(context: ResolutionContext): Promise<ResolutionResult> {
  return withNodeConfigResolver(resolve => resolve(context));
}
