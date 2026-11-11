import type { EventBus } from "./event-bus.js";
import type { PersistedEvent } from "./types.js";

// A harness's own prompt hook (UserPromptSubmit) says what its input took; a delivery-evidence record says what OpenRig
// wrote. Neither carries an OpenRig message id, so the two are matched only as a candidate join on the written text: the
// same session and occupant generation, an equal fingerprint and byte length, the write no later than the hook, and
// exactly one candidate on the other side. A match records that message's input boundary as observed. Anything else
// (no candidate, two, a different generation, a stale entry, a daemon that restarted between the two) records nothing,
// so the boundary stays unknown. Either side can arrive first: the hook may reach the daemon before the send returns.

/** One written message, as its delivery-evidence record gave it. */
export interface BoundaryWrite { sessionName: string; generation: string; sha256: string; bytes: number; writtenAt: string; messageId: string; attemptId: string }
/** One prompt hook's facts, as the relay sent them. */
export interface BoundaryHook {
  sessionName: string; generation: string; sha256: string; bytes: number; occurredAt: string;
  runtime: string | null; nativePromptId: string | null; nativeTurnId: string | null;
}

const PER_SESSION = 20;
const WINDOW_MS = 10 * 60_000;

type Entry<T> = T & { at: number; matched: boolean };

export class InputBoundaryCorrelator {
  private writes = new Map<string, Entry<BoundaryWrite>[]>();
  private hooks = new Map<string, Entry<BoundaryHook>[]>();

  constructor(private readonly eventBus: EventBus, private readonly now: () => number = Date.now) {}

  /** A delivery-evidence record. Only a write whose text reached the input, with its generation known, can match. */
  noteRecord(event: PersistedEvent): void {
    if (event.type !== "transport.delivery_evidence") return;
    if (event.written !== "submitted" && event.written !== "text_submit_unknown") return;
    if (!event.occupantGeneration || !event.wireSha256 || event.wireBytes === null || !event.writtenAt) return;
    const write: BoundaryWrite = { sessionName: event.sessionName, generation: event.occupantGeneration, sha256: event.wireSha256,
      bytes: event.wireBytes, writtenAt: event.writtenAt, messageId: event.messageId, attemptId: event.attemptId };
    const hook = this.single(this.hooks, write.sessionName, (h) => same(write, h) && write.writtenAt <= h.occurredAt);
    if (hook) this.record(write, hook);
    else this.keep(this.writes, write);
  }

  /** A prompt hook. */
  noteHook(hook: BoundaryHook): void {
    const write = this.single(this.writes, hook.sessionName, (w) => same(w, hook) && w.writtenAt <= hook.occurredAt);
    if (write) this.record(write, hook);
    else this.keep(this.hooks, hook);
  }

  /** The one unmatched entry that fits, marked matched; null for none or more than one. */
  private single<T>(index: Map<string, Entry<T>[]>, sessionName: string, fits: (entry: T) => boolean): Entry<T> | null {
    const live = this.prune(index, sessionName);
    const candidates = live.filter((entry) => !entry.matched && fits(entry));
    if (candidates.length !== 1) return null;
    candidates[0]!.matched = true;
    return candidates[0]!;
  }

  private keep<T>(index: Map<string, Entry<T>[]>, value: T & { sessionName: string }): void {
    const live = this.prune(index, value.sessionName);
    live.push({ ...value, at: this.now(), matched: false });
    index.set(value.sessionName, live.slice(-PER_SESSION));
  }

  private prune<T>(index: Map<string, Entry<T>[]>, sessionName: string): Entry<T>[] {
    const cutoff = this.now() - WINDOW_MS;
    const live = (index.get(sessionName) ?? []).filter((entry) => entry.at >= cutoff);
    index.set(sessionName, live);
    return live;
  }

  private record(write: BoundaryWrite, hook: BoundaryHook): void {
    try {
      this.eventBus.emit({
        type: "transport.input_boundary", sessionName: write.sessionName, occupantGeneration: write.generation,
        messageId: write.messageId, attemptId: write.attemptId, observed: "UserPromptSubmit", runtime: hook.runtime,
        nativePromptId: hook.nativePromptId, nativeTurnId: hook.nativeTurnId, observedAt: hook.occurredAt,
      });
    } catch { /* Best effort: a record that can't be written leaves the boundary unknown. */ }
  }
}

function same(write: { generation: string; sha256: string; bytes: number }, hook: { generation: string; sha256: string; bytes: number }): boolean {
  return write.generation === hook.generation && write.sha256 === hook.sha256 && write.bytes === hook.bytes;
}

const correlators = new WeakMap<EventBus, InputBoundaryCorrelator>();

/** The correlator for this event bus, created and subscribed on first use (startup creates it, so no write is missed). */
export function inputBoundaryCorrelatorFor(eventBus: EventBus): InputBoundaryCorrelator {
  let correlator = correlators.get(eventBus);
  if (!correlator) {
    const created = new InputBoundaryCorrelator(eventBus);
    eventBus.subscribe((event) => created.noteRecord(event));
    correlators.set(eventBus, created);
    correlator = created;
  }
  return correlator;
}
