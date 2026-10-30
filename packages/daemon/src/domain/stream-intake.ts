import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import type { EventBus } from "./event-bus.js";
import type { PersistedEvent } from "./types.js";
import type { StreamItem, StreamStore } from "./stream-store.js";
import type { QueueRepository } from "./queue-repository.js";

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
  destination?: string; // e.g. "queue.worker" (default) or "off"
}

export class StreamIntakeCoordinator {
  private readonly db: Database.Database;
  private readonly eventBus: EventBus;
  private readonly streamStore: StreamStore;
  private readonly queueRepo: QueueRepository;
  private readonly destination: string;
  private unsubscribeBus?: () => void;
  private pendingSortKeys: string[] = [];
  private processing = false;

  constructor(deps: StreamIntakeCoordinatorDeps) {
    this.db = deps.db;
    this.eventBus = deps.eventBus;
    this.streamStore = deps.streamStore;
    this.queueRepo = deps.queueRepo;
    this.destination = (deps.destination ?? "queue.worker").trim();
  }

  start(): void {
    if (this.destination === "off") return;

    this.unsubscribeBus = this.eventBus.subscribe((event: PersistedEvent) => {
      if (event.type === "stream.emitted") {
        this.enqueue(event.streamItemId);
      }
    });

    // Startup catch-up: process any stream items that haven't been associated with an intake qitem
    this.catchUp();
  }

  stop(): void {
    if (this.unsubscribeBus) {
      this.unsubscribeBus();
      this.unsubscribeBus = undefined;
    }
  }

  private enqueue(streamItemId: string): void {
    const item = this.streamStore.getById(streamItemId);
    if (!item) return;
    this.pendingSortKeys.push(item.streamSortKey);
    void this.drain();
  }

  private catchUp(): void {
    // Find all stream items emitted that are not yet covered by an intake qitem or note
    const unhandled = this.findUnhandledStreamItems();
    for (const item of unhandled) {
      this.pendingSortKeys.push(item.streamSortKey);
    }
    void this.drain();
  }

  private findUnhandledStreamItems(): StreamItem[] {
    // A stream item is handled if its ID is in an intake qitem body or a transition note
    const handledRows = this.db
      .prepare(
        `SELECT qitem_id, body FROM queue_items
         WHERE json_valid(tags) AND EXISTS (SELECT 1 FROM json_each(tags) WHERE value = ?)`
      )
      .all(STREAM_INTAKE_TAG) as Array<{ qitem_id: string; body: string }>;

    const handledIds = new Set<string>();
    for (const r of handledRows) {
      const matches = r.body.match(/stream_item_id:\s*([^\s\n]+)/g);
      if (matches) {
        for (const m of matches) {
          const id = m.replace(/stream_item_id:\s*/, "").trim();
          if (id) handledIds.add(id);
        }
      }
    }

    const noteRows = this.db
      .prepare(
        `SELECT transition_note FROM queue_transitions
         WHERE transition_note LIKE 'Stream observation added: %'`
      )
      .all() as Array<{ transition_note: string }>;

    for (const n of noteRows) {
      const match = n.transition_note.match(/Stream observation added:\s*([^\s(]+)/);
      if (match?.[1]) handledIds.add(match[1]);
    }

    const allItems = this.streamStore.list({ limit: 500, direction: "chronological" });
    return allItems.filter((i) => !handledIds.has(i.streamItemId));
  }

  private async drain(): Promise<void> {
    if (this.processing || this.pendingSortKeys.length === 0 || this.destination === "off") return;
    this.processing = true;

    try {
      while (this.pendingSortKeys.length > 0) {
        const sortKey = this.pendingSortKeys.shift()!;
        const items = this.streamStore.list({ limit: 10, since: undefined, includeArchived: false });
        const item = items.find((i) => i.streamSortKey === sortKey);
        if (!item) continue;

        await this.handleStreamItem(item);
      }
    } finally {
      this.processing = false;
    }
  }

  private async handleStreamItem(item: StreamItem): Promise<void> {
    const destination = this.resolveDestination();
    if (destination === "off") return;

    // Check if there is an existing unclaimed intake queue row for this destination
    const existing = this.queueRepo.list({
      destinationSession: destination,
      state: "pending",
      limit: 10,
    }).find((row) => (row.tags ?? []).includes(STREAM_INTAKE_TAG));

    if (existing) {
      // Add a note to the existing unclaimed intake row
      const note = `Stream observation added: ${item.streamItemId} (${item.sourceSession}) - ${firstLine(item.body)}`;
      this.queueRepo.update({
        qitemId: existing.qitemId,
        actorSession: "daemon@kernel",
        transitionNote: note,
      });
      return;
    }

    // Open a new intake row
    const qitemId = streamIntakeQitemId(item.streamSortKey);
    const isUrgent = item.hintUrgency === "critical" || item.interrupt;
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
      // If already exists with same ID (e.g. race or restart), that's fine/idempotent
      if (err instanceof Error && err.message.includes("already exists")) {
        return;
      }
      throw err;
    }
  }

  private resolveDestination(): string {
    if (this.destination === "off") return "off";
    if (this.destination !== "queue.worker") return this.destination;
    // When "queue.worker", resolve canonical session name if kernel rig is running
    try {
      const row = this.db.prepare(
        `SELECT s.session_name FROM sessions s JOIN nodes n ON n.id = s.node_id JOIN rigs r ON r.id = n.rig_id
         WHERE r.name = 'kernel' AND n.logical_id = 'queue.worker'
         ORDER BY s.id DESC LIMIT 1`
      ).get() as { session_name: string } | undefined;
      if (row?.session_name) return row.session_name;
    } catch {
      // Fallback
    }
    return this.destination;
  }
}

function firstLine(text: string): string {
  const line = text.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return line.length > 80 ? `${line.slice(0, 77)}...` : line;
}

function formatIntakeBody(item: StreamItem): string {
  return [
    `# Stream observation intake: ${item.streamItemId}`,
    "",
    `- **stream_item_id:** ${item.streamItemId}`,
    `- **source:** ${item.sourceSession}`,
    `- **emitted:** ${item.tsEmitted}`,
    `- **hints:** type=${item.hintType ?? "none"}, urgency=${item.hintUrgency ?? "none"}, destination=${item.hintDestination ?? "none"}, tags=${(item.hintTags ?? []).join(",") || "none"}`,
    `- **cursor:** rig stream list --after ${item.streamSortKey}`,
    "",
    "## Body",
    "",
    item.body,
  ].join("\n");
}
