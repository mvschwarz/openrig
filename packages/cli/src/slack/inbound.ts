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
/** P28 — the rejection BRANCH, as data. The ignore path used to log type/subtype/files, which
 *  are precisely the fields that have all PASSED when a message dies on bot_id or on
 *  missing-user/empty-text — so a silent discard could not be explained, and with `channels:read`
 *  ungranted there was no read that could even name the source conversation. This is the SINGLE
 *  definition of the ingest decision; `shouldIngest` is a thin wrapper over it so the branch logic
 *  has one origin and the log can never drift from the behaviour it describes. */
export type IngestReason = "type" | "bot_id" | "subtype" | "files" | "no-user" | "empty-text";

export function ingestDecision(ev: SlackEvent): { ingest: true } | { ingest: false; reason: IngestReason } {
  if (ev.type !== "message" && ev.type !== "app_mention") return { ingest: false, reason: "type" };
  if (ev.bot_id) return { ingest: false, reason: "bot_id" }; // never ingest our own / any bot post
  if (ev.subtype) return { ingest: false, reason: "subtype" }; // edits, joins, file_share, etc.
  if (ev.files && ev.files.length > 0) return { ingest: false, reason: "files" }; // T1076 (Slice-12)
  if (!ev.user) return { ingest: false, reason: "no-user" };
  if (!ev.text || !ev.text.trim()) return { ingest: false, reason: "empty-text" };
  return { ingest: true };
}

export function shouldIngest(ev: SlackEvent): boolean {
  return ingestDecision(ev).ingest;
}

/** A6 v3: the sender-admission verdict. An inbound Slack message may become a human-provenance
 *  qitem ONLY if its sender resolves to a REGISTERED human (admit-iff-registered); the stamped
 *  `source` is that human's canonical ref (never a raw platform id). An unregistered sender — or a
 *  registry that itself failed to load — is REFUSED with LOUD teaching, never a fabricated seat. */
export type InboundSenderResolution =
  | { admitted: true; source: string }
  | { admitted: false; teaching: string };

export interface InboundDeps {
  runner: QueueRunner;
  seen: SeenStore;
  deadLetter: DeadLetterStore<SlackEvent>;
  destination: string; // first-class config; default operator-agent@kernel
  /** A6 v3 registration gate. Resolves ev.user -> a registered human (or refuses). Injected so
   *  this core stays pure/testable; the runner wires it via the daemon human-registry resolver. */
  resolveSender: (slackUserId: string) => InboundSenderResolution;
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
  private async attemptLand(ev: SlackEvent): Promise<{ landed: boolean; qitemId?: string; reason?: "dup" | "create_failed" | "unregistered" }> {
    const ts = ev.ts ?? "";
    if (!ts || this.inflight.has(ts) || this.deps.seen.load().has(ts)) return { landed: false, reason: "dup" };
    // A6 v3 registration gate: admit-iff-registered. An unregistered sender is REFUSED here —
    // never landed as a fabricated human-<slackid>@kernel seat. This is a POLICY refusal, not a
    // transient failure, so it is NOT dead-lettered (retrying can't help until the human registers).
    const who = this.deps.resolveSender(ev.user ?? "");
    if (!who.admitted) {
      this.deps.log?.(`inbound REFUSED — unregistered sender ${ev.user} (ts=${ts}): ${who.teaching}`);
      return { landed: false, reason: "unregistered" };
    }
    this.inflight.add(ts);
    try {
      const { summary, body } = this.summaryOf(ev);
      let qitemId: string;
      try {
        qitemId = await createQitem(this.deps.runner, {
          source: who.source, // the REGISTERED human's canonical ref (human-class), never a raw platform id
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
  const decision = ingestDecision(ev);
  if (!decision.ingest) {
    // P28: name the branch that FIRED and the conversation it came from. Privacy rail — a channel
    // id and a branch LABEL only: never bodies, tokens, user ids, or text content/length.
    if (ev.type) {
      log?.(
        `ignored non-ingestible event type=${ev.type} subtype=${ev.subtype ?? "-"} files=${ev.files?.length ?? 0}` +
          ` channel=${ev.channel ?? "-"} reason=${decision.reason}`,
      );
    }
    return;
  }
  await router.route(ev);
}
