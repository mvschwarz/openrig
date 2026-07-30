// Slice-11 slack-connector — INBOUND orchestration (Socket Mode → queue).
//
// Locked items: 4 (human message → durable qitem on operator-agent@kernel,
// config-overridable), 8 (never-drop: fast-ack the transport, dead-letter every
// event that fails to land BEFORE returning, seen-mark ONLY after the durable
// qitem exists, in-flight per-event-ts dedup), plus loop-safety (never ingest
// bot/own posts) and T1076 (file/image events ignored CLEANLY in v1).
//
// The WebSocket/ack transport lives in the CLI runner; this module is the pure,
// fully-testable core: shouldIngest (filter), route (land + dedup + dead-letter),
// retryDeadLetters, and handleEnvelope (fast-ack + dispatch).
import type { SeenStore, DeadLetterStore, DeadLetterEntry } from "./state-store.js";
import type { QueueRunner } from "./queue-bridge.js";
import { createQitem } from "./queue-bridge.js";

export interface SlackEvent {
  type?: string;
  subtype?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  ts?: string;
  channel?: string;
  files?: unknown[];
}

/**
 * Loop-safety + non-text ignore. Ingest ONLY genuine human text messages:
 * reject bot posts (our own loop), message subtypes (edits/joins/file_share),
 * and — T1076 — anything carrying files/images. v1 ignores non-text CLEANLY:
 * a false return is a clean skip, never a crash or partial ingestion.
 */
export function shouldIngest(ev: SlackEvent): boolean {
  if (ev.type !== "message" && ev.type !== "app_mention") return false;
  if (ev.bot_id) return false; // never ingest our own / any bot post
  if (ev.subtype) return false; // edits, joins, file_share, etc.
  if (ev.files && ev.files.length > 0) return false; // T1076: image/file events ignored cleanly (Slice-12)
  if (!ev.user || !ev.text || !ev.text.trim()) return false;
  return true;
}

export interface InboundDeps {
  runner: QueueRunner;
  seen: SeenStore;
  deadLetter: DeadLetterStore<SlackEvent>;
  destination: string; // first-class config; default operator-agent@kernel
  sourceLabel?: string;
  log?: (msg: string) => void;
}

export class InboundRouter {
  private readonly inflight = new Set<string>(); // same-ts double-dispatch guard (item 8)
  constructor(private readonly deps: InboundDeps) {}

  private summaryOf(ev: SlackEvent): { summary: string; body: string } {
    const text = String(ev.text ?? "").slice(0, 1800);
    const meta = `slack channel=${ev.channel} user=${ev.user} ts=${ev.ts}`;
    return {
      summary: `Founder via Slack: ${text.slice(0, 90)}`,
      body: `${text}\n\n---\nSource: ${meta}\nRouted by openrig slack-inbound. Default destination per config; re-route via queue as needed.`,
    };
  }

  /**
   * Core landing attempt — NO dead-letter side effect. Dedup by ts (in-flight +
   * durable seen). `reason` distinguishes a dedup skip from a genuine create
   * failure so callers dead-letter ONLY real failures. On success, marks seen
   * (durable qitem exists → safe).
   */
  private async attemptLand(ev: SlackEvent): Promise<{ landed: boolean; qitemId?: string; reason?: "dup" | "create_failed" }> {
    const ts = ev.ts ?? "";
    if (!ts || this.inflight.has(ts) || this.deps.seen.load().has(ts)) return { landed: false, reason: "dup" };
    this.inflight.add(ts);
    try {
      const { summary, body } = this.summaryOf(ev);
      let qitemId: string;
      try {
        qitemId = await createQitem(this.deps.runner, {
          source: `human-${ev.user}@kernel`, // provenance classifies as human (name convention)
          destination: this.deps.destination,
          priority: "routine",
          tags: ["founder-slack", "inbound"],
          summary,
          body,
        });
      } catch (e) {
        this.deps.log?.(`qitem create failed ts=${ts}: ${(e as Error).message}`);
        return { landed: false, reason: "create_failed" };
      }
      this.deps.seen.mark(ts, "landed"); // durable qitem exists → safe to mark
      this.deps.log?.(`qitem ${qitemId} -> ${this.deps.destination} (ts=${ts})`);
      return { landed: true, qitemId };
    } finally {
      this.inflight.delete(ts);
    }
  }

  /**
   * LIVE path: attempt to land; on a genuine create failure, dead-letter the
   * event (attempt-counted) BEFORE returning — NOT marked seen (item 8).
   */
  async route(ev: SlackEvent, attempts = 0): Promise<{ landed: boolean; qitemId?: string }> {
    const r = await this.attemptLand(ev);
    if (!r.landed && r.reason === "create_failed") {
      this.deps.deadLetter.append(ev, attempts + 1);
      this.deps.log?.(`dead-lettered ts=${ev.ts} (attempt ${attempts + 1})`);
    }
    return { landed: r.landed, qitemId: r.qitemId };
  }

  /**
   * INTERRUPTION-SAFE retry (item 8): read the durable set NON-destructively,
   * attempt each, then ATOMICALLY replace the file with only the still-failing
   * entries. The original file stays intact until the atomic replace, so a crash
   * at any point loses nothing (a since-landed event is skipped via the seen-set).
   * Does NOT go through route() (which would double-append) — uses attemptLand.
   */
  async retryDeadLetters(): Promise<{ retried: number; landed: number }> {
    const entries = this.deps.deadLetter.readAll();
    if (entries.length === 0) return { retried: 0, landed: 0 };
    this.deps.log?.(`retrying ${entries.length} dead-letter(s)`);
    const stillFailing: DeadLetterEntry<SlackEvent>[] = [];
    let landed = 0;
    const seen = this.deps.seen.load();
    for (const e of entries) {
      if (e.ev.ts && seen.has(e.ev.ts)) continue; // already landed → recovered, drop from set
      const r = await this.attemptLand(e.ev);
      if (r.landed) landed++;
      else if (r.reason === "create_failed") stillFailing.push({ ev: e.ev, at: e.at, attempts: e.attempts + 1 });
      // reason === "dup" (in-flight) → drop; a concurrent path owns it
    }
    this.deps.deadLetter.replaceAll(stillFailing); // atomic; original intact until here
    return { retried: entries.length, landed };
  }
}

export interface SocketEnvelope {
  envelope_id?: string;
  type?: string;
  reason?: string;
  payload?: { event?: SlackEvent };
}

/**
 * Handle one Socket Mode envelope. FAST-ACK first, ALWAYS (item 8: Socket Mode
 * punishes slow acks; transport redelivery is not the safety net). Then filter
 * and route. Ack happens even if routing later fails — the dead-letter, not
 * transport redelivery, is the zero-drop net.
 */
export async function handleEnvelope(env: SocketEnvelope, ack: () => void, router: InboundRouter, log?: (m: string) => void): Promise<void> {
  if (env.envelope_id) ack(); // fast-ack, unconditional, first
  if (env.type === "disconnect") return;
  if (env.type !== "events_api") return;
  const ev = env.payload?.event ?? {};
  if (!shouldIngest(ev)) {
    if (ev.type) log?.(`ignored non-ingestible event type=${ev.type} subtype=${ev.subtype ?? "-"} files=${ev.files?.length ?? 0}`);
    return;
  }
  await router.route(ev);
}
