import type { MiddlewareHandler } from "hono";

/** One state-changing request as seen at the HTTP edge. */
export interface MutationTraceEntry {
  method: string;
  path: string;
  status: number;
  /** The transport sender (X-OpenRig-Session) when the caller carried one. */
  sender: string | null;
}

/** The daemon's existing diagnostics path: bounded, nonblocking, worker-written. */
export interface MutationTraceSink {
  /** Bounded nonblocking diagnostic append; false means the record was dropped. */
  recordDiagnostic?(record: Record<string, unknown>): boolean;
}

export const MUTATION_TRACE_SCHEMA = "openrig.mutation-trace/v1";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Edge observer mirroring createSlowOpRequestMiddleware's isolation contract:
 * invoked in a `finally` and wrapped in its own try/catch, so a throwing trace
 * write can NEVER replace the route's real status or body. Non-mutating
 * requests call `next()` and continue to later handlers untouched. The record
 * rides the daemon's diagnostics path (`recordDiagnostic` and its worker): no
 * synchronous disk write on the request path, a bounded queue that reports
 * dropped or failed records through its coverage counters, and one line per
 * state-changing attempt — method, path, status and the sender the transport
 * carried, not a committed change or a verified identity.
 */
export function createMutationTraceMiddleware(sink: MutationTraceSink): MiddlewareHandler {
  return async (c, next) => {
    if (!MUTATING_METHODS.has(c.req.method)) return next();
    try {
      await next();
    } finally {
      try {
        sink.recordDiagnostic?.({
          schema: MUTATION_TRACE_SCHEMA,
          at: new Date().toISOString(),
          method: c.req.method,
          path: c.req.path,
          status: c.res.status,
          sender: c.req.header("x-openrig-session")?.trim() || null,
        });
      } catch (error) {
        console.error("[mutation-trace] record failed", error);
      }
    }
  };
}
