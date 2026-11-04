import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import type { EventBus } from "./event-bus.js";
import type { PersistedEvent } from "./types.js";
import type { StreamItem, StreamStore } from "./stream-store.js";
import type { QueueRepository } from "./queue-repository.js";
import { SettingsStore } from "./user-settings/settings-store.js";
import { WAKE_INTENT_PREFIX } from "./outbox-handler.js";

export const STREAM_INTAKE_TAG = "stream-subscription";

/**
 * Derives a deterministic idempotent qitemId from the first stream item in an intake batch.
 */
export function streamIntakeQitemId(firstStreamSortKey: string): string {
  const hash = createHash("sha256").update(firstStreamSortKey).digest("hex").slice(0, 16);
  return `qitem-stream-intake-${hash}`;
}

export interface StreamIntakeCoordinatorDeps {
  db: Database.Database;
  eventBus: EventBus;
  streamStore: StreamStore;
  queueRepo: QueueRepository;
  destination?: string | (() => string); // e.g. "queue.worker" (default) or "off"
}

export class StreamIntakeCoordinator {
  private readonly db: Database.Database;
  private readonly eventBus: EventBus;
  private readonly streamStore: StreamStore;
  private readonly queueRepo: QueueRepository;
  private readonly rawDestination?: string | (() => string);
  private unsubscribeBus?: () => void;
  private pendingStreamItemIds: string[] = [];
  private pendingStreamItemIdSet = new Set<string>();
  private heldLiveItemIds: string[] = [];
  private catchingUp = false;
  private processing = false;

  constructor(deps: StreamIntakeCoordinatorDeps) {
    this.db = deps.db;
    this.eventBus = deps.eventBus;
    this.streamStore = deps.streamStore;
    this.queueRepo = deps.queueRepo;
    this.rawDestination = deps.destination;
  }

  private getDestinationConfig(): string {
    if (typeof this.rawDestination === "function") {
      try {
        const val = this.rawDestination();
        return (val || "queue.worker").trim();
      } catch (err) {
        console.error("[stream-intake] failed to resolve destination from callback:", err);
        return "queue.worker";
      }
    }
    if (typeof this.rawDestination === "string") {
      return this.rawDestination.trim();
    }
    try {
      return String(new SettingsStore().resolveOne("stream.intake").value ?? "queue.worker").trim();
    } catch {
      return "queue.worker";
    }
  }

  start(): void {
    this.unsubscribeBus = this.eventBus.subscribe((event: PersistedEvent) => {
      if (event.type === "stream.emitted") {
        try {
          this.enqueue(event.streamItemId);
        } catch (err) {
          console.error("[stream-intake] error handling stream.emitted event:", err);
        }
      }
    });

    this.catchUp().catch((err) => {
      console.error("[stream-intake] error during startup catch-up:", err);
    });
  }

  stop(): void {
    if (this.unsubscribeBus) {
      this.unsubscribeBus();
      this.unsubscribeBus = undefined;
    }
  }

  private enqueue(streamItemId: string): void {
    if (this.getDestinationConfig() === "off") return;
    if (this.catchingUp) {
      if (!this.heldLiveItemIds.includes(streamItemId)) {
        this.heldLiveItemIds.push(streamItemId);
      }
      return;
    }
    if (!this.pendingStreamItemIdSet.has(streamItemId)) {
      this.pendingStreamItemIdSet.add(streamItemId);
      this.pendingStreamItemIds.push(streamItemId);
    }
    void this.drain();
  }

  private readCursor(): string | undefined {
    const row = this.db
      .prepare(`SELECT last_sort_key FROM stream_intake_cursor WHERE id = 1`)
      .get() as { last_sort_key: string } | undefined;
    return row?.last_sort_key;
  }

