import type { EventBus } from "./event-bus.js";
import type { RigEvent } from "./types.js";

/** The event kinds that record a queue write or send this daemon refused, or could not settle (#3728). */
export type RefusalEvent = Extract<RigEvent, { type: "queue.create_refused" | "queue.create_remote_unknown" | "transport.send_refused" }>;

/**
 * Record a refusal through the existing event log, so `rig telemetry events` and the /api/events stream show it when the
 * caller lost stderr. A trace never changes the command: the response is already decided, and a failed write here
 * is dropped rather than turned into a second failure.
 */
export function recordRefusal(bus: EventBus | undefined, event: RefusalEvent): void {
  if (!bus) return;
  try { bus.emit(event); } catch { /* the refused command's own response stands */ }
}

/** A refusal's reason: the response's own error code, or its plain error text when it carries no code. */
export function refusalReason(payload: unknown): string {
  if (payload === null || typeof payload !== "object") return "unknown";
  const { reason, error } = payload as { reason?: unknown; error?: unknown };
  if (typeof reason === "string" && reason) return reason;
  return typeof error === "string" && error ? error.slice(0, 120) : "unknown";
}
