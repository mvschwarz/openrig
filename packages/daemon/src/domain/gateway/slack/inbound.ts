// Slice-11 slack-connector — INBOUND orchestration (Socket Mode → queue).
//
// Locked items: 4 (human message → durable qitem on operator-agent@kernel,
// config-overridable), 8 (never-drop: fast-ack the transport, dead-letter every
// event that fails to land BEFORE returning, seen-mark ONLY after the durable
// qitem exists, in-flight per-event-ts dedup), plus loop-safety (never ingest
// bot/own posts) and T1076 (file/image events ignored CLEANLY in v1).
//
// The WebSocket/ack transport lives in the daemon's socket-inbound service (S10: in-daemon
// subsystem — the CLI runner retired); this module is the pure, fully-testable core:
// shouldIngest (filter), route (land + dedup + dead-letter), retryDeadLetters, and
// handleEnvelope (fast-ack + dispatch). S10 re-home: the queue seam is an in-process PORT
// (queue-access.ts adapts QueueRepository) — the rig-CLI shell-out bridge retired with the
// relay runners; the durability semantics around it are unchanged.
import type { SeenStore, DeadLetterStore, DeadLetterEntry } from "./state-store.js";
import type { InboundQueuePort } from "./queue-access.js";

export interface SlackEvent {
  type?: string;
  subtype?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  ts?: string;
  /** S10 thread routing: present on a threaded reply (= the PARENT root's ts). Absent on a
   *  top-level channel message. The affordance discriminator: thread_ts==ts parent,
   *  thread_ts!=ts reply, absent plain. */
  thread_ts?: string;
  channel?: string;
  files?: unknown[];
}

/**
 * Loop-safety + non-ingestible ignore. Ingest genuine human messages — text,
 * and (OPR.0.5.6.2, replacing the T1076 v1 ignore) file-bearing drops: a
 * `file_share` subtype with files[] is THE shape a human upload arrives as,
 * and a pure drop legitimately has no caption, so empty text is admissible
 * when files are present. Loop safety is untouched: bot posts and every other
 * subtype (edits/joins) stay rejected, and a false return remains a clean
 * skip, never a crash or partial ingestion.
 */
/** P28 — the rejection BRANCH, as data. The ignore path used to log type/subtype/files, which
 *  are precisely the fields that have all PASSED when a message dies on bot_id or on
 *  missing-user/empty-text — so a silent discard could not be explained, and with `channels:read`
 *  ungranted there was no read that could even name the source conversation. This is the SINGLE
 *  definition of the ingest decision; `shouldIngest` is a thin wrapper over it so the branch logic
 *  has one origin and the log can never drift from the behaviour it describes.
 *  ("files" left the union at OPR.0.5.6.2: file-bearing events are now work, not noise.) */
export type IngestReason = "type" | "bot_id" | "subtype" | "no-user" | "empty-text";

export function ingestDecision(ev: SlackEvent): { ingest: true } | { ingest: false; reason: IngestReason } {
  const hasFiles = Array.isArray(ev.files) && ev.files.length > 0;
  if (ev.type !== "message" && ev.type !== "app_mention") return { ingest: false, reason: "type" };
  if (ev.bot_id) return { ingest: false, reason: "bot_id" }; // never ingest our own / any bot post
  // OPR.0.5.6.2: `file_share` WITH files is the human-upload shape and is admitted;
  // every other subtype (edits, joins, …) stays rejected exactly as before.
  if (ev.subtype && !(ev.subtype === "file_share" && hasFiles)) return { ingest: false, reason: "subtype" };
  if (!ev.user) return { ingest: false, reason: "no-user" };
  // A pure file drop has no caption: empty text is admissible iff files ride along.
  if ((!ev.text || !ev.text.trim()) && !hasFiles) return { ingest: false, reason: "empty-text" };
  return { ingest: true };
}

/** OPR.0.5.6.2 — the inbound file-transfer PORT: injected so this core stays
 *  pure/testable; the subsystem wires the real download+store implementation
 *  (see makeInboundFilePort). Results are per-file and NAMED both ways. */
