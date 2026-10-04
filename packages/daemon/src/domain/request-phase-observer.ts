import { randomUUID } from "node:crypto";
import { BUILD_INFO } from "../build-info.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { performance } from "node:perf_hooks";
import type { Context, MiddlewareHandler } from "hono";
import type { SlowOperationInstrumentation } from "./slow-op-recorder.js";

export const DIAGNOSTIC_ATTEMPT_HEADER = "x-openrig-diagnostic-attempt";
export const DIAGNOSTIC_LIMITS = { requestsPerMinute: 128, active: 128, phases: 16, ageMs: 60_000, tickWindow: 40 } as const;
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
type Route = "rigs_list" | "rig_nodes";
type Phase = "node_arrival" | "hono_enter" | "hono_exit" | "handler_enter" | "handler_exit" | "sql_begin" | "sql_end" | "response_finish" | "response_close" | "request_aborted" | "trace_expired";
type Fields = { status?: number; headersSent?: boolean; writableFinished?: boolean; failed?: boolean };
export type QueryObservation = (phase: "begin" | "end", failed?: boolean) => void;
interface Trace {
  attemptId: string; serverRequestId: string; route: Route; started: number;
  phases: Set<Phase>; entered: boolean; exited: boolean; closed: boolean; retired: boolean;
  detach: () => void;
}

export function inventoryDiagnosticRoute(method: string | undefined, url: string | undefined): Route | null {
  if (method !== "GET" || !url) return null;
  const path = url.split("?", 1)[0];
  if (path === "/api/rigs") return "rigs_list";
  return /^\/api\/rigs\/[^/]+\/nodes$/.test(path ?? "") ? "rig_nodes" : null;
}

/** Correlation only: never an identity, authorization or deduplication key. */
export function inventoryAttemptId(rawHeaders: readonly string[]): string | undefined {
  let token: string | undefined;
  for (let i = 0; i < rawHeaders.length; i += 2) {
    if (rawHeaders[i]?.toLowerCase() !== DIAGNOSTIC_ATTEMPT_HEADER) continue;
    if (token !== undefined || !UUID4.test(rawHeaders[i + 1] ?? "")) return undefined;
    token = rawHeaders[i + 1];
  }
  return token;
}

/** Bounded measurement at existing HTTP/tick seams. No timers, I/O wait or request authority. */
export class RequestPhaseObserver {
  private readonly traces = new WeakMap<object, Trace>();
  private readonly active = new Set<Trace>();
  private readonly epoch = randomUUID();
  private readonly started: number;
  private seq = 0;
  private windowStart: number;
  private admitted = 0;
  private rejected = 0;
  private expired = 0;
  private observerErrors = 0;
  private stopped = false;
  private ticks: Array<{ from: number; to: number }> = [];

  constructor(
    private readonly sink: SlowOperationInstrumentation,
    private readonly now: () => number = () => performance.now(),
    private readonly utc: () => string = () => new Date().toISOString(),
  ) {
    this.started = this.windowStart = now();
    this.record("activated", { limits: DIAGNOSTIC_LIMITS, build: BUILD_INFO });
  }

  private record(phase: string, fields: Record<string, unknown>): void {
    try {
      this.sink.recordDiagnostic?.({ schema: "openrig.request-phase/v1", epoch: this.epoch,
        seq: ++this.seq, utc: this.utc(), elapsedMs: Math.max(0, this.now() - this.started), phase,
        rejected: this.rejected, expired: this.expired, observerErrors: this.observerErrors, ...fields });
    } catch { this.observerErrors++; }
  }

  private emit(trace: Trace, phase: Phase, fields: Fields = {}): void {
    if (trace.retired || trace.phases.has(phase)) return;
    if (trace.phases.size >= DIAGNOSTIC_LIMITS.phases) { this.observerErrors++; return; }
    trace.phases.add(phase);
    const last = this.ticks.at(-1);
    this.record(phase, { attemptId: trace.attemptId, serverRequestId: trace.serverRequestId, route: trace.route,
      requestElapsedMs: Math.max(0, this.now() - trace.started), ...fields,
      ...(last ? { loop: { sampledAtMs: last.to - this.started, lastTickAgeMs: Math.max(0, this.now() - last.to),
        windowStartMs: this.ticks[0]!.from - this.started, maxGapMs: Math.max(...this.ticks.map(t => t.to - t.from)), samples: this.ticks.length } } : {}) });
  }

