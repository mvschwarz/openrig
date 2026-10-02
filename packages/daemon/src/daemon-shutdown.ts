import { writeFileSync, renameSync } from "node:fs";

export const DAEMON_SHUTDOWN_TIMEOUT_MS = 10_000;
export const DAEMON_STOP_WAIT_MS = DAEMON_SHUTDOWN_TIMEOUT_MS + 2_000;
export const DAEMON_HTTP_CONNECTION_GRACE_MS = 250;
export const DAEMON_SHUTDOWN_RECEIPT = "daemon-shutdown.json";
export interface DaemonShutdownReceipt {
  schema: "openrig.daemon-shutdown/v1";
  pid: number;
  startedAt: string;
  completedAt: string;
  outcome: "clean" | "failed" | "timed-out";
  phase: string;
  failures: Array<{ phase: string; error: string }>;
}

interface ServerShutdownHandle {
  close(callback: (error?: Error) => void): unknown;
  closeIdleConnections?: () => void;
}

interface StreamResponse {
  getHeader(name: string): number | string | string[] | undefined;
  writeHead(statusCode: number, ...args: unknown[]): unknown;
  end(): unknown;
  once(event: "close" | "finish", listener: () => void): unknown;
}

const activeResponses = new WeakMap<object, {
  responses: Set<{ response: StreamResponse; contentType?: string }>;
  endLateStream?: (response: StreamResponse) => void;
}>();

/** Register before requests arrive so shutdown can end SSE without cutting ordinary requests. */
export function trackHttpServerResponses(server: {
  prependListener(event: "request", listener: (request: unknown, response: StreamResponse) => void): unknown;
}): void {
  if (activeResponses.has(server)) return;
  const responses = new Set<{ response: StreamResponse; contentType?: string }>();
  const state: NonNullable<ReturnType<typeof activeResponses.get>> = { responses };
  activeResponses.set(server, state);
  server.prependListener("request", (_request, response) => {
    const tracked: { response: StreamResponse; contentType?: string } = { response };
    responses.add(tracked);
    const writeHead = response.writeHead;
    response.writeHead = function (statusCode, ...args) {
      // writeHead's direct headers are not cached by getHeader (including Hono's adapter).
      const headers = typeof args[0] === "string" ? args[1] : args[0];
      const entries: [string, unknown][] = Array.isArray(headers)
        ? headers.flatMap((name, index) => index % 2 === 0 ? [[String(name), headers[index + 1]] as [string, unknown]] : [])
        : headers && typeof headers === "object" ? Object.entries(headers) : [];
      const directType = entries.find(([name]) => name.toLowerCase() === "content-type")?.[1];
      tracked.contentType = String(directType ?? response.getHeader("content-type") ?? "");
      const result = Reflect.apply(writeHead, this, [statusCode, ...args]);
      if (state.endLateStream && tracked.contentType.split(";")[0]!.trim().toLowerCase() === "text/event-stream") {
        // Let the handler finish its current synchronous writes before ending it.
        setImmediate(() => state.endLateStream?.(response));
      }
      return result;
    };
    response.once("close", () => responses.delete(tracked));
  });
}

/** Stop accepting requests and end SSE after the grace period. Ordinary requests
 * keep the existing whole-shutdown budget and cannot produce a premature clean stop. */
export function closeHttpServer(server: ServerShutdownHandle, graceMs = DAEMON_HTTP_CONNECTION_GRACE_MS): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const forceCloseTimer = setTimeout(() => {
      try {
        const state = activeResponses.get(server);
        if (state) state.endLateStream = (response) => {
          try { response.end(); } catch (error) { finish(error as Error); }
        };
        for (const { response, contentType: observedType } of state?.responses ?? []) {
          const contentType = String(observedType ?? response.getHeader("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
          if (contentType === "text/event-stream") response.end();
        }
        server.closeIdleConnections?.();
      } catch (error) { finish(error as Error); }
    }, graceMs);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(forceCloseTimer);
      if (error) reject(error);
      else resolve();
    };
    try {
      for (const { response } of activeResponses.get(server)?.responses ?? []) {
        response.once("finish", () => setImmediate(() => server.closeIdleConnections?.()));
      }
      server.close(finish);
      server.closeIdleConnections?.();
    } catch (error) {
      finish(error as Error);
    }
  });
}

/** One budget for the existing sequential cleanup, including its first await.
 * ponytail: this bounds asynchronous shutdown only; a synchronous event-loop
 * wedge still needs identity-checked operator recovery, not another supervisor. */
export function createDaemonShutdown(options: {
  phases: Array<[string, () => unknown]>;
  markClean: () => void;
  receiptPath: string;
  timeoutMs?: number;
  exit?: (code: number) => void;
  log?: (message: string) => void;
}): (signal: string) => void {
  let started = false;
  return (signal) => {
    if (started) return;
    started = true;
    let finished = false;
    let phase = "starting";
    const startedAt = new Date().toISOString();
    const failures: DaemonShutdownReceipt["failures"] = [];
    const timeoutMs = options.timeoutMs ?? DAEMON_SHUTDOWN_TIMEOUT_MS;
    const log = options.log ?? console.error;
    const exit = options.exit ?? ((code) => process.exit(code));
    const fail = (error: unknown) => {
      failures.push({ phase, error: String(error) });
      log(`[shutdown] ${phase} failed: ${String(error)}`);
    };
    const finish = (outcome: DaemonShutdownReceipt["outcome"]) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      let code = outcome === "clean" ? 0 : 1;
      const receipt: DaemonShutdownReceipt = {
        schema: "openrig.daemon-shutdown/v1", pid: process.pid, startedAt,
        completedAt: new Date().toISOString(), outcome,
        phase: outcome === "clean" ? "complete" : phase, failures,
      };
      try {
        const temp = `${options.receiptPath}.${process.pid}.tmp`;
        writeFileSync(temp, JSON.stringify(receipt) + "\n");
        renameSync(temp, options.receiptPath);
      } catch (error) {
        log(`[shutdown] outcome receipt unavailable: ${String(error)}`);
        code = 1;
      }
      log(`[shutdown] ${outcome}; phase=${receipt.phase}; budget=${timeoutMs}ms; exit=${code}`);
      exit(code);
    };
    // Referenced deliberately: this must also enforce the bound with no servers.
    const timer = setTimeout(() => {
      fail(`whole-shutdown budget exhausted (${timeoutMs}ms); pending effects are unverified`);
      finish("timed-out");
    }, timeoutMs);
    log(`OpenRig daemon received ${signal}; shutting down (budget ${timeoutMs}ms)`);
    void (async () => {
      for (const [name, run] of options.phases) {
        if (finished) return;
        phase = name;
        try { await run(); } catch (error) { if (!finished) fail(error); }
      }
      if (finished) return;
      if (failures.length === 0) {
        phase = "lifecycle-stop";
        try { options.markClean(); } catch (error) { fail(error); }
      }
      if (failures.length) phase = failures[0]!.phase;
      finish(failures.length ? "failed" : "clean");
    })();
  };
}
