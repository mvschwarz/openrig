import type { EventBus } from "./event-bus.js";
import type { ViewProjector } from "./view-projector.js";
import type { PersistedEvent } from "./types.js";
import { BUILT_IN_VIEW_NAMES } from "./view-projector.js";

/**
 * View event bridge (PL-004 Phase B R1; closes guard BLOCKER 2).
 *
 * Subscribes to coordination state-mutation events on the event-bus and
 * emits `view.changed` for the affected built-in views via
 * ViewProjector.notifyViewChanged. Without this bridge, SSE consumers
 * connecting to /api/views/:name/sse never receive change notifications
 * because nothing in production wires queue/project mutations to the
 * view.changed event source.
 *
 * Per PRD § L5 acceptance criterion: "view-projector emits view.changed
 * when underlying state changes" + slice IMPL § Guard Checkpoint Focus
 * item 8 + R1 guard finding 2.
 *
 * Mapping (event type → affected built-in views):
 * - queue.created            → recently-active, founder, pod-load, activity
 * - queue.handed_off         → recently-active, pod-load, activity
 * - queue.claimed            → recently-active, pod-load, activity
 * - queue.unclaimed          → recently-active, pod-load, activity
 * - qitem.fallback_routed    → recently-active, pod-load, activity
 * - qitem.closure_overdue    → recently-active, escalations, activity
 * - inbox.absorbed           → recently-active, pod-load, activity
 * - inbox.denied             → activity
 * - project.classified       → activity (downstream views may consume project_classifications)
 *
 * Conservative principle: when in doubt, emit. SSE consumers can filter
 * by view name. Over-emission is correct (no missed events); the slight
 * SSE traffic increase is acceptable for Phase B.
 *
 * The bridge does NOT emit view.changed for `view.changed` itself
 * (avoid feedback loops) or for `classifier.lease_*` events (lease state
 * is exposed via the project SSE, not the view SSE).
 *
 * Custom views: this bridge does NOT emit per-custom-view events. Custom
 * view consumers can subscribe to /api/views/sse (the generic stream)
 * and filter by viewName. A future enhancement could parse custom view
 * SQL to determine which built-in event types it depends on; v0 keeps
 * the bridge built-in-only.
 */

const EVENT_TO_VIEWS: Record<string, readonly string[]> = {
  "queue.created":          ["recently-active", "founder", "pod-load", "activity"],
  "queue.handed_off":       ["recently-active", "pod-load", "activity"],
  "queue.claimed":          ["recently-active", "pod-load", "activity"],
  "queue.unclaimed":        ["recently-active", "pod-load", "activity"],
  // R2 fix (closes guard BLOCKER on queue.updated coverage): general state
  // mutator (POST /api/queue/:qitemId/update) emits queue.updated for any
  // pending → blocked / in-progress → done / closure / escalation transition.
  // Maps to ALL state-derived views because the projection result-set may
  // change for any of them (e.g., done removes from recently-active +
  // pod-load; blocked adds to held; closure_reason='escalation' adds to
  // escalations; ts_updated change reorders activity).
  "queue.updated":          ["recently-active", "founder", "pod-load", "escalations", "held", "activity"],
  "qitem.fallback_routed":  ["recently-active", "pod-load", "activity"],
  "qitem.closure_overdue":  ["recently-active", "escalations", "activity"],
  "inbox.absorbed":         ["recently-active", "pod-load", "activity"],
  "inbox.denied":           ["activity"],
  "project.classified":     ["activity"],
};

export interface ViewEventBridgeStop {
  (): void;
}

/**
 * Wire the bridge. Returns a function that unsubscribes (used in tests +
 * for graceful daemon shutdown). The bridge subscribes to event-bus and
 * only fires for known coordination event types.
 */
export function wireViewEventBridge(
  eventBus: EventBus,
  viewProjector: ViewProjector,
): ViewEventBridgeStop {
  // Validate the mapping references built-in view names. If a built-in is
  // renamed/removed without updating EVENT_TO_VIEWS, fail fast at startup.
  const builtInSet = new Set<string>(BUILT_IN_VIEW_NAMES as readonly string[]);
  for (const [evt, views] of Object.entries(EVENT_TO_VIEWS)) {
    for (const v of views) {
      if (!builtInSet.has(v)) {
        throw new Error(
          `view-event-bridge: EVENT_TO_VIEWS maps event '${evt}' to unknown built-in view '${v}'; update mapping or built-in list`,
        );
      }
    }
  }

  return eventBus.subscribe((event: PersistedEvent) => {
    const affectedViews = EVENT_TO_VIEWS[event.type];
    if (!affectedViews) return;
    for (const viewName of affectedViews) {
      try {
        viewProjector.notifyViewChanged(viewName, event.type);
      } catch {
        // Best-effort: bridge errors must not unwind the underlying state
        // mutation. Drop silently; SSE consumers' worst case is a missed
        // wake-up, not state corruption.
      }
    }
  });
}