export interface StoredInboundFile { name: string; localPath: string; mimetype?: string; bytes: number }
export interface FailedInboundFile { name: string; error: string }
export interface InboundFileResult { stored: StoredInboundFile[]; failed: FailedInboundFile[] }
export interface InboundFilePort { transfer(files: unknown[], eventTs: string): Promise<InboundFileResult> }

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
  queue: InboundQueuePort;
  seen: SeenStore;
  deadLetter: DeadLetterStore<SlackEvent>;
  destination: string; // first-class config; default operator-agent@kernel
  /** A6 v3 registration gate. Resolves ev.user -> a registered human (or refuses). Injected so
   *  this core stays pure/testable; the subsystem wires it via the daemon human-registry resolver. */
  resolveSender: (slackUserId: string) => InboundSenderResolution;
  /** S10 thread routing (deterministic, zero inference): resolve the destination + tags for an
   *  admitted event. Absent → every event lands on the static `destination` (the pre-routing
   *  shape, and the fallback the tests pin). */
  resolveRoute?: (ev: SlackEvent) => { destination: string; tags?: string[] };
  /** OPR.0.5.6.2 — inbound file transfer. Absent with a file-bearing event →
   *  every file is a NAMED failure on the row ("transfer unavailable"), never
   *  a silent drop of message or file. */
  files?: InboundFilePort;
  sourceLabel?: string;
  log?: (msg: string) => void;
}

export class InboundRouter {
  private readonly inflight = new Set<string>(); // same-ts double-dispatch guard (item 8)
  constructor(private readonly deps: InboundDeps) {}

  private summaryOf(ev: SlackEvent, transfer?: InboundFileResult | null): { summary: string; body: string } {
    const text = String(ev.text ?? "").slice(0, 1800);
    const meta = `slack channel=${ev.channel} user=${ev.user} ts=${ev.ts}`;
    // OPR.0.5.6.2 — attachments ride the row BODY by LOCAL path (Slack owns
    // nothing; the media file is OUR copy). Failures are per-file and named:
    // the message always survives a failed transfer.
    const sections: string[] = [text];
    if (transfer && (transfer.stored.length > 0 || transfer.failed.length > 0)) {
      const lines: string[] = [];
      if (transfer.stored.length > 0) {
        lines.push("Attachments (workspace-local copies):");
        for (const f of transfer.stored) {
          lines.push(`- ${f.localPath} (${f.name}${f.mimetype ? `, ${f.mimetype}` : ""}, ${f.bytes} bytes)`);
        }
      }
      for (const f of transfer.failed) {
        lines.push(`FILE TRANSFER FAILED: ${f.name} — ${f.error}`);
      }
      sections.push(lines.join("\n"));
    }
    const firstFileName = transfer?.stored[0]?.name ?? transfer?.failed[0]?.name;
    const headline = text.trim() ? text : firstFileName ? `[file] ${firstFileName}` : text;
    return {
      summary: `Founder via Slack: ${headline.slice(0, 90)}`,
      body: `${sections.filter((s) => s.length > 0).join("\n\n")}\n\n---\nSource: ${meta}\nRouted by openrig slack-inbound. Default destination per config; re-route via queue as needed.`,
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
      // OPR.0.5.6.2 — transfer the human's files BEFORE composing the row so the
      // row carries local paths (or named failures). A missing port is itself a
      // named per-file failure, never a silent drop.
      const fileMetas = Array.isArray(ev.files) ? ev.files : [];
      let transfer: InboundFileResult | null = null;
      if (fileMetas.length > 0) {
        transfer = this.deps.files
          ? await this.deps.files.transfer(fileMetas, ts)
          : {
              stored: [],
              failed: fileMetas.map((f, i) => {
                const m = (f ?? {}) as { name?: string; id?: string };
                return { name: String(m.name ?? m.id ?? `file-${i + 1}`), error: "file transfer unavailable (no file port wired)" };
              }),
            };
      }
      const { summary, body } = this.summaryOf(ev, transfer);
      // S10 — deterministic route (thread map) when wired; static destination otherwise.
      const route = this.deps.resolveRoute?.(ev) ?? { destination: this.deps.destination };
      let qitemId: string;
      try {
        qitemId = await this.deps.queue.createQitem({
          source: who.source, // the REGISTERED human's canonical ref (human-class), never a raw platform id
          destination: route.destination,
          priority: "routine",
          tags: route.tags ?? ["founder-slack", "inbound"],
          summary,
          body,
        });
      } catch (e) {
        this.deps.log?.(`qitem create failed ts=${ts}: ${(e as Error).message}`);
        return { landed: false, reason: "create_failed" };
      }
      this.deps.seen.mark(ts, "landed"); // durable qitem exists → safe to mark
      this.deps.log?.(`qitem ${qitemId} -> ${route.destination} (ts=${ts})`);
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