  /** Called by the existing prepended Node listener, before the adapter callback. */
  observeRequest = (input: unknown, output: unknown): void => {
    try {
      const request = input as IncomingMessage, response = output as ServerResponse;
      const route = inventoryDiagnosticRoute(request.method, request.url);
      if (this.stopped || !route || !Array.isArray(request.rawHeaders)) return;
      const attemptId = inventoryAttemptId(request.rawHeaders);
      if (!attemptId) return;
      const at = this.now();
      if (at - this.windowStart >= 60_000) { this.windowStart = at; this.admitted = 0; }
      if (this.active.size >= DIAGNOSTIC_LIMITS.active || this.admitted >= DIAGNOSTIC_LIMITS.requestsPerMinute) {
        this.rejected++; return;
      }
      this.admitted++;
      const trace: Trace = { attemptId, serverRequestId: randomUUID(), route, started: at, phases: new Set(),
        entered: false, exited: false, closed: false, retired: false, detach: () => {} };
      const fields = (): Fields => ({ status: response.statusCode, headersSent: response.headersSent, writableFinished: response.writableFinished });
      const finish = () => this.safe(() => this.emit(trace, "response_finish", fields()));
      const close = () => this.safe(() => {
        this.emit(trace, "response_close", fields()); trace.closed = true;
        if (trace.exited || !trace.entered) this.retire(trace);
      });
      const aborted = () => this.safe(() => this.emit(trace, "request_aborted"));
      trace.detach = () => { request.removeListener("aborted", aborted); response.removeListener("finish", finish); response.removeListener("close", close); this.traces.delete(request); };
      this.traces.set(request, trace); this.active.add(trace);
      response.once("finish", finish); response.once("close", close); request.once("aborted", aborted);
      this.emit(trace, "node_arrival");
    } catch { this.observerErrors++; }
  };

  private safe(fn: () => void): void { try { fn(); } catch { this.observerErrors++; } }
  private retire(trace: Trace): void {
    trace.retired = true; this.active.delete(trace); trace.detach();
  }

  middleware(): MiddlewareHandler {
    return async (c, next) => {
      const raw = (c.env as { incoming?: object } | undefined)?.incoming;
      const trace = raw ? this.traces.get(raw) : undefined;
      if (!trace) { await next(); return; }
      c.set("inventoryRequestObservation", { observer: this, trace });
      this.safe(() => { trace.entered = true; this.emit(trace, "hono_enter"); });
      try { await next(); }
      finally {
        this.safe(() => {
          this.emit(trace, "hono_exit", { status: c.res.status, failed: Boolean(c.error) }); trace.exited = true;
          if (trace.closed) this.retire(trace);
        });
      }
    };
  }

  handler(trace: Trace, phase: "handler_enter" | "handler_exit", fields?: Fields): void {
    this.safe(() => this.emit(trace, phase, fields));
  }
  query(trace: Trace): QueryObservation {
    return (phase, failed) => this.safe(() => this.emit(trace, phase === "begin" ? "sql_begin" : "sql_end", { failed: Boolean(failed) }));
  }

  /** Reuses EventLoopMonitor's tick; an unfinished stall has no invented end. */
  tick(at: number, previous: number): void {
    this.safe(() => {
      if (this.stopped) return;
      this.ticks.push({ from: previous, to: at });
      if (this.ticks.length > DIAGNOSTIC_LIMITS.tickWindow) this.ticks.shift();
      const gapMs = Math.max(0, at - previous);
      if (gapMs - 250 >= 250) this.record("event_loop_gap", { fromMs: previous - this.started, toMs: at - this.started, gapMs });
      for (const trace of this.active) {
        if (at - trace.started < DIAGNOSTIC_LIMITS.ageMs) continue;
        this.expired++; this.emit(trace, "trace_expired"); this.retire(trace);
      }
    });
  }

  close(): void {
    this.safe(() => {
      if (this.stopped) return;
      this.record("stopped", { incompleteActive: this.active.size }); this.stopped = true;
      for (const trace of this.active) this.retire(trace);
    });
  }
}

function observation(c: Context): { observer: RequestPhaseObserver; trace: Trace } | undefined {
  return c.get("inventoryRequestObservation");
}

export const observeInventoryHandler: MiddlewareHandler = async (c, next) => {
  const bound = observation(c);
  bound?.observer.handler(bound.trace, "handler_enter");
  try { await next(); }
  finally { bound?.observer.handler(bound.trace, "handler_exit", { status: c.res.status, failed: Boolean(c.error) }); }
};

export function observeInventoryQuery(c: Context): QueryObservation | undefined {
  const bound = observation(c);
  return bound?.observer.query(bound.trace);
}