  private writeCursor(sortKey: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO stream_intake_cursor (id, last_sort_key, updated_at)
         VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET last_sort_key = excluded.last_sort_key, updated_at = excluded.updated_at`
      )
      .run(sortKey, now);
  }

  private async catchUp(): Promise<void> {
    this.catchingUp = true;
    try {
      let existingCursor: string | undefined;
      try {
        existingCursor = this.readCursor();
      } catch (err) {
        console.error("[stream-intake] failed to read cursor, preserving checkpoint without advancing:", err);
        return;
      }

      if (existingCursor === undefined) {
        // Record is truly missing: first start after upgrade or fresh install.
        // Record cursor at the newest stream item and do not replay older history.
        try {
          const newest = this.db
            .prepare(`SELECT stream_sort_key FROM stream_items ORDER BY stream_sort_key DESC LIMIT 1`)
            .get() as { stream_sort_key: string } | undefined;
          const initialSortKey = newest?.stream_sort_key ?? "";
          this.writeCursor(initialSortKey);
        } catch (err) {
          console.error("[stream-intake] failed to initialize cursor on first start:", err);
        }
        return;
      }

      if (this.getDestinationConfig() === "off") {
        return;
      }

      // Bound paging at the newest key that existed when catch-up started
      const newestAtStart = this.db
        .prepare(`SELECT stream_sort_key FROM stream_items ORDER BY stream_sort_key DESC LIMIT 1`)
        .get() as { stream_sort_key: string } | undefined;
      if (!newestAtStart?.stream_sort_key || newestAtStart.stream_sort_key <= existingCursor) {
        return;
      }
      const catchUpBoundKey = newestAtStart.stream_sort_key;

      let currentCursor = existingCursor;
      const PAGE_SIZE = 100;
      while (currentCursor < catchUpBoundKey) {
        const items = this.db
          .prepare(
            `SELECT stream_item_id, stream_sort_key FROM stream_items
             WHERE stream_sort_key > ? AND stream_sort_key <= ? AND archived_at IS NULL
             ORDER BY stream_sort_key ASC LIMIT ?`
          )
          .all(currentCursor, catchUpBoundKey, PAGE_SIZE) as Array<{ stream_item_id: string; stream_sort_key: string }>;

        if (items.length === 0) break;

        for (const item of items) {
          if (!this.pendingStreamItemIdSet.has(item.stream_item_id)) {
            this.pendingStreamItemIdSet.add(item.stream_item_id);
            this.pendingStreamItemIds.push(item.stream_item_id);
          }
        }

        currentCursor = items[items.length - 1]!.stream_sort_key;

        // Drain this page completely before fetching the next page
        await this.drain();

        if (items.length < PAGE_SIZE) break;

        // Yield between batches so startup work is bounded and does not starve other tasks
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    } finally {
      this.catchingUp = false;
      // Release held live items and drain
      if (this.heldLiveItemIds.length > 0) {
        for (const id of this.heldLiveItemIds) {
          if (!this.pendingStreamItemIdSet.has(id)) {
            this.pendingStreamItemIdSet.add(id);
            this.pendingStreamItemIds.push(id);
          }
        }
        this.heldLiveItemIds = [];
        void this.drain();
      }
    }
  }

  private async drain(): Promise<void> {
    if (this.processing || this.pendingStreamItemIds.length === 0) return;
    this.processing = true;

    try {
      if (this.getDestinationConfig() === "off") return;

      while (this.pendingStreamItemIds.length > 0) {
        const streamItemId = this.pendingStreamItemIds[0]!;
        const item = this.streamStore.getById(streamItemId);
        if (!item) {
          this.pendingStreamItemIds.shift();
          this.pendingStreamItemIdSet.delete(streamItemId);
          continue;
        }

        const destination = this.resolveDestination();
        if (!destination) {
          // Destination is not ready or does not resolve (e.g. no kernel queue worker yet).
          // Do not throw; leave items pending for a later attempt.
          break;
        }

        try {
          await this.handleStreamItem(item, destination);
          this.pendingStreamItemIds.shift();
          this.pendingStreamItemIdSet.delete(streamItemId);
        } catch (err) {
          console.error("[stream-intake] failed to handle stream item:", err);
          // Leave the item pending and stop drain loop to retry later
          break;
        }
      }
    } catch (err) {
      console.error("[stream-intake] unexpected drain error:", err);
    } finally {
      this.processing = false;
    }
  }

  private async handleStreamItem(item: StreamItem, destination: string): Promise<void> {
    const cursor = this.readCursor();
    if (cursor && cursor !== "" && item.streamSortKey <= cursor) {
      return;
    }

    const isUrgent = item.hintUrgency === "critical" || Boolean(item.interrupt);

    // Check if there is an existing unclaimed intake queue row for this destination
    const existingRows = this.queueRepo.list({
      destinationSession: destination,
      state: "pending",
      tag: STREAM_INTAKE_TAG,
      limit: 1,
    });
    const existing = existingRows[0];

    if (existing) {
      let promoted = false;
      let persistedEvents: PersistedEvent[] = [];
      const note = formatIntakeNote(item, isUrgent);

      // Atomically update priority, add transition note, and advance cursor together
      this.db.transaction(() => {
        if (isUrgent && existing.priority !== "urgent" && existing.priority !== "critical") {
          this.db.prepare("UPDATE queue_items SET priority = 'urgent' WHERE qitem_id = ?").run(existing.qitemId);
          promoted = true;
        }

        const updateResult = this.queueRepo.updateWithinTransaction({
          qitemId: existing.qitemId,
          actorSession: "daemon@kernel",
          transitionNote: note,
        });
        persistedEvents = updateResult.persistedEvents;

        this.writeCursor(item.streamSortKey);
      })();

      // Post-commit side effects: notify subscribers and maybe nudge
      this.queueRepo.notifyCommitted(persistedEvents);

      if (promoted) {
        try {
          await this.queueRepo.maybeNudge(existing.qitemId, destination, true, "daemon@kernel", undefined, "openrig");
        } catch (err) {
          console.error("[stream-intake] failed to re-wake destination after urgent promotion:", err);
        }
      }
      return;
    }

    // Open a new intake row
    const qitemId = streamIntakeQitemId(item.streamSortKey);
    const body = formatIntakeBody(item);
    const summary = boundText(`1 new stream observation(s) from ${item.sourceSession}`, 200);

    let createResult:
      | { qitemId: string; persistedEvent: PersistedEvent; destinationSession: string; nudge?: boolean; wakeStaged?: boolean }
      | undefined;

    try {
      this.db.transaction(() => {
        createResult = this.queueRepo.createWithinTransaction({
          qitemId,
          sourceSession: "daemon@kernel",
          destinationSession: destination,
          body,
          summary,
          tags: [STREAM_INTAKE_TAG],
          priority: isUrgent ? "urgent" : "routine",
        });

        this.writeCursor(item.streamSortKey);
      })();
    } catch (err) {
      // If already exists with same ID (e.g. race or restart), treat as handled and advance cursor
      if (
        err instanceof Error &&
        (err.message.includes("already exists") || err.message.includes("UNIQUE constraint failed: queue_items.qitem_id"))
      ) {
        this.writeCursor(item.streamSortKey);
        return;
      }
      throw err;
    }

    if (createResult) {
      this.eventBus.notifySubscribers(createResult.persistedEvent);
      if (createResult.wakeStaged) {
        this.queueRepo.deliverWakeIntentAfterCommit(`${WAKE_INTENT_PREFIX}${createResult.qitemId}`);
      } else {
        try {
          await this.queueRepo.maybeNudge(
            createResult.qitemId,
            createResult.destinationSession,
            createResult.nudge,
            "daemon@kernel",
            undefined,
            undefined
          );
        } catch (err) {
          console.error("[stream-intake] failed to nudge destination for new intake row:", err);
        }
      }
    }
  }

  private resolveDestination(): string | undefined {
    const configured = this.getDestinationConfig();
    if (configured === "off") return undefined;

    if (configured === "queue.worker") {
      try {
        const row = this.db
          .prepare(
            `SELECT s.session_name FROM sessions s JOIN nodes n ON n.id = s.node_id JOIN rigs r ON r.id = n.rig_id
             WHERE r.name = 'kernel' AND n.logical_id = 'queue.worker'
             ORDER BY s.id DESC LIMIT 1`
          )
          .get() as { session_name: string } | undefined;
        if (row?.session_name && this.queueRepo.acceptsDestination(row.session_name)) {
          return row.session_name;
        }
      } catch {
        // Fallback or database error
      }
      if (this.queueRepo.acceptsDestination("queue.worker")) {
        return "queue.worker";
      }
      return undefined;
    }

    if (this.queueRepo.acceptsDestination(configured)) {
      return configured;
    }
    return undefined;
  }
}

/**
 * Bounds display text with an honest ellipsis when truncated.
 */
export function boundText(val: string | undefined | null, maxLen = 120): string {
  if (val === undefined || val === null || val === "") return "none";
  const str = String(val).trim();
  if (str.length <= maxLen) return str;
  return str.slice(0, Math.max(0, maxLen - 3)) + "...";
}

export function formatIntakeBody(item: StreamItem): string {
  const boundedId = boundText(item.streamItemId, 120);
  const boundedSource = boundText(item.sourceSession, 120);
  const boundedEmitted = boundText(item.tsEmitted, 60);
  const boundedType = boundText(item.hintType, 80);
  const boundedUrgency = boundText(item.hintUrgency, 40);
  const boundedDestination = boundText(item.hintDestination, 120);
  const rawTags = (item.hintTags ?? []).join(",");
  const boundedTags = rawTags ? boundText(rawTags, 160) : "none";
  const boundedSortKey = boundText(item.streamSortKey, 120);

  return [
    `# Stream observation intake: ${boundedId}`,
    "",
    `- stream_item_id: ${boundedId}`,
    `- source: ${boundedSource}`,
    `- emitted: ${boundedEmitted}`,
    `- hints: type=${boundedType}, urgency=${boundedUrgency}, destination=${boundedDestination}, tags=${boundedTags}`,
    `- cursor: rig stream list --after ${boundedSortKey}`,
  ].join("\n");
}

export function formatIntakeNote(item: StreamItem, isUrgent: boolean): string {
  const boundedId = boundText(item.streamItemId, 120);
  const boundedSource = boundText(item.sourceSession, 120);
  const boundedType = boundText(item.hintType, 80);
  const boundedUrgency = boundText(item.hintUrgency, 40);
  const boundedDestination = boundText(item.hintDestination, 120);

  return `Stream observation added: ${boundedId} (${boundedSource})${isUrgent ? " [promoted to urgent]" : ""} - hints: type=${boundedType}, urgency=${boundedUrgency}, destination=${boundedDestination}`;
}
