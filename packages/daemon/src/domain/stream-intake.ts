import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import type { EventBus } from "./event-bus.js";
import type { PersistedEvent } from "./types.js";
import type { StreamItem, StreamStore } from "./stream-store.js";
import type { QueueRepository } from "./queue-repository.js";
import { SettingsStore } from "./user-settings/settings-store.js";

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
  private processing = false;

  constructor(deps: StreamIntakeCoordinatorDeps) {
    this.db = deps.db;
    this.eventBus = deps.eventBus;
    this.streamStore = deps.streamStore;
    this.queueRepo = deps.queueRepo;
    this.rawDestination = deps.destination;
    this.ensureCursorTable();
  }

  private ensureCursorTable(): void {
    try {
      this.db.exec(
        `CREATE TABLE IF NOT EXISTS stream_intake_cursor (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          last_sort_key TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );`
      );
    } catch (err) {
      console.error("[stream-intake] failed to ensure cursor table:", err);
    }
  }

  private getDestinationConfig(): string {
    if (typeof this.rawDestination === "function") {
      return this.rawDestination().trim();
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
    if (this.getDestinationConfig() === "off") return;

    this.unsubscribeBus = this.eventBus.subscribe((event: PersistedEvent) => {
      if (event.type === "stream.emitted") {
        try {
          this.enqueue(event.streamItemId);
        } catch (err) {
          console.error("[stream-intake] error handling stream.emitted event:", err);
        }
      }
    });

    try {
      this.catchUp();
    } catch (err) {
      console.error("[stream-intake] error during startup catch-up:", err);
    }
  }

  stop(): void {
    if (this.unsubscribeBus) {
      this.unsubscribeBus();
      this.unsubscribeBus = undefined;
    }
  }

  private enqueue(streamItemId: string): void {
    if (!this.pendingStreamItemIds.includes(streamItemId)) {
      this.pendingStreamItemIds.push(streamItemId);
    }
    void this.drain();
  }

  private getCursor(): string | null {
    try {
      const row = this.db
        .prepare(`SELECT last_sort_key FROM stream_intake_cursor WHERE id = 1`)
        .get() as { last_sort_key: string } | undefined;
      return row ? row.last_sort_key : null;
    } catch {
      return null;
    }
  }

  private updateCursor(sortKey: string): void {
    try {
      const now = new Date().toISOString();
      this.db
        .prepare(
          `INSERT INTO stream_intake_cursor (id, last_sort_key, updated_at)
           VALUES (1, ?, ?)
           ON CONFLICT(id) DO UPDATE SET last_sort_key = excluded.last_sort_key, updated_at = excluded.updated_at`
        )
        .run(sortKey, now);
    } catch (err) {
      console.error("[stream-intake] failed to update cursor:", err);
    }
  }

  private catchUp(): void {
    const existingCursor = this.getCursor();
    if (existingCursor === null) {
      // First start after upgrade or fresh install:
      // Record a cursor at the newest stream item and do not replay older history.
      const newest = this.db
        .prepare(`SELECT stream_sort_key FROM stream_items ORDER BY stream_sort_key DESC LIMIT 1`)
        .get() as { stream_sort_key: string } | undefined;
      const initialSortKey = newest?.stream_sort_key ?? "";
      this.updateCursor(initialSortKey);
      return;
    }

    // Existing cursor: page through stream items emitted since cursor in bounded pages
    let currentCursor = existingCursor;
    const PAGE_SIZE = 100;
    while (true) {
      const items = this.db
        .prepare(
          `SELECT stream_item_id, stream_sort_key FROM stream_items
           WHERE stream_sort_key > ? AND archived_at IS NULL
           ORDER BY stream_sort_key ASC LIMIT ?`
        )
        .all(currentCursor, PAGE_SIZE) as Array<{ stream_item_id: string; stream_sort_key: string }>;

      if (items.length === 0) break;

      for (const item of items) {
        if (!this.pendingStreamItemIds.includes(item.stream_item_id)) {
          this.pendingStreamItemIds.push(item.stream_item_id);
        }
      }

      currentCursor = items[items.length - 1]!.stream_sort_key;
      if (items.length < PAGE_SIZE) break;
    }

    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.processing || this.pendingStreamItemIds.length === 0 || this.getDestinationConfig() === "off") return;
    this.processing = true;

    try {
      while (this.pendingStreamItemIds.length > 0) {
        const streamItemId = this.pendingStreamItemIds[0]!;
        const item = this.streamStore.getById(streamItemId);
        if (!item) {
          this.pendingStreamItemIds.shift();
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
          this.updateCursor(item.streamSortKey);
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
      // Promote priority if incoming item is critical or interrupt
      if (isUrgent && existing.priority !== "urgent" && existing.priority !== "critical") {
        this.db.prepare("UPDATE queue_items SET priority = 'urgent' WHERE qitem_id = ?").run(existing.qitemId);
      }

      // Add note to the existing unclaimed intake row
      const note = `Stream observation added: ${item.streamItemId} (${item.sourceSession})${isUrgent ? " [promoted to urgent]" : ""} - hints: type=${item.hintType ?? "none"}, urgency=${item.hintUrgency ?? "none"}`;
      this.queueRepo.update({
        qitemId: existing.qitemId,
        actorSession: "daemon@kernel",
        transitionNote: note,
      });
      return;
    }

    // Open a new intake row
    const qitemId = streamIntakeQitemId(item.streamSortKey);
    const body = formatIntakeBody(item);

    try {
      await this.queueRepo.create({
        qitemId,
        sourceSession: "daemon@kernel",
        destinationSession: destination,
        body,
        summary: `1 new stream observation(s) from ${item.sourceSession}`.slice(0, 200),
        tags: [STREAM_INTAKE_TAG],
        priority: isUrgent ? "urgent" : "routine",
      });
    } catch (err) {
      // If already exists with same ID (e.g. race or restart), treat as handled
      if (err instanceof Error && err.message.includes("already exists")) {
        return;
      }
      throw err;
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

function formatIntakeBody(item: StreamItem): string {
  return [
    `# Stream observation intake: ${item.streamItemId}`,
    "",
    `- stream_item_id: ${item.streamItemId}`,
    `- source: ${item.sourceSession}`,
    `- emitted: ${item.tsEmitted}`,
    `- hints: type=${item.hintType ?? "none"}, urgency=${item.hintUrgency ?? "none"}, destination=${item.hintDestination ?? "none"}, tags=${(item.hintTags ?? []).join(",") || "none"}`,
    `- cursor: rig stream list --after ${item.streamSortKey}`,
  ].join("\n");
}
